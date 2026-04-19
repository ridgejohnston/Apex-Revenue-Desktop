/**
 * Apex Revenue — AWS Services (Bedrock, Polly, S3, CloudWatch, Firehose, IoT)
 */

const {
  REGION, BEDROCK_MODEL_ID, BEDROCK_MAX_TOKENS,
  POLLY_VOICE_ID, POLLY_ENGINE, POLLY_OUTPUT_FORMAT,
  S3_SESSIONS_BUCKET, FIREHOSE_STREAM, CW_NAMESPACE,
  IOT_ENDPOINT, IOT_TOPIC_PREFIX,
} = require('../shared/aws-config');

let bedrockClient, pollyClient, s3Client, cwClient, firehoseClient, iotClient;
let storeRef = null;

async function init(store) {
  storeRef = store;

  // Load credentials — from config file or store
  let credentials;
  try {
    credentials = require('../config/aws-defaults.json');
  } catch {
    credentials = store.get('awsCredentials');
  }

  if (!credentials?.accessKeyId) {
    console.warn('AWS credentials not found — services disabled');
    return;
  }

  const config = { region: REGION, credentials };

  const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
  const { PollyClient, SynthesizeSpeechCommand } = require('@aws-sdk/client-polly');
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
  const { FirehoseClient, PutRecordCommand } = require('@aws-sdk/client-firehose');
  const { IoTDataPlaneClient, PublishCommand } = require('@aws-sdk/client-iot-data-plane');

  bedrockClient = new BedrockRuntimeClient(config);
  pollyClient = new PollyClient(config);
  s3Client = new S3Client(config);
  cwClient = new CloudWatchClient(config);
  firehoseClient = new FirehoseClient(config);
  iotClient = new IoTDataPlaneClient({ ...config, endpoint: `https://${IOT_ENDPOINT}` });
}

async function generatePrompt(trigger, context) {
  if (!bedrockClient) throw new Error('Bedrock not initialized');
  const { InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

  const systemPrompts = {
    tipAskPrice: `You are a live cam earnings coach. Based on the session stats provided, recommend ONE specific token amount the model should ask for right now. Consider viewer count, recent tip amounts, and session energy. Respond with the token amount first (e.g. "Ask for 50 tokens —") followed by a one-sentence reason why that amount is right for this moment. Be direct and specific.`,
  };

  const systemPrompt = systemPrompts[trigger] ||
    `You are a concise coach for a live cam model. Given the trigger "${trigger}" and session stats, give ONE actionable tip in 1-2 sentences. Be specific, motivating, and brief.`;

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: BEDROCK_MAX_TOKENS,
    messages: [
      { role: 'user', content: `Trigger: ${trigger}\nStats: ${JSON.stringify(context)}` },
    ],
    system: systemPrompt,
  });

  const cmd = new InvokeModelCommand({
    modelId: BEDROCK_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body,
  });

  const response = await bedrockClient.send(cmd);
  const result = JSON.parse(new TextDecoder().decode(response.body));
  return result.content?.[0]?.text || '';
}

async function synthesizeSpeech(text) {
  if (!pollyClient) throw new Error('Polly not initialized');
  const { SynthesizeSpeechCommand } = require('@aws-sdk/client-polly');

  const cmd = new SynthesizeSpeechCommand({
    Text: text,
    VoiceId: POLLY_VOICE_ID,
    Engine: POLLY_ENGINE,
    OutputFormat: POLLY_OUTPUT_FORMAT,
  });

  const response = await pollyClient.send(cmd);
  const chunks = [];
  for await (const chunk of response.AudioStream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('base64');
}

async function backupSession(snapshot, session) {
  if (!s3Client) throw new Error('S3 not initialized');
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const auth = require('../shared/auth');

  const email = auth.getEmail(session) || 'anonymous';
  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const key = `desktop-sessions/${email}/${sessionId}.json`;

  await s3Client.send(new PutObjectCommand({
    Bucket: S3_SESSIONS_BUCKET,
    Key: key,
    Body: JSON.stringify(snapshot, null, 2),
    ContentType: 'application/json',
  }));

  return key;
}

async function emitHeartbeat(snapshot) {
  if (!cwClient) return;
  const { PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');

  const metrics = [
    { MetricName: 'Viewers', Value: snapshot.viewers || 0, Unit: 'Count' },
    { MetricName: 'TokensPerHour', Value: snapshot.tokensPerHour || 0, Unit: 'Count' },
    { MetricName: 'UniqueTippers', Value: snapshot.uniqueTippers || 0, Unit: 'Count' },
  ];

  await cwClient.send(new PutMetricDataCommand({
    Namespace: CW_NAMESPACE,
    MetricData: metrics.map((m) => ({
      ...m,
      Timestamp: new Date(),
      Dimensions: [{ Name: 'Platform', Value: snapshot.platform || 'unknown' }],
    })),
  }));
}

async function sendTipEvent(tipData) {
  if (!firehoseClient) return;
  const { PutRecordCommand } = require('@aws-sdk/client-firehose');

  await firehoseClient.send(new PutRecordCommand({
    DeliveryStreamName: FIREHOSE_STREAM,
    Record: { Data: Buffer.from(JSON.stringify(tipData) + '\n') },
  }));
}

async function publishIoT(topic, payload) {
  if (!iotClient) return;
  const { PublishCommand } = require('@aws-sdk/client-iot-data-plane');

  await iotClient.send(new PublishCommand({
    topic: `${IOT_TOPIC_PREFIX}${topic}`,
    payload: Buffer.from(JSON.stringify(payload)),
    qos: 0,
  }));
}

module.exports = {
  init, generatePrompt, synthesizeSpeech,
  backupSession, emitHeartbeat, sendTipEvent, publishIoT,
  // Getter so the AI Coach module can reuse the initialized client
  // rather than building its own. Returns null until init() runs.
  getBedrockClient: () => bedrockClient,
};
