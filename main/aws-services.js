// ═══════════════════════════════════════════════════════════════════════════════
// APEX REVENUE DESKTOP — AWS Services (main process only)
// All AWS SDK calls happen here. Renderer calls via IPC.
//
// Services:
//   • Bedrock  — AI tip prompt generation (Claude Haiku)
//   • Polly    — Text-to-speech voice alerts
//   • S3       — Session data backup + export
//   • CloudWatch — Custom live-session metrics
//   • Firehose — Real-time tip event streaming → S3
//   • IoT Core — Dual-device toy relay (ApexSensations integration)
// ═══════════════════════════════════════════════════════════════════════════════

const { BedrockRuntimeClient, InvokeModelCommand }       = require('@aws-sdk/client-bedrock-runtime');
const { PollyClient, SynthesizeSpeechCommand }            = require('@aws-sdk/client-polly');
const { S3Client, PutObjectCommand, CreateBucketCommand,
        HeadBucketCommand }                               = require('@aws-sdk/client-s3');
const { CloudWatchClient, PutMetricDataCommand }          = require('@aws-sdk/client-cloudwatch');
const { FirehoseClient, PutRecordCommand,
        PutRecordBatchCommand }                           = require('@aws-sdk/client-firehose');
const { IoTDataPlaneClient, PublishCommand }              = require('@aws-sdk/client-iot-data-plane');
const Store  = require('electron-store');
const config = require('../shared/aws-config');

// ── Credential store ──────────────────────────────────────────────────────────
const credStore = new Store({ name: 'apex-aws-creds', encryptionKey: 'apex-creds-v1' });

function getCredentials() {
  const creds = credStore.get('awsCredentials');
  if (creds && creds.accessKeyId && creds.secretAccessKey) return creds;
  // Fall back to env (for dev)
  if (process.env.AWS_ACCESS_KEY_ID) {
    return {
      accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region:          process.env.AWS_DEFAULT_REGION || config.REGION,
    };
  }
  return null;
}

function setCredentials(creds) {
  credStore.set('awsCredentials', creds);
}

function makeClientConfig(extraRegion) {
  const creds = getCredentials();
  const base  = { region: extraRegion || config.REGION };
  if (creds) base.credentials = {
    accessKeyId:     creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
  };
  return base;
}

// ── Client singletons ─────────────────────────────────────────────────────────
let _bedrock, _polly, _s3, _cw, _firehose, _iot;
const bedrock  = () => _bedrock  || (_bedrock  = new BedrockRuntimeClient(makeClientConfig(config.BEDROCK_REGION)));
const polly    = () => _polly    || (_polly    = new PollyClient(makeClientConfig()));
const s3       = () => _s3       || (_s3       = new S3Client(makeClientConfig()));
const cw       = () => _cw       || (_cw       = new CloudWatchClient(makeClientConfig()));
const firehose = () => _firehose || (_firehose = new FirehoseClient(makeClientConfig()));
const iot      = () => _iot      || (_iot      = new IoTDataPlaneClient({
  ...makeClientConfig(),
  endpoint: `https://${config.IOT_ENDPOINT}`,
}));

