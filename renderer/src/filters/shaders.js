/**
 * Apex Revenue — Beauty Filter Shaders (WebGL2 / GLSL 300 es)
 *
 * Two-pass separable bilateral blur + final composite with tone curve.
 *
 * Why separable? A true 2D bilateral filter is O(r²) per pixel. At r=5 on
 * 1920×1080 @ 30fps that's 62 million samples/frame — fine on a GPU but
 * we also need headroom for streaming + the virtual camera. The separable
 * approximation (horizontal pass → vertical pass) drops cost to O(2r)
 * with barely-visible quality loss at the blur radii we use for skin.
 *
 * The bilateral kernel weights each sample by:
 *   spatial_weight * color_weight
 *   where spatial_weight = gauss(distance, sigma_spatial)
 *         color_weight   = gauss(luma_diff, sigma_color)
 *
 * This preserves hard edges (eye lines, nostrils, lips, hairline) while
 * smoothing gentle luminance variations (pores, texture, mild blemishes).
 */

// ─── Vertex: full-screen triangle ──────────────────────────
export const VERT_SRC = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  // Draw a single oversized triangle that covers the viewport.
  // Cheaper than a quad (2 tris) because the GPU only rasterizes
  // the visible portion.
  vec2 p = vec2((gl_VertexID == 2) ? 3.0 : -1.0,
                (gl_VertexID == 1) ? 3.0 : -1.0);
  v_uv = (p + 1.0) * 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

// ─── Fragment: separable bilateral pass ────────────────────
// Runs twice — once with u_direction=(1,0) for horizontal, once with
// u_direction=(0,1) for vertical. u_sigmaColor comes from the
// "smoothness" slider; higher values blend across larger luminance
// differences (stronger smoothing, risk of mushy edges).
export const FRAG_BILATERAL = `#version 300 es
precision highp float;

in  vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_tex;
uniform vec2  u_texel;      // (1/width, 1/height)
uniform vec2  u_direction;  // (1,0) or (0,1)
uniform float u_sigmaColor; // luminance tolerance (0.02 – 0.25)

const int   KERNEL_RADIUS = 5;
const float SIGMA_SPATIAL = 3.0;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec3  center  = texture(u_tex, v_uv).rgb;
  float cLuma   = luma(center);

  vec3  accum   = vec3(0.0);
  float wsum    = 0.0;

  // Precompute the spatial-weight denominator once
  float ssInv2  = 1.0 / (2.0 * SIGMA_SPATIAL * SIGMA_SPATIAL);
  float scInv2  = 1.0 / (2.0 * u_sigmaColor * u_sigmaColor);

  for (int i = -KERNEL_RADIUS; i <= KERNEL_RADIUS; i++) {
    float fi     = float(i);
    vec2  offset = u_direction * u_texel * fi;
    vec3  sampl  = texture(u_tex, v_uv + offset).rgb;

    float spatialW = exp(-(fi * fi) * ssInv2);
    float colorD   = luma(sampl) - cLuma;
    float colorW   = exp(-(colorD * colorD) * scInv2);
    float w        = spatialW * colorW;

    accum += sampl * w;
    wsum  += w;
  }

  outColor = vec4(accum / wsum, 1.0);
}
`;

// ─── Fragment: Gaussian blur (separable) ──────────────────
// Used to blur the BACKGROUND when background-blur mode is active.
// Distinct from the bilateral filter: no edge preservation, much
// stronger kernel — we want a genuine out-of-focus "bokeh" look on
// whatever's behind the person, not careful feature preservation.
//
// Runs twice per frame (when bg blur is on): once horizontal on the
// original video frame, once vertical on the intermediate result.
// The resulting texture is sampled in FRAG_COMPOSITE and mixed with
// the beauty-processed foreground based on the segmentation mask.
export const FRAG_GAUSSIAN_BLUR = `#version 300 es
precision highp float;

in  vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_tex;
uniform vec2      u_texel;      // (1/width, 1/height)
uniform vec2      u_direction;  // (1,0) or (0,1)
uniform float     u_strength;   // 0..1 — scales kernel spread for adjustable blur

const int KERNEL_RADIUS = 12;

void main() {
  // Kernel radius scales with strength so the user slider maps to a
  // continuous blur intensity rather than a binary on/off
  float spread = 1.0 + u_strength * 3.0; // 1..4 pixel multiplier
  float sigma  = 6.0 * spread;
  float sInv2  = 1.0 / (2.0 * sigma * sigma);

  vec3  accum = vec3(0.0);
  float wsum  = 0.0;

  for (int i = -KERNEL_RADIUS; i <= KERNEL_RADIUS; i++) {
    float fi     = float(i) * spread;
    vec2  offset = u_direction * u_texel * fi;
    float w      = exp(-(fi * fi) * sInv2);
    accum += texture(u_tex, v_uv + offset).rgb * w;
    wsum  += w;
  }

  outColor = vec4(accum / wsum, 1.0);
}
`;

