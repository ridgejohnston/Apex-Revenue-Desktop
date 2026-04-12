/**
 * Apex Revenue — Subscription & Billing Manager
 */

const https = require('https');
const { API_ENDPOINT } = require('./aws-config');

async function checkSubscription(idToken) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${API_ENDPOINT}/check-subscription`);
    const options = {
      method: 'GET',
      headers: { Authorization: `Bearer ${idToken}` },
    };
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ plan: 'free' }); }
      });
    });
    req.on('error', () => resolve({ plan: 'free' }));
    req.end();
  });
}

const FEATURE_MAP = {
  free:     { aiPrompts: false, voiceAlerts: false, s3Backup: false, obsStreaming: false, virtualCam: false },
  platinum: { aiPrompts: true,  voiceAlerts: true,  s3Backup: true,  obsStreaming: true,  virtualCam: true  },
};

function hasFeature(plan, feature) {
  return FEATURE_MAP[plan]?.[feature] ?? false;
}

module.exports = { checkSubscription, hasFeature, FEATURE_MAP };
