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

// ─── Fragment: final composite ─────────────────────────────
// Samples both the original frame and the bilateral-blurred frame,
// lerps between them based on intensity, then applies a simple tone
// curve for warmth (red/blue shift) and brightness.
export const FRAG_COMPOSITE = `#version 300 es
precision highp float;

in  vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_original;
uniform sampler2D u_smoothed;
uniform float     u_intensity;   // 0..1 — blend factor
uniform float     u_warmth;      // -1..+1 — red/blue tonal shift
uniform float     u_brightness;  // -1..+1 — additive offset

void main() {
  vec3 original = texture(u_original, v_uv).rgb;
  vec3 smoothed = texture(u_smoothed, v_uv).rgb;

  // Cross-fade original ↔ smoothed by intensity
  vec3 color = mix(original, smoothed, u_intensity);

  // Warmth: +1 pushes red up, blue down; -1 the opposite.
  // Scaled down so the effect stays subtle at slider extremes.
  color.r += u_warmth * 0.08;
  color.b -= u_warmth * 0.08;

  // Brightness: simple additive, clamped.
  color += u_brightness * 0.15;

  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;
