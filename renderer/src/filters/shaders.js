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
uniform int       u_bgMode;      // 0=off, 1=blur, 2=color, 3=gradient
uniform vec3      u_bgColor;     // replacement color when u_bgMode == 2
// Gradient slots A..E as vec4(r, g, b, active). active ∈ {0.0, 1.0}.
// Packing color + active-flag into one vec4 lets us ship all 5 slots
// in a single uniform4fv call (20 floats), and makes the shader's
// loop cleaner — no parallel arrays of colors and booleans to keep
// in sync. The slot's anchor position along the gradient axis is
// fixed (A=0.0, B=0.25, C=0.5, D=0.75, E=1.0) so an inactive slot
// in the middle just gets skipped, and the neighboring active slots
// remain at their original positions ("natural fade": A gets more
// space when later slots are empty).
uniform vec4      u_bgGradSlots[5];
uniform int       u_bgGradStyle; // 0..7 — gradient pattern style
uniform float     u_maskFeather; // 0..1 — soften mask edges (default 0.15)

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// ─── Gradient pattern generator ──────────────────────────────────────
// Returns an interpolation parameter t in [0,1] for each pixel,
// which is then used with mix(u_bgGradA, u_bgGradB, t) to produce
// the final bg color. Each style is a different spatial function
// of the UV coords.
//
// Aspect correction: for circular / square / tie-dye patterns we
// use aspect-corrected centered coords so the pattern stays visually
// round/square regardless of the webcam's native 16:9 or 4:3 ratio.
// For linear gradients (vertical/horizontal/diagonal) and waves we
// use raw UV — a 'horizontal' gradient should fill the full width
// edge to edge, aspect-independent.
float gradientT(vec2 uv, int style, float aspect) {
  // Aspect-corrected centered coords for radially-symmetric patterns
  vec2 cc = (uv - 0.5) * vec2(aspect, 1.0);

  if (style == 0) {
    // 0 — Vertical (top → bottom). UV origin is bottom-left in GL,
    // so "top of screen" is v=1. We want A at top, B at bottom, so
    // t is maximum (1) at the bottom. That puts B at the bottom.
    // Invert if you'd prefer the opposite: most UIs show the first
    // stop at the top of a vertical gradient, which is what this does.
    return 1.0 - uv.y;
  } else if (style == 1) {
    // 1 — Horizontal (left → right). A on left, B on right.
    return uv.x;
  } else if (style == 2) {
    // 2 — Diagonal ↘ (top-left → bottom-right). Average of horizontal
    // and "1 - vertical". No aspect correction — a diagonal should
    // span corner to corner regardless of aspect.
    return (uv.x + (1.0 - uv.y)) * 0.5;
  } else if (style == 3) {
    // 3 — Diagonal ↙ (top-right → bottom-left).
    return ((1.0 - uv.x) + (1.0 - uv.y)) * 0.5;
  } else if (style == 4) {
    // 4 — Circular (center → edge). Aspect-corrected so it's actually
    // round, not elliptical. Normalized by sqrt(0.5² + 0.5²) ≈ 0.707
    // so the corners reach t = 1.0 exactly.
    return clamp(length(cc) / 0.7071, 0.0, 1.0);
  } else if (style == 5) {
    // 5 — Tie-dye (swirled organic). Polar coords with a swirl term
    // that bends the radial gradient around the center. No noise
    // texture needed — just angle + radius arithmetic produces
    // a pleasing psychedelic swirl.
    float r = length(cc);
    float a = atan(cc.y, cc.x);
    // The 3.0 multiplier on radius creates bands; the 6.0 swirl
    // factor adds rotation that varies with radius (further from
    // center = more rotation).
    float swirl = sin(a * 5.0 + r * 8.0) * 0.5 + 0.5;
    // Mix the swirl with a radial base so the overall gradient still
    // reads A→B even at a glance, with the swirl adding character.
    return clamp(mix(r * 1.4, swirl, 0.55), 0.0, 1.0);
  } else if (style == 6) {
    // 6 — Square (concentric squares, center → edge). Use Chebyshev
    // distance (max of abs components) instead of Euclidean length.
    // Aspect-corrected so it's an actual square.
    float d = max(abs(cc.x), abs(cc.y));
    // Normalize by max possible Chebyshev distance (0.5 on long axis)
    return clamp(d / 0.5, 0.0, 1.0);
  } else if (style == 7) {
    // 7 — Waves (sinusoidal horizontal bands). Base vertical position
    // plus a horizontal sine distortion creates a liquid-band feel.
    // No aspect correction — bands should span full width.
    float base = uv.y;
    float wave = sin(uv.x * 6.283 * 1.5) * 0.08; // ~1.5 waves across width
    return clamp(base + wave, 0.0, 1.0);
  }
  // Fallback — flat A color if unknown style
  return 0.0;
}

