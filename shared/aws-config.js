/**
 * Apex Revenue — Centralized AWS Configuration
 * All AWS service endpoints, resource IDs, and constants
 */

module.exports = {
  REGION: 'us-east-1',

  // Cognito
  COGNITO_USER_POOL_ID: 'us-east-1_EjYUEgmKm',
  COGNITO_CLIENT_ID: '5t0a3hr1kl2rvs2sksmcukv0gk',

  // API Gateway
  API_ENDPOINT: 'https://7g6qsxoos3.execute-api.us-east-1.amazonaws.com/prod',

  // S3
  S3_SESSIONS_BUCKET: 'apex-revenue-sessions-994438967527',
  S3_UPDATES_BUCKET: 'apex-revenue-app-994438967527',

  // Bedrock
  BEDROCK_MODEL_ID: 'anthropic.claude-3-haiku-20240307-v1:0',
  BEDROCK_MAX_TOKENS: 300,

  // Polly
  POLLY_VOICE_ID: 'Joanna',
  POLLY_ENGINE: 'neural',
  POLLY_OUTPUT_FORMAT: 'mp3',

  // Firehose
  FIREHOSE_STREAM: 'apex-revenue-tip-events',

  // IoT Core
  IOT_ENDPOINT: 'mr5rjohfed-ats.iot.us-east-1.amazonaws.com',
  IOT_TOPIC_PREFIX: 'apex-revenue/',

  // CloudWatch
  CW_NAMESPACE: 'ApexRevenue/Desktop',
  CW_HEARTBEAT_INTERVAL_MS: 60000,
};
