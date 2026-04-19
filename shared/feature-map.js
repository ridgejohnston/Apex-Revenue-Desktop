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

const FEATURE_MAP = {
  free: {
    aiPrompts:    false,
    aiCoach:      false,
    voiceAlerts:  false,
    s3Backup:     false,
    obsStreaming: false,
    virtualCam:   false,
    cloudSync:    false,
    whaleAlerts:  false,
    beautyFilter: false,
  },
  platinum: {
    aiPrompts:    true,
    aiCoach:      true,
    voiceAlerts:  true,
    s3Backup:     true,
    obsStreaming: true,
    virtualCam:   true,
    cloudSync:    true,
    whaleAlerts:  true,
    beautyFilter: true,
  },
  // Agency (Tier 3) — an organization-level plan billed at 7.5% revenue
  // share. Agencies managing multiple models share the plan across their
  // roster; the higher rate vs Platinum (5%) reflects the extra support
  // and onboarding an agency relationship includes. Feature access
  // matches Platinum at a per-model level — the distinction between
  // Platinum and Agency is billing/organizational (handled on the
  // subscription backend: separate Stripe product + different rev-share
  // percentage), not feature gating at this layer. Both tiers include
  // unlimited broadcasting — see BROADCAST_POLICY in shared/apex-config.js.
  agency: {
    aiPrompts:    true,
    aiCoach:      true,
    voiceAlerts:  true,
    s3Backup:     true,
    obsStreaming: true,
    virtualCam:   true,
    cloudSync:    true,
    whaleAlerts:  true,
    beautyFilter: true,
  },
};

function hasFeature(plan, feature) {
  return FEATURE_MAP[plan]?.[feature] ?? false;
}

module.exports = { FEATURE_MAP, hasFeature };