// ─── Multi-stop gradient sampler ─────────────────────────────────────
// Given a parametric position t ∈ [0,1] along the gradient axis and
// the 5 slot entries (color + active flag), return the interpolated
// RGB color with "natural fade" semantics:
//
//   Each slot has a fixed anchor position: A=0.0, B=0.25, C=0.5,
//   D=0.75, E=1.0. An inactive slot (alpha == 0) is dropped from
//   the interpolation. The remaining active slots keep their original
//   anchor positions, so when later slots are inactive the last
//   active color holds steady across the remainder of the axis.
//
// Example: A=red, B=blue, C/D/E=none.
//   t=0.0  → red
//   t=0.1  → ~80% red / 20% blue (lerp A→B on the 0..0.25 segment)
//   t=0.25 → blue
//   t=0.5  → blue (no later active slot to interpolate into)
//   t=1.0  → blue
// This is the "A gets more space, E less (natural fade)" UX that
// makes early-slot colors dominant when later slots are empty.
//
// Algorithm: walk the 5 slots in order; track the last active slot
// as the "previous" anchor. At each active slot, if t falls between
// the previous anchor and this one, lerp between them and return.
// After the loop, t was past the last active slot, so return that
// slot's color unchanged.
//
// A pathological case: zero active slots. Shouldn't happen in normal
// use because the UI prevents disabling the last slot, but we guard
// by returning the single-color u_bgColor — a reasonable fallback
// color to substitute any nearby visual hole.
vec3 sampleGradient(float t) {
  // Fixed anchor positions matching the slot layout.
  float anchors[5] = float[5](0.0, 0.25, 0.5, 0.75, 1.0);

  bool  havePrev   = false;
  float prevAnchor = 0.0;
  vec3  prevColor  = vec3(0.0);

  // Cache the very first active color so we can return it if t falls
  // before the first active anchor (only relevant when slot A itself
  // is inactive — unusual, but valid).
  bool  haveFirst  = false;
  vec3  firstColor = vec3(0.0);

  for (int i = 0; i < 5; i++) {
    vec4 slot = u_bgGradSlots[i];
    // 'isActive' not 'active' — 'active' is a GLSL reserved word (used
    // for subroutine qualifiers in desktop GLSL 4.x, reserved across
    // all GLSL ES versions). Chromium ANGLE's shader validator rejects
    // it, which causes the whole FRAG_COMPOSITE program to fail to
    // compile — and since this is the final pass of the pipeline,
    // a link failure takes down ALL filters (beauty, color, lighting,
    // bg effects). That regression shipped in v3.4.9 when the 5-slot
    // gradient was added; fixed in v3.4.14.
    bool isActive = slot.a > 0.5;
    if (!isActive) continue;

    vec3 col = slot.rgb;
    float a  = anchors[i];

    if (!haveFirst) {
      haveFirst  = true;
      firstColor = col;
    }

    if (havePrev && t <= a) {
      // t is inside (prevAnchor..a], lerp previous → this
      float span = max(a - prevAnchor, 1e-6);
      float u = clamp((t - prevAnchor) / span, 0.0, 1.0);
      return mix(prevColor, col, u);
    }
    havePrev   = true;
    prevAnchor = a;
    prevColor  = col;
  }

  // Exited the loop without returning. Either:
  //   (a) no active slots at all → fall back to u_bgColor
  //   (b) t is past the last active anchor → hold the last color
  //   (c) t is before the first active anchor → hold the first color
  if (!haveFirst) return u_bgColor;
  if (t < anchors[0] && haveFirst) return firstColor; // dead branch on normal paths; kept for safety
  return prevColor;
}

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
  //    isolate the person and substitute blur / color / gradient for the
  //    background. The mask is a soft confidence map (0 = definite bg,
  //    1 = definite person) so edges feather naturally. When u_bgMode
  //    == 0 this stage is skipped entirely.
  if (u_bgMode != 0) {
    // Read mask confidence at this pixel. MediaPipe selfie_segmenter's
    // confidence distribution is biased:
    //   • Background: confidence ≈ 0.00..0.15 (tight, most bg pixels)
    //   • Transition (hair/fabric/shoulder edges): ≈ 0.15..0.60
    //   • Solid person (torso, cheeks): ≈ 0.70..1.00
    // The PREVIOUS smoothstep centered at 0.5 put the decision boundary
    // inside the transition zone, so edge pixels with confidence 0.3–0.5
    // composed as ~50% background. Result: small "holes" in the person
    // silhouette where the real bg peeked through, especially on moving
    // arms/shoulders. Dropping the center to 0.38 pulls the decision
    // boundary AWAY from solid-person confidence and INTO the low-end
    // transition zone, keeping edge pixels as "person" where they
    // belong — no more holes at the silhouette.
    //
    // MOTION TRACKING via MASK DILATION:
    // MediaPipe inference runs ~40-60ms behind the current video frame,
    // so when the subject moves fast the mask lags — the bg replacement
    // shows trailing color behind the "old" silhouette. To make the bg
    // appear to follow the subject twice as responsively, we dilate the
    // person region by sampling a 4-point cross around the center pixel
    // and taking the MAX confidence value. Where ANY neighbor reads as
    // person, the center also reads as person. Effect: the silhouette
    // boundary grows outward by the sample offset — so during motion,
    // the new subject position already sits within the "expanded" mask
    // from the stale inference result. The visible edge tracks the
    // subject much closer than a pure per-pixel sample would.
    //
    // The offset is measured in UV space, computed from the actual mask
    // texture dimensions via textureSize() so it works regardless of
    // whether the mask is 256x144 or 384x216 (cheaper inference paths).
    // 3 texels outward across a cross pattern is the sweet spot: large
    // enough to cover typical streaming motion between inference
    // frames, small enough that the person silhouette doesn't balloon
    // noticeably on static frames.
    vec2 maskTexel = 1.0 / vec2(textureSize(u_mask, 0));
    vec2 dilate   = maskTexel * 3.0;
    float m0 = texture(u_mask, v_uv).r;
    float m1 = texture(u_mask, v_uv + vec2( dilate.x, 0.0)).r;
    float m2 = texture(u_mask, v_uv + vec2(-dilate.x, 0.0)).r;
    float m3 = texture(u_mask, v_uv + vec2(0.0,  dilate.y)).r;
    float m4 = texture(u_mask, v_uv + vec2(0.0, -dilate.y)).r;
    float raw = max(m0, max(max(m1, m2), max(m3, m4)));
    float f   = max(u_maskFeather, 0.01);
    float center = 0.38;
    float personW = smoothstep(center - f, center + f, raw);

    vec3 bgSource;
    if (u_bgMode == 1) {
      bgSource = texture(u_bgBlurred, v_uv).rgb;
    } else if (u_bgMode == 2) {
      bgSource = u_bgColor;
    } else {
      // u_bgMode == 3 — gradient. Compute per-pixel spatial parameter
      // from the chosen style, then look up the color across up to 5
      // stops with natural-fade handling of inactive slots.
      float t = gradientT(v_uv, u_bgGradStyle, u_aspect);
      bgSource = sampleGradient(t);
    }
    color = mix(bgSource, color, personW);
  }

  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;
