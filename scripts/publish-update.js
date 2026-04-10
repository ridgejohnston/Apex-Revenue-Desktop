#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// APEX REVENUE DESKTOP — Publish Update to S3
//
// Usage:
//   node scripts/publish-update.js <version> <installer-path>
//
// Example:
//   node scripts/publish-update.js 1.1.0 installer/ApexRevenue-Setup-1.1.0.exe
//
// What it does:
//   1. Validates the installer file exists
//   2. Computes sha512 hash of the installer
//   3. Generates latest.yml (electron-updater manifest)
//   4. Uploads installer + latest.yml to S3 (public bucket)
//   5. Prints the public URL and confirms the update is live
//
// The installed app checks this bucket every 12 seconds after launch,
// then every 4 hours. Users see the update banner automatically.
// ═══════════════════════════════════════════════════════════════════════════════

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const https   = require('https');

const { S3Client, PutObjectCommand,
        CreateBucketCommand, HeadBucketCommand,
        DeletePublicAccessBlockCommand,
        PutBucketPolicyCommand }  = require('@aws-sdk/client-s3');

// ── Config ────────────────────────────────────────────────────────────────────
const UPDATE_BUCKET = 'apex-revenue-updates-994438967527';
const REGION        = 'us-east-1';
const BASE_URL      = `https://${UPDATE_BUCKET}.s3.amazonaws.com`;

// ── Args ──────────────────────────────────────────────────────────────────────
const [,, version, installerArg] = process.argv;

if (!version || !installerArg) {
  console.error('Usage: node scripts/publish-update.js <version> <installer-path>');
  console.error('Example: node scripts/publish-update.js 1.1.0 installer/ApexRevenue-Setup-1.1.0.exe');
  process.exit(1);
}

const installerPath = path.resolve(installerArg);
if (!fs.existsSync(installerPath)) {
  console.error(`❌  Installer not found: ${installerPath}`);
  process.exit(1);
}

// ── Load AWS credentials from gitignored config ───────────────────────────────
let creds;
try {
  const cfgPath = path.join(__dirname, '../config/aws-defaults.json');
  creds = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
} catch {
  console.error('❌  Cannot read config/aws-defaults.json — AWS credentials missing');
  process.exit(1);
}

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId:     creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
  },
});

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🚀  Publishing Apex Revenue Desktop v${version}`);
  console.log(`    Installer : ${installerPath}`);
  console.log(`    Bucket    : ${UPDATE_BUCKET}\n`);

  // 1. Read installer
  console.log('📦  Reading installer…');
  const data = fs.readFileSync(installerPath);
  const size = data.length;
  const sha512 = crypto.createHash('sha512').update(data).digest('base64');
  console.log(`    Size   : ${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`    SHA512 : ${sha512.slice(0, 32)}…`);

  // 2. Generate latest.yml
  const filename   = path.basename(installerPath);
  const releaseDate = new Date().toISOString();
  const latestYml = [
    `version: ${version}`,
    `files:`,
    `  - url: ${filename}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${filename}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n');

  console.log('\n📄  Generated latest.yml:');
  console.log(latestYml);

  // 3. Ensure bucket exists and is publicly readable
  console.log('🪣  Checking S3 bucket…');
  await ensureBucket();

  // 4. Upload installer
  console.log(`⬆️   Uploading ${filename} (${(size / 1024 / 1024).toFixed(1)} MB)…`);
  await s3.send(new PutObjectCommand({
    Bucket:      UPDATE_BUCKET,
    Key:         filename,
    Body:        data,
    ContentType: 'application/octet-stream',
  }));
  console.log(`    ✅  ${BASE_URL}/${filename}`);

  // 5. Upload latest.yml
  console.log('⬆️   Uploading latest.yml…');
  await s3.send(new PutObjectCommand({
    Bucket:       UPDATE_BUCKET,
    Key:          'latest.yml',
    Body:         latestYml,
    ContentType:  'text/yaml',
    CacheControl: 'no-cache, no-store, must-revalidate',
  }));
  console.log(`    ✅  ${BASE_URL}/latest.yml`);

  // 6. Verify latest.yml is live
  console.log('\n🔍  Verifying public access…');
  const liveYml = await fetchUrl(`${BASE_URL}/latest.yml`);
  if (liveYml.includes(`version: ${version}`)) {
    console.log(`    ✅  latest.yml confirms version ${version} is live`);
  } else {
    console.warn(`    ⚠️  latest.yml content unexpected:\n${liveYml}`);
  }

  console.log(`\n✨  Update published successfully!`);
  console.log(`    Version : ${version}`);
  console.log(`    URL     : ${BASE_URL}/latest.yml`);
  console.log(`\n    Installed apps will detect this update within 12 seconds`);
  console.log(`    of next launch, or within 4 hours if already running.\n`);
}

async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: UPDATE_BUCKET }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: UPDATE_BUCKET, CreateBucketConfiguration: { LocationConstraint: REGION } }));
  }
  // Remove public access block
  try {
    await s3.send(new DeletePublicAccessBlockCommand({ Bucket: UPDATE_BUCKET }));
  } catch {}
  // Set public-read policy
  try {
    await s3.send(new PutBucketPolicyCommand({
      Bucket: UPDATE_BUCKET,
      Policy: JSON.stringify({
        Version:   '2012-10-17',
        Statement: [{
          Sid:       'PublicRead',
          Effect:    'Allow',
          Principal: '*',
          Action:    's3:GetObject',
          Resource:  `arn:aws:s3:::${UPDATE_BUCKET}/*`,
        }],
      }),
    }));
  } catch {}
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

main().catch(err => { console.error('❌  Publish failed:', err.message); process.exit(1); });
