import dns from 'dns';
import dotenv from 'dotenv';
dotenv.config();

// A mongodb+srv:// URI is resolved with Node's own DNS resolver, which uses the OS list of DNS
// servers. When that list is unusable (e.g. only 127.0.0.1 with nothing listening, as with some
// VPN / DNS-proxy setups) the connection fails with "querySrv ECONNREFUSED" even though the
// browser and nslookup work. DNS_SERVERS=1.1.1.1,8.8.8.8 overrides it for this process only.
if (process.env.DNS_SERVERS) {
  dns.setServers(process.env.DNS_SERVERS.split(',').map((s) => s.trim()).filter(Boolean));
}

// DNS lookups (getaddrinfo) run on libuv's thread pool, which defaults to 4 threads; a
// pre-flight scan of many hosts would queue behind them. Must be set before the pool is first
// used, which is why it sits at the top of the first module the app loads.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '16';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env variable: ${key}`);
  return value;
}

/**
 * Which credential publishes to the Indexing API:
 *  - platform:       platform service accounts only (users' tokens never publish)
 *  - platform_first: service accounts first, user's token only as fallback
 *  - user_first:     user's token first, service account as fallback
 */
export type PublishCredentialMode = 'platform' | 'platform_first' | 'user_first';

function parsePublishCredentialMode(raw: string | undefined): PublishCredentialMode {
  const value = (raw || 'platform_first').trim().toLowerCase();
  if (value === 'platform' || value === 'platform_first' || value === 'user_first') {
    return value;
  }
  throw new Error(
    `Invalid PUBLISH_CREDENTIAL_MODE "${raw}" (use platform, platform_first or user_first)`
  );
}

export const env = {
  server: {
    port: parseInt(process.env.PORT || '5050', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    baseUrl: process.env.BASE_URL || 'http://localhost:5050',
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
    // Number of reverse proxies in front of the app (Caddy/Nginx = 1). 0 = none.
    trustProxy: parseInt(process.env.TRUST_PROXY || '0', 10),
  },
  mongodb: {
    uri: requireEnv('MONGODB_URI'),
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    // Namespace for the Bull queue keys. Keep the default in production; tests use
    // their own so they can never touch a real queue sharing the same Redis.
    queuePrefix: process.env.REDIS_QUEUE_PREFIX || 'bull',
  },
  google: {
    oauth: {
      clientId: requireEnv('GOOGLE_OAUTH_CLIENT_ID'),
      clientSecret: requireEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
      redirectUri:
        process.env.GOOGLE_OAUTH_REDIRECT_URI ||
        'http://localhost:5050/api/oauth/google/callback',
    },
    // Platform service account — optional fallback
    platformSa: {
      email: process.env.PLATFORM_SA_EMAIL || '',
      privateKey: (process.env.PLATFORM_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      projectId: process.env.PLATFORM_SA_PROJECT_ID || '',
    },
    publishCredentialMode: parsePublishCredentialMode(process.env.PUBLISH_CREDENTIAL_MODE),
    // Search Console property that owns BASE_URL; the platform SA submits the
    // wrapper sitemap under it. Defaults to the https://<BASE_URL host>/ property.
    platformGscSiteUrl: process.env.PLATFORM_GSC_SITE_URL || '',
    // Indexing API quota is counted per Google Cloud project (the OAuth client's
    // project), so publishes made with users' tokens share one daily budget.
    oauthDailyPublishLimit: parseInt(process.env.OAUTH_DAILY_PUBLISH_LIMIT || '180', 10),
  },
  queue: {
    minDelayMinutes: parseInt(process.env.QUEUE_MIN_DELAY_MINUTES || '1', 10),
    maxDelayMinutes: parseInt(process.env.QUEUE_MAX_DELAY_MINUTES || '3', 10),
    domainConcurrentLimit: parseInt(process.env.DOMAIN_CONCURRENT_LIMIT || '3', 10),
    userDailyCap: parseInt(process.env.USER_DAILY_CAP || '50', 10),
  },
  indexCheck: {
    cron: process.env.INDEX_CHECK_CRON || '*/15 * * * *',
    // How long after the Indexing API call before the first Search Console check
    firstCheckAfterMinutes: parseInt(process.env.INDEX_CHECK_FIRST_AFTER_MINUTES || '20', 10),
  },
  indexNow: {
    // Optional. When set, new wrapper URLs are also submitted to IndexNow (Bing, Yandex, ...)
    key: process.env.INDEXNOW_KEY || '',
  },
  job: {
    wrapperExpiryHours: parseInt(process.env.WRAPPER_EXPIRY_HOURS || '72', 10),
    maxRetryCount: parseInt(process.env.MAX_RETRY_COUNT || '3', 10),
    retryMinWaitHours: parseInt(process.env.RETRY_MIN_WAIT_HOURS || '24', 10),
    failAfterDays: parseInt(process.env.FAIL_AFTER_DAYS || '7', 10),
    // Failed Indexing API calls (not quota waits) before the job fails and is refunded
    maxPublishAttempts: parseInt(process.env.MAX_PUBLISH_ATTEMPTS || '5', 10),
  },
  // Pre-flight scan: fetches submitted URLs and rejects ones Google cannot index
  // (404, noindex, blocked by robots.txt, ...) before they cost a credit or API quota.
  preflight: {
    // Submit refuses URLs the scan marks as blocked. Set PREFLIGHT_ON_SUBMIT=false to turn off.
    enforceOnSubmit: process.env.PREFLIGHT_ON_SUBMIT !== 'false',
    maxUrlsPerScan: parseInt(process.env.PREFLIGHT_MAX_URLS || '100', 10),
    // URLs scanned in parallel per request / across all requests / against a single host
    concurrency: parseInt(process.env.PREFLIGHT_CONCURRENCY || '16', 10),
    globalConcurrency: parseInt(process.env.PREFLIGHT_GLOBAL_CONCURRENCY || '64', 10),
    perHostConcurrency: parseInt(process.env.PREFLIGHT_PER_HOST_CONCURRENCY || '4', 10),
    // Total time budget for one URL, redirects included
    timeoutMs: parseInt(process.env.PREFLIGHT_TIMEOUT_MS || '10000', 10),
    // Only the start of a page is read: enough for <head>, robots meta and the first text
    maxBodyBytes: 256 * 1024,
    maxRedirects: 5,
    // Importing the URLs listed in a sitemap: how many are returned, how many sitemap files
    // (a sitemap index points at others) are read, and how large each may be
    sitemapMaxUrls: parseInt(process.env.PREFLIGHT_SITEMAP_MAX_URLS || '500', 10),
    sitemapMaxFiles: 10,
    sitemapMaxBytes: 5 * 1024 * 1024,
    // How long a scan result may be reused by submit
    cacheTtlMs: 10 * 60 * 1000,
    // Lets the scanner reach loopback/private addresses and any port. Never read from the
    // environment: a server-side fetch of user-supplied URLs must not reach internal hosts.
    // Tests flip it to point the scanner at a local server.
    allowPrivateNetworks: false,
  },
  security: {
    jwtSecret: requireEnv('JWT_SECRET'),
    adminSecretKey: requireEnv('ADMIN_SECRET_KEY'),
  },
};
