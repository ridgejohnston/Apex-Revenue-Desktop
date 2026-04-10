// ── Apex Revenue Desktop — earnings-tracker.js (Electron adaptation) ─────────
// Tracks session earnings, persists via electronAPI.store, syncs to API.
// Uses electronAPI.store instead of chrome.storage.local.

var APEX_EARNINGS_KEY     = 'apexCurrentSessionEarnings';
var APEX_EARNINGS_QUEUE   = 'apexEarningsSyncQueue';
var APEX_EARNINGS_HISTORY = 'apexLocalEarningsCache';

var earningsSession = {
  platform: 'chaturbate', username: '', sessionStart: null, lastUpdate: null,
  totalTokens: 0, totalTips: 0, uniqueTippers: 0, peakViewers: 0,
  avgViewers: 0, viewerSamples: [], convRate: 0, tokensPerHr: 0,
  avgTipSize: 0, largestTip: 0, whaleCount: 0, topTippers: [],
  hourlyBreakdown: [], _hourBuckets: {}, _started: false,
};

function earningsStartSession(platform, username) {
  Object.assign(earningsSession, {
    platform: platform || 'chaturbate', username: username || '',
    sessionStart: new Date().toISOString(), lastUpdate: Date.now(),
    totalTokens: 0, totalTips: 0, uniqueTippers: 0, peakViewers: 0,
    avgViewers: 0, viewerSamples: [], convRate: 0, tokensPerHr: 0,
    avgTipSize: 0, largestTip: 0, whaleCount: 0, topTippers: [],
    hourlyBreakdown: [], _hourBuckets: {}, _started: true,
  });
  earningsSaveLocal();
}

function earningsProcessUpdate(data) {
  if (!earningsSession._started) earningsStartSession(earningsSession.platform, data.username || '');
  if (data.username && !earningsSession.username) earningsSession.username = data.username;
  earningsSession.lastUpdate = Date.now();
  earningsSession.totalTokens = data.totalTips || 0;
  earningsSession.tokensPerHr  = data.tokensPerHour || 0;
  earningsSession.convRate      = parseFloat(data.convRate) || 0;

  var viewers = data.viewers || 0;
  if (viewers > earningsSession.peakViewers) earningsSession.peakViewers = viewers;
  earningsSession.viewerSamples.push(viewers);
  if (earningsSession.viewerSamples.length > 0) {
    earningsSession.avgViewers = Math.round(
      earningsSession.viewerSamples.reduce(function(a,b){return a+b;},0) / earningsSession.viewerSamples.length
    );
  }

  var fans = data.fans || [];
  earningsSession.uniqueTippers = fans.filter(function(f){return f.tips>0;}).length;
  earningsSession.totalTips     = (data.tipEvents || []).length;
  var amounts = (data.tipEvents || []).map(function(e){return e.amount;});
  if (amounts.length) {
    earningsSession.avgTipSize = Math.round(amounts.reduce(function(a,b){return a+b;},0)/amounts.length);
    earningsSession.largestTip = Math.max.apply(null, amounts);
  }
  earningsSession.whaleCount = (data.whales || []).filter(function(w){return w.present;}).length;
  earningsSession.topTippers = fans.filter(function(f){return f.tips>0;}).sort(function(a,b){return b.tips-a.tips;}).slice(0,10);
  earningsSaveLocal();
}

async function earningsSaveLocal() {
  if (window.electronAPI) {
    await window.electronAPI.store.set(APEX_EARNINGS_KEY, earningsSession);
  }
}

async function earningsGetHistory() {
  if (window.electronAPI) {
    return await window.electronAPI.store.get(APEX_EARNINGS_HISTORY) || {};
  }
  return {};
}
