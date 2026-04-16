/**
 * Apex Revenue — App-level constants
 */

module.exports = {
  APP_NAME: 'Apex Revenue',
  EXTENSION_ID: 'desktop',
  VERSION: '3.0.8',
  DEFAULT_PLATFORMS: {
    'Live Cams': [
      { name: 'Chaturbate',  url: 'https://chaturbate.com/',       tracked: true,  icon: '🔥' },
      { name: 'Stripchat',   url: 'https://stripchat.com/',        tracked: true,  icon: '💎' },
      { name: 'MyFreeCams',  url: 'https://www.myfreecams.com/',   tracked: true,  icon: '🌟' },
      { name: 'xTease',      url: 'https://xtease.com/',           tracked: true,  icon: '⚡' },
      { name: 'CamSoda',     url: 'https://www.camsoda.com/',      tracked: false, icon: '🎥' },
      { name: 'Flirt4Free',  url: 'https://www.flirt4free.com/',   tracked: false, icon: '💬' },
      { name: 'LiveJasmin',  url: 'https://www.livejasmin.com/',   tracked: false, icon: '🌹' },
      { name: 'BongaCams',   url: 'https://bongacams.com/',        tracked: false, icon: '🎤' },
      { name: 'Cam4',        url: 'https://www.cam4.com/',         tracked: false, icon: '4️⃣' },
      { name: 'ImLive',      url: 'https://www.imlive.com/',       tracked: false, icon: '👁️' },
      { name: 'Streamate',   url: 'https://www.streamate.com/',    tracked: false, icon: '📡' },
    ],
    'Fan Sites': [
      { name: 'OnlyFans',   url: 'https://onlyfans.com/',   icon: '🅾️' },
      { name: 'Fansly',     url: 'https://fansly.com/',     icon: '💙' },
      { name: 'ManyVids',   url: 'https://www.manyvids.com/', icon: '🎬' },
      { name: 'Fanvue',     url: 'https://fanvue.com/',     icon: '👀' },
      { name: 'Patreon',    url: 'https://www.patreon.com/', icon: '🎨' },
      { name: 'LoyalFans',  url: 'https://www.loyalfans.com/', icon: '❤️' },
    ],
    'Clip Stores': [
      { name: 'Clips4Sale',  url: 'https://www.clips4sale.com/',  icon: '🎞️' },
      { name: 'iWantClips',  url: 'https://iwantclips.com/',      icon: '🛒' },
      { name: 'Modelhub',    url: 'https://www.modelhub.com/',    icon: '📦' },
      { name: 'NiteFlirt',   url: 'https://www.niteflirt.com/',   icon: '📞' },
    ],
  },
  WHALE_TIERS: {
    TIER_1: { min: 200, label: 'Whale',       color: '#FFD700', emoji: '🐋' },
    TIER_2: { min: 50,  label: 'Big Tipper',  color: '#C0C0C0', emoji: '🐬' },
    TIER_3: { min: 10,  label: 'Tipper',      color: '#CD7F32', emoji: '🐟' },
    TIER_4: { min: 0,   label: 'Viewer',      color: '#666',    emoji: '👤' },
  },
  AI_TRIGGERS: {
    DEAD_AIR:      { key: 'dead_air',      cooldownMs: 180000, label: 'Dead Air' },
    VIEWER_SURGE:  { key: 'viewer_surge',  cooldownMs: 300000, label: 'Viewer Surge' },
    WHALE_PRESENT: { key: 'whale_present', cooldownMs: 120000, label: 'Whale Alert' },
    HOT_STREAK:    { key: 'hot_streak',    cooldownMs: 300000, label: 'Hot Streak' },
  },
};
