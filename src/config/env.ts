import dotenv from 'dotenv';
dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env variable: ${key}`);
  return value;
}

export const env = {
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    baseUrl: process.env.BASE_URL || 'http://localhost:3000',
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  },
  mongodb: {
    uri: requireEnv('MONGODB_URI'),
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  google: {
    oauth: {
      clientId: requireEnv('GOOGLE_OAUTH_CLIENT_ID'),
      clientSecret: requireEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
      redirectUri:
        process.env.GOOGLE_OAUTH_REDIRECT_URI ||
        'http://localhost:3000/api/oauth/google/callback',
    },
    // Platform service account — optional fallback
    platformSa: {
      email: process.env.PLATFORM_SA_EMAIL || '',
      privateKey: (process.env.PLATFORM_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      projectId: process.env.PLATFORM_SA_PROJECT_ID || '',
    },
  },
  queue: {
    minDelayMinutes: parseInt(process.env.QUEUE_MIN_DELAY_MINUTES || '5', 10),
    maxDelayMinutes: parseInt(process.env.QUEUE_MAX_DELAY_MINUTES || '15', 10),
    domainConcurrentLimit: parseInt(process.env.DOMAIN_CONCURRENT_LIMIT || '3', 10),
    userDailyCap: parseInt(process.env.USER_DAILY_CAP || '50', 10),
  },
  job: {
    wrapperExpiryHours: parseInt(process.env.WRAPPER_EXPIRY_HOURS || '72', 10),
    maxRetryCount: parseInt(process.env.MAX_RETRY_COUNT || '3', 10),
    retryMinWaitHours: parseInt(process.env.RETRY_MIN_WAIT_HOURS || '24', 10),
    failAfterDays: parseInt(process.env.FAIL_AFTER_DAYS || '7', 10),
  },
  security: {
    jwtSecret: requireEnv('JWT_SECRET'),
    adminSecretKey: requireEnv('ADMIN_SECRET_KEY'),
  },
};
