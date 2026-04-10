// ── Apex Revenue Desktop — billing-manager.js (Electron adaptation) ──────────
var APEX_SUBSCRIPTION_KEY  = 'apexSubscription';
var APEX_SUB_VERIFIED_KEY  = 'apexSubVerified';
var APEX_SUB_CHECKED_AT    = 'apexSubCheckedAt';

var billingState = {
  plan: 'free', subscription: null, features: [], featureMap: {},
  verified: false, reason: null, loaded: false, gateActive: true,
};

async function billingVerifySubscription(forceRefresh) {
  if (billingState.loaded && !forceRefresh) return billingState;
  try {
    var data = await apexApiFetch('/check-subscription', { method: 'POST', body: JSON.stringify({}) });
    billingState.plan         = data.plan || 'free';
    billingState.subscription = data.subscription || null;
    billingState.features     = data.features || [];
    billingState.featureMap   = data.feature_map || {};
    billingState.verified     = data.verified === true;
    billingState.reason       = data.reason || null;
    billingState.loaded       = true;
    billingState.gateActive   = !(billingState.plan === 'platinum' && billingState.verified && billingState.subscription);
    if (window.electronAPI) {
      await window.electronAPI.store.set(APEX_SUBSCRIPTION_KEY, {
        plan: billingState.plan, subscription: billingState.subscription,
        verified: billingState.verified, reason: billingState.reason, gateActive: billingState.gateActive,
      });
      await window.electronAPI.store.set(APEX_SUB_VERIFIED_KEY, billingState.verified);
      await window.electronAPI.store.set(APEX_SUB_CHECKED_AT, Date.now());
    }
    return billingState;
  } catch(e) {
    if (window.electronAPI) {
      var cached    = await window.electronAPI.store.get(APEX_SUBSCRIPTION_KEY);
      var checkedAt = await window.electronAPI.store.get(APEX_SUB_CHECKED_AT) || 0;
      if (cached && (Date.now() - checkedAt) < 3600000 && cached.verified) {
        Object.assign(billingState, cached, { loaded: true });
      } else {
        Object.assign(billingState, { plan:'free', subscription:null, verified:false, gateActive:true, loaded:true });
      }
    }
    return billingState;
  }
}

function billingIsGated()    { return billingState.gateActive; }
function billingGetPlan()    { return billingState.plan || 'free'; }
function billingIsPlatinum() { return billingState.plan === 'platinum' && billingState.verified && !billingState.gateActive; }
function billingCanUse(key)  {
  if (billingState.gateActive) return false;
  var v = billingState.featureMap[key];
  return v ? ['true','unlimited','advanced','premium','full'].includes(v) : billingState.features.includes(key);
}