// Reset clients when credentials change
function resetClients() {
  _bedrock = _polly = _s3 = _cw = _firehose = _iot = null;
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. AWS BEDROCK — AI Tip Prompt Generation
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a contextual monetisation prompt using Claude Haiku via Bedrock.
 * @param {Object} sessionData  Live session snapshot from preload-cam.js
 * @param {string} triggerReason  What triggered this (e.g. 'dead_air', 'whale_present')
 * @returns {Promise<{prompt: string, signal: string, confidence: number}>}
 */
async function generateAiPrompt(sessionData, triggerReason) {
  const {
    platform = 'chaturbate',
    viewers  = 0,
    tokensPerHour = 0,
    convRate = 0,
    fans     = [],
    whales   = [],
    tipEvents = [],
    username = '',
  } = sessionData;

  const tippers     = fans.filter(f => f.tips > 0);
  const recentTips  = tipEvents.filter(e => Date.now() - e.timestamp < 300000);
  const topFan      = tippers[0];
  const minutesSilent = recentTips.length === 0
    ? Math.round((Date.now() - (tipEvents[tipEvents.length - 1]?.timestamp || Date.now())) / 60000)
    : 0;

  const systemPrompt = `You are Apex Revenue, an AI monetisation coach for adult live cam performers on ${platform}. 
Generate a single, concise, actionable performer tip (max 2 sentences). 
Write in second person. Be specific, warm, confident. Never be crude. Focus on earnings.
Respond ONLY with the tip text — no preamble, no quotes, no labels.`;

  const userMessage = `Current session stats:
- Platform: ${platform}
- Username: ${username || 'unknown'}
- Live viewers: ${viewers}
- Tokens/hr: ${tokensPerHour}
- Conversion rate: ${convRate}%
- Unique tippers: ${tippers.length}
- Whales in room: ${whales.length} ${whales[0] ? `(top: ${whales[0].username}, ${whales[0].tips} tokens)` : ''}
- Top fan: ${topFan ? `${topFan.username} (${topFan.tips} tokens)` : 'none yet'}
- Minutes since last tip: ${minutesSilent}
- Recent tip count (last 5 min): ${recentTips.length}
- Trigger reason: ${triggerReason}

Generate a targeted performer tip for this exact moment.`;

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens:        config.BEDROCK_MAX_TOKENS,
    system:            systemPrompt,
    messages:          [{ role: 'user', content: userMessage }],
  });

  const cmd  = new InvokeModelCommand({
    modelId:     config.BEDROCK_MODEL_ID,
    contentType: 'application/json',
    accept:      'application/json',
    body,
  });

  const resp     = await bedrock().send(cmd);
  const decoded  = JSON.parse(Buffer.from(resp.body).toString('utf-8'));
  const text     = decoded.content?.[0]?.text?.trim() || '';

  return { prompt: text, signal: triggerReason, confidence: 0.85 };
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. AWS POLLY — Voice Alerts
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Synthesize text to speech via AWS Polly.
 * Returns the audio as a base64-encoded MP3 string (sent to renderer to play).
 */
async function synthesizeSpeech(text) {
  // Truncate and clean
  const clean = text.replace(/[<>]/g, '').slice(0, 500);

  const cmd = new SynthesizeSpeechCommand({
    Text:         clean,
    OutputFormat: config.POLLY_FORMAT,
    VoiceId:      config.POLLY_VOICE_ID,
    Engine:       config.POLLY_ENGINE,
  });

  const resp = await polly().send(cmd);

  // Collect stream into buffer
  const chunks = [];
  for await (const chunk of resp.AudioStream) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  return buffer.toString('base64');  // renderer plays: new Audio('data:audio/mp3;base64,...')
}

// Pre-built voice alert templates
const VOICE_TEMPLATES = {
  whale:       (name, amount) => `Whale alert! ${name} just tipped ${amount} tokens!`,
  milestone:   (tokens)       => `Goal reached! ${tokens} tokens this session. Amazing work!`,
  dead_air:    ()             => `Engagement dropping. Time to spark a conversation!`,
  surge:       (count)        => `Viewer surge! ${count} people in the room right now.`,
  top_tipper:  (name, total)  => `${name} is your top tipper with ${total} tokens. Give them a shout-out!`,
  session_end: (tokens, hrs)  => `Great session! ${tokens} tokens in ${hrs} hours.`,
};

async function speakAlert(type, ...args) {
  const templateFn = VOICE_TEMPLATES[type];
  if (!templateFn) return null;
  const text = templateFn(...args);
  const audio = await synthesizeSpeech(text);
  return { audio, text };
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. AWS S3 — Session Backup & Export
// ══════════════════════════════════════════════════════════════════════════════

async function ensureBucketExists() {
  try {
    await s3().send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }));
  } catch (e) {
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) {
      await s3().send(new CreateBucketCommand({ Bucket: config.S3_BUCKET }));
      console.log('[ApexAWS] S3 bucket created:', config.S3_BUCKET);
    }
  }
}

