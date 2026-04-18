/**
 * Apex Revenue — Centralized AWS Configuration
 * All AWS service endpoints, resource IDs, and constants
 */

module.exports = {
  REGION: 'us-east-1',

  // Cognito
  COGNITO_USER_POOL_ID: 'us-east-1_EjYUEgmKm',
  COGNITO_CLIENT_ID: '5f93lsurdb1lmcg8egasdcab2j',
  COGNITO_HOSTED_UI_DOMAIN: 'apex-revenue-auth.auth.us-east-1.amazoncognito.com',
  COGNITO_REDIRECT_URI: 'apexrevenue://auth/callback',
  COGNITO_LOGOUT_URI:   'apexrevenue://auth/signout',
  COGNITO_OAUTH_SCOPES: 'openid email profile',

  // Subscription / billing
  SUBSCRIPTION_OFFLINE_GRACE_MS: 3 * 24 * 60 * 60 * 1000,   // 3 days
  SUBSCRIPTION_CHECK_INTERVAL_MS: 60 * 60 * 1000,           // hourly re-check
  EXPIRY_WARNING_HOURS: [72, 24],                           // notification triggers

  // Cognito Hosted UI (OAuth 2.0 Authorization Code + PKCE)
  HOSTED_UI_DOMAIN:   'https://apex-revenue-auth.auth.us-east-1.amazoncognito.com',
  OAUTH_REDIRECT_URI: 'apexrevenue://auth/callback',
  OAUTH_LOGOUT_URI:   'apexrevenue://auth/signout',
  OAUTH_SCOPES:       ['email', 'openid', 'profile'],
  CUSTOM_PROTOCOL:    'apexrevenue',

  // Tier & billing
  // Offline grace: if /check-subscription is unreachable, keep serving the
  // last-known plan for up to this duration past the last successful check.
  OFFLINE_GRACE_MS:           3 * 24 * 60 * 60 * 1000, // 3 days
  // Expiry warning thresholds (ms before current_period_end)
  EXPIRY_WARN_72H_MS:         72 * 60 * 60 * 1000,
  EXPIRY_WARN_24H_MS:         24 * 60 * 60 * 1000,
  // How often main.js re-evaluates tier/expiry state
  TIER_CHECK_INTERVAL_MS:     60 * 60 * 1000,          // 1 hour

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
