// ═══════════════════════════════════════════════════════════════════════════════
// APEX REVENUE DESKTOP — AWS Configuration
// Central config for all AWS service clients
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Core
  REGION:           'us-east-1',
  ACCOUNT_ID:       '994438967527',

  // Cognito (auth — same as Chrome extension)
  COGNITO_USER_POOL_ID:  'us-east-1_EjYUEgmKm',
  COGNITO_CLIENT_ID:     '2q57i2f3sl6lcl8rlu7tt3dgdf',
  COGNITO_ISSUER:        'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EjYUEgmKm',

  // API Gateway (existing backend)
  API_BASE: 'https://7g6qsxoos3.execute-api.us-east-1.amazonaws.com/prod',

  // S3 — session storage
  S3_BUCKET:             'apex-revenue-sessions-994438967527',
  S3_BACKUP_PREFIX:      'desktop-sessions/',
  S3_EXPORT_PREFIX:      'desktop-exports/',

  // CloudWatch — custom metrics
  CW_NAMESPACE:          'ApexRevenue/Desktop',
  CW_METRICS_INTERVAL:   60000,   // emit every 60s

  // Kinesis Firehose — event streaming → S3
  FIREHOSE_STREAM:       'apex-revenue-tip-events',

  // Bedrock — AI prompt generation
  BEDROCK_MODEL_ID:      'anthropic.claude-3-haiku-20240307-v1:0',
  BEDROCK_REGION:        'us-east-1',
  BEDROCK_MAX_TOKENS:    300,

  // Polly — voice alerts
  POLLY_VOICE_ID:        'Joanna',     // female, natural US English
  POLLY_ENGINE:          'neural',
  POLLY_FORMAT:          'mp3',

  // IoT Core — dual-device WebSocket relay (ApexSensations integration)
  IOT_ENDPOINT:          'mr5rjohfed-ats.iot.us-east-1.amazonaws.com',
  IOT_TOPIC_PREFIX:      'apex-revenue/relay/',

  // Prompt cooldowns (ms)
  AI_PROMPT_COOLDOWN:    90000,
  VOICE_ALERT_COOLDOWN:  30000,
};