// ─── Fragment: final composite ─────────────────────────────
// Runs a pipeline of image-processing stages on the bilateral-blurred
// frame + original frame. Every stage is additive math against the
// incoming `color` vec3, so each slider can be set to its neutral
// value (0 or 1 depending on stage) to pass through untouched.
//
// Stage order matters:
//   1. Beauty blend         — establish the base color (smoothed ↔ original)
//   2. Sharpness            — add back high-frequency detail from
//                             the `original - smoothed` difference
//   3. Low-light boost      — gamma-lift shadows BEFORE contrast, so
//                             contrast operates on lifted values
//   4. Contrast             — pivot around 0.5 luma
//   5. Saturation           — desaturate / supersaturate
//   6. Warmth               — R/B tonal shift
//   7. Brightness           — additive offset
//   8. Radial light         — single slider: negative → vignette
//                             (darken corners), positive → virtual
//                             key light (lift center). Approximates
//                             NVIDIA Broadcast's Key Light + Vignette.
export const FRAG_COMPOSITE = `#version 300 es
precision highp float;

in  vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_original;
uniform sampler2D u_smoothed;
uniform sampler2D u_bgBlurred;  // Gaussian-blurred original frame (bg blur mode)
uniform sampler2D u_mask;       // Segmentation mask: R=person weight (0..1)
uniform float     u_intensity;   // 0..1 — beauty blend factor
uniform float     u_warmth;      // -1..+1 — red/blue tonal shift
uniform float     u_brightness;  // -1..+1 — additive offset
uniform float     u_sharpness;   // 0..1 — unsharp mask strength
uniform float     u_contrast;    // -1..+1 — stretch / flatten around 0.5
uniform float     u_saturation;  // -1..+1 — mix toward/away from grayscale
uniform float     u_lowLight;    // 0..1 — shadow lift via gamma<1
uniform float     u_radial;      // -1..+1 — vignette / key light
uniform float     u_aspect;      // width / height for circular radial math
uniform int       u_bgMode;      // 0=off, 1=blur, 2=color
uniform vec3      u_bgColor;     // replacement color when u_bgMode == 2
uniform float     u_maskFeather; // 0..1 — soften mask edges (default 0.15)

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

void main() {
  vec3 original = texture(u_original, v_uv).rgb;
  vec3 smoothed = texture(u_smoothed, v_uv).rgb;

  // 1. Beauty blend — mix toward the bilateral-smoothed version
  vec3 color = mix(original, smoothed, u_intensity);

  // 2. Sharpness — unsharp mask. (original - smoothed) is the high-frequency
  //    content that the bilateral pass removed. Adding a scaled version back
  //    restores detail (eye/lip crispness) without undoing the smoothing
  //    on low-frequency areas (cheeks, forehead).
  vec3 highFreq = original - smoothed;
  color += highFreq * u_sharpness * 1.5;

  // 3. Low-light boost — gamma 1.0 → 0.5 as slider goes 0 → 1.
  //    Lifts shadow detail without blowing out highlights. Directly
  //    addresses the #1 cam-model complaint (under-lit rooms).
  float gamma = 1.0 - u_lowLight * 0.5;
  color = pow(max(color, vec3(0.0)), vec3(gamma));

  // 4. Contrast — pivot around 0.5 luma midpoint. +1 doubles contrast,
  //    -1 flattens to flat-gray. Neutral at 0.
  color = (color - 0.5) * (1.0 + u_contrast) + 0.5;

  // 5. Saturation — mix between luma-only (grayscale) and full color.
  //    -1 → grayscale, 0 → neutral, +1 → saturation +100%.
  float luma = dot(color, LUMA);
  color = mix(vec3(luma), color, 1.0 + u_saturation);

  // 6. Warmth — subtle R/B shift
  color.r += u_warmth * 0.08;
  color.b -= u_warmth * 0.08;

  // 7. Brightness — simple additive
  color += u_brightness * 0.15;

  // 8. Radial light — aspect-corrected distance from center, smooth-stepped
  //    so the transition isn't hard-edged. Negative slider darkens corners
  //    (classic vignette); positive lifts center (virtual key light).
  vec2 toCenter = (v_uv - 0.5) * vec2(u_aspect, 1.0);
  float dist    = length(toCenter);
  float radial  = smoothstep(0.15, 0.85, dist); // 0 at center → 1 at corners

  float lightFactor;
  if (u_radial < 0.0) {
    // Vignette: corners get multiplied by (1 + u_radial * 0.8), which is <1
    lightFactor = mix(1.0, 1.0 + u_radial * 0.8, radial);
  } else {
    // Key light: center gets multiplied by (1 + u_radial * 0.4), falls off
    lightFactor = mix(1.0 + u_radial * 0.4, 1.0, radial);
  }
  color *= lightFactor;

  // 9. Background composite — uses MediaPipe Selfie Segmentation mask to
  //    isolate the person and substitute blur / color for the background.
  //    The mask is a soft confidence map (0 = definite bg, 1 = definite
  //    person) so edges feather naturally. When u_bgMode == 0 this stage
  //    is skipped entirely.
  if (u_bgMode != 0) {
    // Slight remap tightens the feather zone — without this, MediaPipe's
    // low-confidence band (≈0.2–0.5 around hair/shoulders) leaves a halo
    // of the original bg around the subject.
    float raw = texture(u_mask, v_uv).r;
    float f   = max(u_maskFeather, 0.01);
    float personW = smoothstep(0.5 - f, 0.5 + f, raw);

    vec3 bgSource;
    if (u_bgMode == 1) {
      bgSource = texture(u_bgBlurred, v_uv).rgb;
    } else {
      bgSource = u_bgColor;
    }
    color = mix(bgSource, color, personW);
  }

  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;
