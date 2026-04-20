/**
 * Apex Revenue — Encrypted coach profile sync (S3)
 *
 * Blob path: s3://<USER_DATA_BUCKET>/<cognito-sub>/profile.enc
 * Format: APX1 | salt(16) | iv(12) | tag(16) | ciphertext
 * Key: PBKDF2-SHA512 from (Cognito sub + passphrase) with per-file salt.
 * Server / S3 breach yields ciphertext only (zero-knowledge to Apex).
 */

const crypto = require('crypto');
const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const auth = require('../shared/auth');
const { S3_USER_DATA_BUCKET } = require('../shared/aws-config');

const MAGIC = Buffer.from('APX1', 'ascii');
const PBKDF2_ITERS = 210000;

let coachProfile = null;
let storeRef = null;
let getS3Client = null;

function init({ store, coachProfile: cp, getS3 }) {
  storeRef = store;
  coachProfile = cp;
  getS3Client = getS3;
}

function deriveKey(sub, passphrase, fileSalt) {
  const secret = Buffer.concat([
    Buffer.from(sub, 'utf8'),
    Buffer.from([0]),
    Buffer.from(passphrase, 'utf8'),
  ]);
  const salt = Buffer.concat([Buffer.from('apex-pfs-v1', 'utf8'), fileSalt]);
  return crypto.pbkdf2Sync(secret, salt, PBKDF2_ITERS, 32, 'sha512');
}

function encryptBlob(sub, passphrase, payloadObj) {
  const fileSalt = crypto.randomBytes(16);
  const key = deriveKey(sub, passphrase, fileSalt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(payloadObj), 'utf8');
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, fileSalt, iv, tag, enc]);
}

function decryptBlob(sub, passphrase, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 + 16 + 12 + 16) {
    throw new Error('invalid blob');
  }
  if (buf.subarray(0, 4).toString('ascii') !== 'APX1') throw new Error('bad magic');
  const fileSalt = buf.subarray(4, 20);
  const iv = buf.subarray(20, 32);
  const tag = buf.subarray(32, 48);
  const enc = buf.subarray(48);
  const key = deriveKey(sub, passphrase, fileSalt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

function keyForSession(session) {
  const sub = auth.getSub(session);
  if (!sub) return { error: 'not_signed_in' };
  const pass = storeRef.get('profileSyncPassphrase');
  if (!pass || typeof pass !== 'string' || pass.length < 4) {
    return { error: 'passphrase_required' };
  }
  return { sub, passphrase: pass };
}

async function pushEncryptedProfile() {
  const s3 = getS3Client && getS3Client();
  if (!s3) {
    console.warn('[profile-cloud-sync] S3 client not initialized — skip push');
    return { ok: false, reason: 's3_unavailable' };
  }
  const session = storeRef.get('apexSession');
  const k = keyForSession(session);
  if (k.error) return { ok: false, reason: k.error };

  const profile = await coachProfile.get();
  if (!profile.syncEnabled) return { ok: false, reason: 'sync_off' };

  const payload = { updatedAt: profile.updatedAt || Date.now(), profile };
  const body = encryptBlob(k.sub, k.passphrase, payload);

  await s3.send(new PutObjectCommand({
    Bucket: S3_USER_DATA_BUCKET,
    Key: `${k.sub}/profile.enc`,
    Body: body,
    ContentType: 'application/octet-stream',
    Metadata: {
      updatedat: String(payload.updatedAt),
    },
  }));
  return { ok: true };
}

async function fetchRemoteBuffer(sub) {
  const s3 = getS3Client && getS3Client();
  if (!s3) return null;
  try {
    const out = await s3.send(new GetObjectCommand({
      Bucket: S3_USER_DATA_BUCKET,
      Key: `${sub}/profile.enc`,
    }));
    const chunks = [];
    for await (const c of out.Body) chunks.push(c);
    return Buffer.concat(chunks);
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

/**
 * On startup: if sync on + passphrase + session, pull remote and last-write-wins vs local file.
 */
async function syncOnStartup() {
  const session = storeRef.get('apexSession');
  const k = keyForSession(session);
  if (k.error) return { ok: false, skipped: true, reason: k.error };

  const local = await coachProfile.get();
  if (!local.syncEnabled) return { ok: true, skipped: true };

  const remoteBuf = await fetchRemoteBuffer(k.sub);
  if (!remoteBuf) {
    await pushEncryptedProfile();
    return { ok: true, direction: 'pushed_initial' };
  }

  let remote;
  try {
    remote = decryptBlob(k.sub, k.passphrase, remoteBuf);
  } catch (err) {
    console.warn('[profile-cloud-sync] decrypt failed — wrong passphrase or corrupt blob:', err.message);
    return { ok: false, reason: 'decrypt_failed' };
  }

  const ru = remote.updatedAt || 0;
  const lu = local.updatedAt || 0;

  if (ru > lu) {
    await coachProfile.set(remote.profile);
    return { ok: true, direction: 'applied_remote' };
  }
  if (lu > ru) {
    await pushEncryptedProfile();
    return { ok: true, direction: 'pushed_local' };
  }
  return { ok: true, direction: 'noop_equal' };
}

async function afterLocalMutation() {
  const local = await coachProfile.get();
  if (!local.syncEnabled) return;
  const session = storeRef.get('apexSession');
  const k = keyForSession(session);
  if (k.error) return;
  try {
    await pushEncryptedProfile();
  } catch (e) {
    console.warn('[profile-cloud-sync] push failed:', e.message);
  }
}

module.exports = {
  init,
  pushEncryptedProfile,
  syncOnStartup,
  afterLocalMutation,
};
