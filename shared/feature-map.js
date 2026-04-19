/**
 * Apex Revenue — Feature Map (renderer-safe)
 *
 * The FEATURE_MAP + hasFeature() check extracted from billing-manager.js
 * into a pure-data module so the renderer can import it without pulling
 * in Node-only dependencies (https, aws-sdk, etc.) that the Cognito
 * subscription-check code in billing-manager needs.
 *
 * Why this split exists:
 *   Webpack 5 is strict about resolving all transitive requires when
 *   bundling for the browser target. billing-manager.js does
 *   require('https') at the top for its callCheckSubscription helper,
 *   which is a main-process-only function. As soon as the renderer
 *   imports *any* symbol from billing-manager, webpack tries to bundle
 *   the whole file and errors on the https resolution.
 *
 *   Hoisting the pure, browser-safe portion into this module is cleaner
 *   than a webpack fallback ({ https: false }) because the fallback
 *   masks the problem — it would silently no-op the https module,
 *   which is a footgun if this code ever gets re-imported into a
 *   context where https really is needed.
 *
 * billing-manager.js re-exports FEATURE_MAP + hasFeature from here so
 * the two-file split is invisible to existing main-process callers.
 */

// ─── Feature map ─────────────────────────────────────────────────────────
//
// Three-tier feature matrix:
//
//   Free:     No paid features. All locked-feature surfaces show a
//             semi-transparent upsell overlay directing the user to
//             subscribe. This is the experience that converts Free users
//             into paid subscribers, so "Free" doesn't mean "nothing" —
//             it means "everything is visible, but gated with upsell."
//
//   Platinum: 5% revenue share (Tier 2). Full core product:
//             AI Prompts, Analytics, OBS streaming, Stream Filters
//             (manual sliders for smoothness/warmth/lighting),
//             Camera View Control (scene switching, positioning),
//             Multi-Stream (record while streaming, stream while
//             recording), Multi-Camera Broadcast (simulcast to multiple
//             RTMP destinations), Browser Extension Integration (Apex
//             Revenue Chrome extension signals), AI Filters (Auto-Beauty
//             via Bedrock Haiku vision analysis of the live frame).
//
//   Agency:   7.5% revenue share (Tier 3). Platinum + AI Coach —
//             the multi-turn conversational advisor backed by Bedrock
//             and the self-training research/knowledge system. Agency
//             is the tier that unlocks the highest-tier AI feature
//             because it's the feature agencies value most for
//             training/developing their model roster.
//
// Both Platinum and Agency include unlimited broadcasting; see
// BROADCAST_POLICY in shared/apex-config.js.
//
// Key convention: camelCase feature keys match the in-app UI language.
// Callers should use hasFeature(plan, 'keyName') rather than inspecting
// FEATURE_MAP directly, so this file can evolve without callers needing
// to know about new tiers.

const FEATURE_MAP = {
  free: {
    // Nothing is unlocked. Free users see the full UI with locked
    // surfaces overlaid by a semi-transparent upsell CTA. The
    // overlay is not encoded here — UI components check
    // hasFeature() and render the overlay when the result is false.
    aiPrompts:          false,
    analytics:          false,
    obsStreaming:       false,
    streamFilters:      false,
    cameraViewControl:  false,
    multiStream:        false,
    multiCameraBroadcast: false,
    browserExtension:   false,
    aiFilters:          false,
    aiCoach:            false,

    // Legacy keys — no current callers, retained for any latent
    // consumer that might re-import this module. Treated as the
    // same state as the new keys they're a subset of (e.g.
    // `voiceAlerts` was historically part of the AI prompt surface;
    // `whaleAlerts` is a subset of analytics; `beautyFilter`
    // predates the streamFilters/aiFilters split). Free = off.
    voiceAlerts:        false,
    s3Backup:           false,
    virtualCam:         false,
    cloudSync:          false,
    whaleAlerts:        false,
    beautyFilter:       false,
  },
  platinum: {
    // Platinum (Tier 2) — 5% revenue share. All core product
    // features unlocked EXCEPT AI Coach, which is Agency-only.
    aiPrompts:          true,
    analytics:          true,
    obsStreaming:       true,
    streamFilters:      true,   // manual beauty-filter sliders
    cameraViewControl:  true,
    multiStream:        true,
    multiCameraBroadcast: true,
    browserExtension:   true,
    aiFilters:          true,   // Auto-Beauty (Bedrock Haiku vision)
    aiCoach:            false,  // ← Agency-only

    // Legacy keys — on for Platinum, consistent with historical
    // behavior. voiceAlerts rides along with aiPrompts; s3Backup,
    // virtualCam, cloudSync, whaleAlerts are all part of the
    // platinum core; beautyFilter is the former name for what's
    // now streamFilters + aiFilters combined.
    voiceAlerts:        true,
    s3Backup:           true,
    virtualCam:         true,
    cloudSync:          true,
    whaleAlerts:        true,
    beautyFilter:       true,
  },
  agency: {
    // Agency (Tier 3) — 7.5% revenue share. Platinum + AI Coach.
    // Organization-level plan. Agencies managing multiple models
    // share the plan across their roster; the higher rate vs
    // Platinum reflects the extra support, onboarding, and the
    // unlocked AI Coach advisor that agencies specifically use
    // to train and develop their roster.
    aiPrompts:          true,
    analytics:          true,
    obsStreaming:       true,
    streamFilters:      true,
    cameraViewControl:  true,
    multiStream:        true,
    multiCameraBroadcast: true,
    browserExtension:   true,
    aiFilters:          true,
    aiCoach:            true,   // ← Agency-only feature

    // Legacy keys — all on for Agency.
    voiceAlerts:        true,
    s3Backup:           true,
    virtualCam:         true,
    cloudSync:          true,
    whaleAlerts:        true,
    beautyFilter:       true,
  },
};

function hasFeature(plan, feature) {
  return FEATURE_MAP[plan]?.[feature] ?? false;
}

module.exports = { FEATURE_MAP, hasFeature };
