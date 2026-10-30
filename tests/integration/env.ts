// Must be the FIRST import of every integration test file: it configures
// process.env before src/config/env.ts reads it.
//
// These tests need a REAL MongoDB and Redis, and they DELETE DATA. So:
//   - the database name in TEST_MONGODB_URI is IGNORED. By default tests create and use a
//     brand-new, randomly named database (indexmenow_it_<id>) and drop it afterwards, so
//     your real database on the same server is never read or modified
//   - to use a specific existing database instead, name it AND confirm it
//     (TEST_DB_NAME=x CONFIRM_WIPE_DB=x): its collections are emptied before and after
//   - the harness refuses to wipe any other database than the one configured here
//   - a non-local MongoDB/Redis needs an explicit ALLOW_REMOTE_TEST_DB=1
//   - the Bull queue uses its own random key prefix, so a shared Redis is safe too
//
//   TEST_MONGODB_URI   default mongodb://127.0.0.1:27017  (may be an Atlas mongodb+srv:// URI)
//   TEST_REDIS_HOST    default 127.0.0.1
//   TEST_REDIS_PORT    default 6379
import crypto from 'crypto';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const allowRemote = process.env.ALLOW_REMOTE_TEST_DB === '1';

const runId = crypto.randomBytes(4).toString('hex');

// Default: a random throwaway database that is dropped afterwards.
// To use a specific database (e.g. an existing dev database you are happy to wipe),
// name it explicitly AND confirm: TEST_DB_NAME=mydb CONFIRM_WIPE_DB=mydb.
// Its collections are emptied before and after the run; the database is not dropped.
const customDb = process.env.TEST_DB_NAME;
if (customDb && process.env.CONFIRM_WIPE_DB !== customDb) {
  throw new Error(
    `TEST_DB_NAME=${customDb} means every collection in "${customDb}" is emptied. ` +
      `Set CONFIRM_WIPE_DB=${customDb} to confirm.`
  );
}
const testDbName = customDb ?? `indexmenow_it_${runId}`;

export const testDatabase = { name: testDbName, disposable: !customDb };

// <scheme+credentials+host> [/<db>] [?<options>]  — swap in the throwaway db name
const uriMatch = /^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/[^?]*)?(\?.*)?$/.exec(
  process.env.TEST_MONGODB_URI ?? 'mongodb://127.0.0.1:27017'
);
if (!uriMatch) throw new Error('TEST_MONGODB_URI is not a valid MongoDB connection string.');
const [, mongoPrefix, mongoOptions = ''] = uriMatch;

const mongoHost = mongoPrefix.replace(/^mongodb(\+srv)?:\/\//, '').replace(/^[^@]*@/, '').replace(/:\d+$/, '');
if (!LOCAL_HOSTS.has(mongoHost) && !allowRemote) {
  throw new Error(
    `Refusing to run integration tests against "${mongoHost}": they create and drop a database. ` +
      'Use a local MongoDB, or set ALLOW_REMOTE_TEST_DB=1 to allow a throwaway database on this server.'
  );
}

const redisHost = process.env.TEST_REDIS_HOST ?? '127.0.0.1';
if (!LOCAL_HOSTS.has(redisHost) && !allowRemote) {
  throw new Error(`Refusing to run integration tests against Redis at "${redisHost}".`);
}

const set = (key: string, value: string): void => {
  process.env[key] = value;
};

set('MONGODB_URI', `${mongoPrefix}/${testDbName}${mongoOptions}`);
set('REDIS_HOST', redisHost);
set('REDIS_PORT', process.env.TEST_REDIS_PORT ?? '6379');
set('REDIS_PASSWORD', '');
set('REDIS_QUEUE_PREFIX', `bull-it-${runId}`);

set('NODE_ENV', 'test');
set('BASE_URL', 'https://indexer.test');
set('FRONTEND_URL', 'https://app.test');
set('GOOGLE_OAUTH_CLIENT_ID', 'test-client-id');
set('GOOGLE_OAUTH_CLIENT_SECRET', 'test-client-secret');
set('JWT_SECRET', 'test-jwt-secret');
set('ADMIN_SECRET_KEY', 'test-admin-key');

// No platform SA from env — tests create ServiceAccount documents themselves
set('PLATFORM_SA_EMAIL', '');
set('PLATFORM_SA_PRIVATE_KEY', '');
set('PLATFORM_SA_PROJECT_ID', '');
set('PLATFORM_GSC_SITE_URL', '');
set('INDEXNOW_KEY', '');

// Fast: no artificial queue delay, first status check immediately
set('QUEUE_MIN_DELAY_MINUTES', '0');
set('QUEUE_MAX_DELAY_MINUTES', '0');
set('INDEX_CHECK_FIRST_AFTER_MINUTES', '0');
set('DOMAIN_CONCURRENT_LIMIT', '3');
set('USER_DAILY_CAP', '50');
set('WRAPPER_EXPIRY_HOURS', '72');
set('MAX_RETRY_COUNT', '3');
set('RETRY_MIN_WAIT_HOURS', '24');
set('FAIL_AFTER_DAYS', '7');
set('MAX_PUBLISH_ATTEMPTS', '5');
set('OAUTH_DAILY_PUBLISH_LIMIT', '180');

// Submit does not scan customer.com & co. (no real network in these tests); the pre-flight
// tests switch enforcement on themselves and point it at a local server.
set('PREFLIGHT_ON_SUBMIT', 'false');

// Individual files may pre-set these (see env.proxy.ts / env.platform.ts)
process.env.PUBLISH_CREDENTIAL_MODE ??= 'platform_first';
process.env.TRUST_PROXY ??= '0';
