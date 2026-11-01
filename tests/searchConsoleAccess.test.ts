import test, { afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { env } from '../src/config/env';
import { GoogleToken } from '../src/models/GoogleToken';
import { ServiceAccount } from '../src/models/ServiceAccount';
import { googleOAuthService } from '../src/services/googleOAuthService';
import { serviceAccountPool } from '../src/services/serviceAccountPool';
import {
  searchConsoleAccessService as access,
  describeAccessFailure,
} from '../src/services/searchConsoleAccessService';

const userId = new mongoose.Types.ObjectId();
const URL1 = 'https://customer.com/blog/post-1';
const SA = { email: 'indexing@proj.iam.gserviceaccount.com' };

interface Setup {
  tokens?: Array<{ gscProperties: string[] }>;
  brokenToken?: boolean;
  userAccessToken?: string | null;
  serviceAccounts?: Array<{ email: string }>;
  /** what Search Console reports for the service account; a function = different answer per call */
  saProperties?: string[] | null | (() => string[] | null);
}

/** No database, no network: the model queries and the Google calls are faked. */
function arrange(opts: Setup = {}) {
  mock.method(GoogleToken, 'find', () => ({ sort: async () => opts.tokens ?? [] }));
  mock.method(GoogleToken, 'exists', async () => (opts.brokenToken ? { _id: 1 } : null));
  mock.method(googleOAuthService, 'accessTokenFor', async () =>
    opts.userAccessToken === undefined ? 'user-token' : opts.userAccessToken
  );
  mock.method(ServiceAccount, 'find', () => ({ sort: async () => opts.serviceAccounts ?? [] }));
  mock.method(serviceAccountPool, 'getAccessToken', async (a: { email: string }) => `sa-token:${a.email}`);
  const sites = mock.method(googleOAuthService, 'fetchGSCProperties', async () => {
    const p = opts.saProperties;
    return typeof p === 'function' ? p() : p === undefined ? [] : p;
  });
  return { sites };
}

beforeEach(() => access.clearCache());
afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

test("the user's own Google account is used when it has the site", async () => {
  const t = arrange({ tokens: [{ gscProperties: ['sc-domain:customer.com'] }], serviceAccounts: [SA] });
  const r = await access.resolveForUrl(userId, URL1);
  assert.deepEqual(r, {
    ok: true,
    access: { source: 'OAUTH', siteUrl: 'sc-domain:customer.com', accessToken: 'user-token' },
  });
  assert.equal(t.sites.mock.callCount(), 0, 'no call to Google is needed for the OAuth path');
});

test('without a matching Google account, a service account with a role on the site works', async () => {
  arrange({
    tokens: [{ gscProperties: ['sc-domain:other.com'] }],
    serviceAccounts: [SA],
    saProperties: ['https://customer.com/'],
  });
  const r = await access.resolveForUrl(userId, URL1);
  assert.deepEqual(r, {
    ok: true,
    access: {
      source: 'SERVICE_ACCOUNT',
      siteUrl: 'https://customer.com/',
      accessToken: `sa-token:${SA.email}`,
    },
  });
});

test("the platform's own property cannot be claimed through the service account", async () => {
  const before = env.server.baseUrl;
  env.server.baseUrl = 'https://api.platform.test';
  try {
    arrange({ serviceAccounts: [SA], saProperties: ['sc-domain:platform.test', 'sc-domain:customer.com'] });
    const own = await access.resolveForUrl(userId, 'https://platform.test/login');
    assert.deepEqual(own, { ok: false, reason: 'NOT_CONNECTED' });
    const customer = await access.resolveForUrl(userId, URL1);
    assert.equal(customer.ok, true, 'other properties of the same service account still work');
  } finally {
    env.server.baseUrl = before;
  }
});

test('each failure says why', async () => {
  arrange();
  assert.deepEqual(await access.resolveForUrl(userId, URL1), { ok: false, reason: 'NOT_CONNECTED' });

  mock.restoreAll();
  arrange({ tokens: [{ gscProperties: ['sc-domain:other.com'] }] });
  assert.deepEqual(await access.resolveForUrl(userId, URL1), { ok: false, reason: 'NO_PROPERTY' });

  mock.restoreAll();
  arrange({ brokenToken: true });
  assert.deepEqual(await access.resolveForUrl(userId, URL1), { ok: false, reason: 'RECONNECT_NEEDED' });

  mock.restoreAll();
  arrange({ tokens: [{ gscProperties: ['sc-domain:customer.com'] }], userAccessToken: null });
  assert.deepEqual(await access.resolveForUrl(userId, URL1), { ok: false, reason: 'RECONNECT_NEEDED' });

  mock.restoreAll();
  arrange({ serviceAccounts: [SA], saProperties: null });
  assert.deepEqual(await access.resolveForUrl(userId, URL1), { ok: false, reason: 'CHECK_FAILED' });
});

test("a broken Google token falls back to the service account instead of refusing", async () => {
  arrange({
    tokens: [{ gscProperties: ['sc-domain:customer.com'] }],
    userAccessToken: null,
    serviceAccounts: [SA],
    saProperties: ['sc-domain:customer.com'],
  });
  const r = await access.resolveForUrl(userId, URL1);
  assert.equal(r.ok && r.access.source, 'SERVICE_ACCOUNT');
});

test('the service account property list is cached and shared by concurrent submissions', async () => {
  const t = arrange({ serviceAccounts: [SA], saProperties: ['sc-domain:customer.com'] });
  await Promise.all(Array.from({ length: 5 }, () => access.resolveForUrl(userId, URL1)));
  await access.resolveForUrl(userId, URL1);
  assert.equal(t.sites.mock.callCount(), 1);
});

test('a refusal does not hammer Google: the list is re-read at most every 10 seconds', async () => {
  const t = arrange({ serviceAccounts: [SA], saProperties: [] });
  for (let i = 0; i < 5; i++) await access.resolveForUrl(userId, URL1);
  assert.equal(t.sites.mock.callCount(), 1);
});

test('a site added a moment ago is found without waiting for the cache to expire', async () => {
  mock.timers.enable({ apis: ['Date'] });
  let granted = false;
  const t = arrange({ serviceAccounts: [SA], saProperties: () => (granted ? ['sc-domain:customer.com'] : []) });

  assert.equal((await access.resolveForUrl(userId, URL1)).ok, false);
  granted = true; // the user adds the service account in Search Console

  mock.timers.tick(11_000);
  assert.equal((await access.resolveForUrl(userId, URL1)).ok, true);
  assert.equal(t.sites.mock.callCount(), 2);
});

test('"Check access" re-reads Search Console, but not more than every 10 seconds', async () => {
  mock.timers.enable({ apis: ['Date'] });
  const t = arrange({ serviceAccounts: [SA], saProperties: ['sc-domain:customer.com'] });

  await access.resolveForUrl(userId, URL1);
  await access.resolveForUrl(userId, URL1, { refresh: true });
  assert.equal(t.sites.mock.callCount(), 1, 'asked again within 10 seconds');

  mock.timers.tick(11_000);
  await access.resolveForUrl(userId, URL1, { refresh: true });
  assert.equal(t.sites.mock.callCount(), 2);
});

test('a Google hiccup keeps using the last known list instead of locking everyone out', async () => {
  mock.timers.enable({ apis: ['Date'] });
  let answer: string[] | null = ['sc-domain:customer.com'];
  arrange({ serviceAccounts: [SA], saProperties: () => answer });

  assert.equal((await access.resolveForUrl(userId, URL1)).ok, true);
  answer = null;
  mock.timers.tick(6 * 60 * 1000); // cache expired, Google is failing
  assert.equal((await access.resolveForUrl(userId, URL1)).ok, true);
});

test('the address users are told to add comes from the pool, else from the environment', async () => {
  mock.method(ServiceAccount, 'findOne', () => ({ sort: () => ({ select: async () => SA }) }));
  assert.equal(await access.getServiceAccountEmail(), SA.email);

  mock.restoreAll();
  mock.method(ServiceAccount, 'findOne', () => ({ sort: () => ({ select: async () => null }) }));
  const before = env.google.platformSa.email;
  env.google.platformSa.email = 'from-env@proj.iam.gserviceaccount.com';
  try {
    assert.equal(await access.getServiceAccountEmail(), 'from-env@proj.iam.gserviceaccount.com');
    env.google.platformSa.email = '';
    assert.equal(await access.getServiceAccountEmail(), null);
  } finally {
    env.google.platformSa.email = before;
  }
});

test('failure messages tell the user what to do, and only mention our address when we have one', () => {
  const withSa = describeAccessFailure('NOT_CONNECTED', URL1, SA.email);
  assert.match(withSa, /customer\.com/);
  assert.match(withSa, /Connect your Google account/);
  assert.ok(withSa.includes(`add ${SA.email} as a Full user`));

  const withoutSa = describeAccessFailure('NOT_CONNECTED', URL1, null);
  assert.ok(!/Full user/.test(withoutSa));

  assert.match(describeAccessFailure('NO_PROPERTY', URL1, SA.email), /not in the Search Console/);
  assert.match(describeAccessFailure('RECONNECT_NEEDED', URL1, null), /Reconnect/);
  assert.match(describeAccessFailure('CHECK_FAILED', URL1, SA.email), /try again/);
});
