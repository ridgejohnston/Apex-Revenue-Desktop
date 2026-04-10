#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// APEX REVENUE DESKTOP — Deploy App to AWS S3
//
// Run this every time you make code changes you want to push to users.
// The installer and Electron runtime don't need to change — just the app logic.
//
// Usage:
//   node scripts/deploy-app.js <version>
//   node scripts/deploy-app.js 1.1.0
//
// What happens:
//   1. Reads app.asar from dist/win-unpacked/resources/app.asar
//   2. Computes sha256 hash (used by the running app to verify downloads)
//   3. Uploads app.asar  → s3://apex-revenue-app-994438967527/app.asar
//   4. Uploads version.json with new version + hash
//   5. Running apps detect the change within 8 seconds of next launch
//      or within 2 hours if already running
//
// To rebuild app.asar before deploying:
//   npx electron-builder --win --x64 --dir --config.win.signAndEditExecutable=false
//   node scripts/deploy-app.js 1.1.0
// ═══════════════════════════════════════════════════════════════════════════════

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');

const { S3Client, PutObjectCommand,
        CreateBucketCommand, HeadBucketCommand,
        DeletePublicAccessBlockCommand,
        PutBucketPolicyCommand } = require('@aws-sdk/client-s3');

// ── Config ────────────────────────────────────────────────────────────────────
const APP_BUCKET  = 'apex-revenue-app-994438967527';
const REGION      = 'us-east-1';
const BASE_URL    = `https://${APP_BUCKET}.s3.amazonaws.com`;
const ASAR_PATH   = path.join(__dirname, '../dist/win-unpacked/resources/app.asar');

// ── Args ──────────────────────────────────────────────────────────────────────
const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/deploy-app.js <version>');
  console.error('Example: node scripts/deploy-app.js 1.1.0');
  process.exit(1);
}

if (!fs.existsSync(ASAR_PATH)) {
  console.error(`❌  app.asar not found at ${ASAR_PATH}`);
  console.error('    Run the build first:');
  console.error('    npx electron-builder --win --x64 --dir --config.win.signAndEditExecutable=false');
  process.exit(1);
}

// ── Load credentials ──────────────────────────────────────────────────────────
let creds;
try {
  creds = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/aws-defaults.json'), 'utf8'));
} catch {
  console.error('❌  config/aws-defaults.json not found');
  process.exit(1);
}

const s3 = new S3Client({
  region: REGION,
  credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
});

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🚀  Deploying Apex Revenue App v${version}`);
  console.log(`    asar  : ${ASAR_PATH}`);
  console.log(`    bucket: ${APP_BUCKET}\n`);

  // 1. Read and hash app.asar
  console.log('📦  Hashing app.asar…');
  const data   = fs.readFileSync(ASAR_PATH);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  const size   = data.length;
  console.log(`    ${(size / 1024 / 1024).toFixed(2)} MB  sha256: ${sha256.slice(0,24)}…`);

  // 2. Verify this is a different version from what's live
  try {
    const live = await fetchJson(`${BASE_URL}/version.json`);
    if (live.sha256 === sha256) {
      console.log(`\n⚠️   app.asar is identical to the live version (${live.version}).`);
      console.log(`    Nothing to deploy. Did you rebuild first?\n`);
      process.exit(0);
    }
    console.log(`    Live version: ${live.version} — deploying new version ${version}`);
  } catch {
    console.log('    (no current live version — first deploy)');
  }

  // 3. Ensure bucket exists + is public
  await ensureBucket();

  // 4. Upload app.asar
  console.log('\n⬆️   Uploading app.asar…');
  await s3.send(new PutObjectCommand({
    Bucket:      APP_BUCKET,
    Key:         'app.asar',
    Body:        data,
    ContentType: 'application/octet-stream',
  }));
  console.log(`    ✅  ${BASE_URL}/app.asar`);

  // 5. Upload version.json (last — so the app only sees a complete update)
  const versionInfo = {
    version,
    sha256,
    size,
    updatedAt: new Date().toISOString(),
  };
  console.log('\n⬆️   Uploading version.json…');
  await s3.send(new PutObjectCommand({
    Bucket:       APP_BUCKET,
    Key:          'version.json',
    Body:         JSON.stringify(versionInfo, null, 2),
    ContentType:  'application/json',
    CacheControl: 'no-cache, no-store, must-revalidate',
  }));
  console.log(`    ✅  ${BASE_URL}/version.json`);

  // 6. Verify
  console.log('\n🔍  Verifying live…');
  const live = await fetchJson(`${BASE_URL}/version.json`);
  if (live.version === version && live.sha256 === sha256) {
    console.log(`    ✅  version.json confirms v${version} is live`);
  } else {
    console.warn(`    ⚠️  version.json looks unexpected:`, live);
  }

  console.log(`\n✨  Deploy complete!`);
  console.log(`\n    Version : ${version}`);
  console.log(`    Size    : ${(size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`    URL     : ${BASE_URL}/app.asar`);
  console.log(`\n    ⏱  Running apps detect this within 8 seconds of next launch`);
  console.log(`       or within 2 hours if already running.\n`);
}

async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: APP_BUCKET }));
    return;
  } catch {}
  await s3.send(new CreateBucketCommand({ Bucket: APP_BUCKET }));
  try { await s3.send(new DeletePublicAccessBlockCommand({ Bucket: APP_BUCKET })); } catch {}
  try {
    await s3.send(new PutBucketPolicyCommand({
      Bucket: APP_BUCKET,
      Policy: JSON.stringify({
        Version:   '2012-10-17',
        Statement: [{
          Sid: 'PublicRead', Effect: 'Allow', Principal: '*',
          Action: 's3:GetObject', Resource: `arn:aws:s3:::${APP_BUCKET}/*`,
        }],
      }),
    }));
  } catch {}
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Cache-Control': 'no-cache' } }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Bad JSON')); } });
    }).on('error', reject);
  });
}

main().catch(err => { console.error('❌ Deploy failed:', err.message); process.exit(1); });