/**
 * Save a session snapshot to S3.
 * Key: desktop-sessions/{username}/{date}_{sessionId}.json
 */
async function backupSessionToS3(sessionData, username) {
  await ensureBucketExists();

  const date      = new Date().toISOString().split('T')[0];
  const sessionId = Date.now();
  const key       = `${config.S3_BACKUP_PREFIX}${username || 'unknown'}/${date}_${sessionId}.json`;

  const payload = JSON.stringify({
    ...sessionData,
    savedAt:  new Date().toISOString(),
    appVersion: '1.0.0',
    source: 'apex-revenue-desktop',
  }, null, 2);

  await s3().send(new PutObjectCommand({
    Bucket:      config.S3_BUCKET,
    Key:         key,
    Body:        payload,
    ContentType: 'application/json',
  }));

  return { bucket: config.S3_BUCKET, key, size: payload.length };
}

/**
 * Export fan leaderboard / tip history to S3 as CSV.
 */
async function exportSessionCsvToS3(sessionData, username) {
  await ensureBucketExists();

  const fans    = (sessionData.fans || []).filter(f => f.tips > 0);
  const header  = 'rank,username,tokens,tier,joins\n';
  const rows    = fans.map((f, i) =>
    `${i+1},${f.username},${f.tips},${f.tier || 4},${f.joins || 0}`
  ).join('\n');
  const csv     = header + rows;

  const date = new Date().toISOString().split('T')[0];
  const key  = `${config.S3_EXPORT_PREFIX}${username || 'unknown'}/${date}_export.csv`;

  await s3().send(new PutObjectCommand({
    Bucket:      config.S3_BUCKET,
    Key:         key,
    Body:        csv,
    ContentType: 'text/csv',
  }));

  return { bucket: config.S3_BUCKET, key, rows: fans.length };
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. AWS CLOUDWATCH — Live Session Metrics
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Emit current session metrics as CloudWatch custom metrics.
 * Namespace: ApexRevenue/Desktop
 * Dimensions: Platform, Username
 */
async function emitCloudWatchMetrics(sessionData, username) {
  const dimensions = [
    { Name: 'Platform', Value: sessionData.platform || 'chaturbate' },
    { Name: 'Username', Value: username || 'anonymous' },
  ];

  const timestamp = new Date();

  const metricData = [
    {
      MetricName: 'TokensPerHour',
      Value:      sessionData.tokensPerHour || 0,
      Unit:       'Count',
      Timestamp:  timestamp,
      Dimensions: dimensions,
    },
    {
      MetricName: 'ViewerCount',
      Value:      sessionData.viewers || 0,
      Unit:       'Count',
      Timestamp:  timestamp,
      Dimensions: dimensions,
    },
    {
      MetricName: 'ConversionRate',
      Value:      parseFloat(sessionData.convRate) || 0,
      Unit:       'Percent',
      Timestamp:  timestamp,
      Dimensions: dimensions,
    },
    {
      MetricName: 'WhaleCount',
      Value:      (sessionData.whales || []).length,
      Unit:       'Count',
      Timestamp:  timestamp,
      Dimensions: dimensions,
    },
    {
      MetricName: 'TotalTippers',
      Value:      (sessionData.fans || []).filter(f => f.tips > 0).length,
      Unit:       'Count',
      Timestamp:  timestamp,
      Dimensions: dimensions,
    },
    {
      MetricName: 'TotalTokens',
      Value:      sessionData.totalTips || 0,
      Unit:       'Count',
      Timestamp:  timestamp,
      Dimensions: dimensions,
    },
  ];

  await cw().send(new PutMetricDataCommand({
    Namespace:  config.CW_NAMESPACE,
    MetricData: metricData,
  }));

  return { metricsEmitted: metricData.length, namespace: config.CW_NAMESPACE };
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. AWS KINESIS FIREHOSE — Real-time Tip Event Streaming
// ══════════════════════════════════════════════════════════════════════════════

// Buffer tip events and flush every 5s (Firehose batching)
const tipEventBuffer = [];
let   firehoseFlushTimer = null;

function queueTipEvent(tipEvent, sessionMeta) {
  const record = {
    username:  tipEvent.username,
    amount:    tipEvent.amount,
    timestamp: tipEvent.timestamp,
    platform:  sessionMeta.platform || 'chaturbate',
    streamer:  sessionMeta.username || 'unknown',
    source:    'desktop',
    ts:        new Date().toISOString(),
  };
  tipEventBuffer.push(JSON.stringify(record) + '\n');

  // Auto-flush when buffer reaches 100 records or after 5s
  if (tipEventBuffer.length >= 100) flushFirehose();
  else if (!firehoseFlushTimer) {
    firehoseFlushTimer = setTimeout(flushFirehose, 5000);
  }
}

async function flushFirehose() {
  if (firehoseFlushTimer) { clearTimeout(firehoseFlushTimer); firehoseFlushTimer = null; }
  if (tipEventBuffer.length === 0) return;

  const records = tipEventBuffer.splice(0, 500).map(data => ({
    Data: Buffer.from(data),
  }));

  try {
    await firehose().send(new PutRecordBatchCommand({
      DeliveryStreamName: config.FIREHOSE_STREAM,
      Records: records,
    }));
    console.log(`[ApexAWS] Flushed ${records.length} events to Firehose`);
  } catch (e) {
    console.warn('[ApexAWS] Firehose flush failed:', e.message);
    // Re-queue on failure (up to buffer limit)
    if (tipEventBuffer.length < 1000) tipEventBuffer.unshift(...records.map(r => r.Data.toString()));
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 6. AWS IoT CORE — Dual-Device Relay (ApexSensations Integration)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Publish a toy control command via IoT Core.
 * Bridges the desktop app to ApexSensations CB App for dual-device fan toy sync.
 * Topic: apex-revenue/relay/{sessionId}/cmd
 */
async function publishIoTCommand(sessionId, command) {
  const topic   = `${config.IOT_TOPIC_PREFIX}${sessionId}/cmd`;
  const payload = JSON.stringify({
    ...command,
    source:    'desktop',
    ts:        Date.now(),
    sessionId,
  });

  await iot().send(new PublishCommand({
    topic,
    qos:     0,
    payload: Buffer.from(payload),
  }));

  return { topic, payload };
}

/**
 * Subscribe channel for receiving fan toy events back from ApexSensations.
 * (Polling fallback — real subscribe needs MQTT.js WebSocket client)
 */
async function publishIoTStatus(sessionId, status) {
  const topic   = `${config.IOT_TOPIC_PREFIX}${sessionId}/status`;
  const payload = JSON.stringify({ ...status, source: 'desktop', ts: Date.now() });

  await iot().send(new PublishCommand({
    topic,
    qos:     0,
    payload: Buffer.from(payload),
  }));
}

// ══════════════════════════════════════════════════════════════════════════════
// Exports
// ══════════════════════════════════════════════════════════════════════════════
module.exports = {
  // Credentials
  setCredentials,
  getCredentials,
  resetClients,

  // Bedrock
  generateAiPrompt,

  // Polly
  synthesizeSpeech,
  speakAlert,
  VOICE_TEMPLATES,

  // S3
  backupSessionToS3,
  exportSessionCsvToS3,
  ensureBucketExists,

  // CloudWatch
  emitCloudWatchMetrics,

  // Firehose
  queueTipEvent,
  flushFirehose,

  // IoT
  publishIoTCommand,
  publishIoTStatus,
};
