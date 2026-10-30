import './env.proxy'; // TRUST_PROXY=1, like production — must come first
import {
  startBackend, stopBackend, resetData, google, inspect, models,
  createServiceAccount, waitFor, past,
} from './harness';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';
import app from '../../src/app';
import { env } from '../../src/config/env';
import { indexingQueue } from '../../src/config/queue';
import { GOOGLE_SCOPES } from '../../src/services/googleOAuthService';

const { UrlJob } = models;

let base = '';
let server: http.Server;
let ipCounter = 0;
/** A fresh client IP per test, so rate-limit buckets don't leak between tests. */
const nextIp = (): string => `10.20.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

interface Res { status: number; headers: Headers; text: string; json: any }
async function call(
  method: string,
  path: string,
  opts: { token?: string; apiKey?: string; body?: unknown; ip?: string; headers?: Record<string, string>; rawBody?: string } = {}
): Promise<Res> {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': opts.ip ?? '10.99.99.99',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.apiKey ? { 'x-api-key': opts.apiKey } : {}),
      ...opts.headers,
    },
    body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, json };
}

async function register(ip = nextIp(), email = `u${Date.now()}${Math.random().toString(36).slice(2, 6)}@test.dev`) {
  const res = await call('POST', '/api/auth/register', {
    ip,
    body: { firstName: 'Ada', lastName: 'Lovelace', email, password: 'correct-horse-battery' },
  });
  assert.equal(res.status, 201, res.text);
  return { token: res.json.token as string, apiKey: res.json.user.apiKey as string, email, ip, id: res.json.user.id as string };
}

describe('HTTP API — real Express app, MongoDB and Redis', () => {
  before(async () => {
    await startBackend();
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await stopBackend();
  });
  beforeEach(resetData);

  // ─── Platform basics ────────────────────────────────────────────────

  it('while Redis is unreachable: /health says so and submissions are refused before anything is charged', async () => {
    const u = await register();
    const redis = indexingQueue.client as unknown as { status: string };
    const original = redis.status;
    redis.status = 'reconnecting'; // what ioredis reports while the connection is down
    try {
      const health = await call('GET', '/health');
      assert.equal(health.status, 503);
      assert.deepEqual([health.json.status, health.json.redis, health.json.mongo], ['degraded', 'down', 'up']);

      const single = await call('POST', '/api/urls/submit', { ip: u.ip, token: u.token, body: { url: 'https://customer.com/a' } });
      const bulk = await call('POST', '/api/urls/submit/bulk', { ip: u.ip, token: u.token, body: { urls: ['https://customer.com/a'] } });
      for (const res of [single, bulk]) {
        assert.equal(res.status, 503, res.text);
        assert.equal(res.json.code, 'QUEUE_UNAVAILABLE');
      }
      assert.equal(await UrlJob.countDocuments(), 0, 'no job was created');
      const me = await call('GET', '/api/auth/me', { ip: u.ip, token: u.token });
      assert.deepEqual([me.json.user.credits, me.json.user.reservedCredits], [5, 0], 'no credit was reserved');
    } finally {
      redis.status = original;
    }
    const back = await call('GET', '/health');
    assert.equal(back.status, 200);
    assert.equal(back.json.redis, 'up');
  });

  it('health check, JSON 404, and a clean 400 for malformed JSON', async () => {
    const health = await call('GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.status, 'ok');

    const missing = await call('GET', '/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.success, false);

    const bad = await call('POST', '/api/auth/login', { rawBody: '{not json' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.success, false);
  });

  it('security headers on, framework banner off, CORS only for the configured frontend', async () => {
    const ok = await call('GET', '/health', { headers: { origin: env.server.frontendUrl } });
    assert.equal(ok.headers.get('access-control-allow-origin'), env.server.frontendUrl);
    assert.equal(ok.headers.get('x-powered-by'), null);
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');

    // With a single configured origin the cors package always answers with that origin;
    // it never echoes the caller's. A browser on another site therefore sees a mismatch and blocks it.
    const evil = await call('GET', '/health', { headers: { origin: 'https://evil.example' } });
    assert.equal(evil.headers.get('access-control-allow-origin'), env.server.frontendUrl);
    assert.notEqual(evil.headers.get('access-control-allow-origin'), 'https://evil.example');
    assert.equal(evil.headers.get('access-control-allow-credentials'), 'true');
  });

  // ─── Accounts ───────────────────────────────────────────────────────

  it('register / login / me, with strict validation and no duplicate accounts', async () => {
    const ip = nextIp();
    const base = { firstName: 'Ada', lastName: 'L', email: 'ada@test.dev', password: 'correct-horse-battery' };

    assert.equal((await call('POST', '/api/auth/register', { ip, body: { ...base, firstName: '' } })).status, 400);
    assert.equal((await call('POST', '/api/auth/register', { ip, body: { ...base, email: 'not-an-email' } })).status, 400);
    assert.equal((await call('POST', '/api/auth/register', { ip, body: { ...base, password: 'short' } })).status, 400);

    const created = await call('POST', '/api/auth/register', { ip, body: base });
    assert.equal(created.status, 201);
    assert.equal(created.json.user.credits, 5);
    assert.equal((await call('POST', '/api/auth/register', { ip, body: base })).status, 409);

    assert.equal((await call('POST', '/api/auth/login', { ip, body: { email: base.email, password: 'wrong-password' } })).status, 401);
    const login = await call('POST', '/api/auth/login', { ip, body: { email: base.email, password: base.password } });
    assert.equal(login.status, 200);

    const me = await call('GET', '/api/auth/me', { ip, token: login.json.token });
    assert.equal(me.json.user.email, base.email);
    assert.equal(me.json.user.availableCredits, 5);
    assert.equal(me.json.user.password, undefined, 'password hash is never returned');
  });

  it('protected routes need a valid token or API key', async () => {
    const ip = nextIp();
    assert.equal((await call('GET', '/api/auth/me', { ip })).status, 401);
    assert.equal((await call('GET', '/api/auth/me', { ip, token: 'garbage' })).status, 401);

    const u = await register(ip);
    assert.equal((await call('GET', '/api/auth/me', { ip, token: u.token })).status, 200);
    assert.equal((await call('GET', '/api/auth/me', { ip, apiKey: u.apiKey })).status, 200);
  });

  // ─── The product flow, over HTTP ────────────────────────────────────

  it('end to end: submit → wrapper served to Googlebot → refresh confirms indexing → credit charged', async () => {
    await createServiceAccount();
    const u = await register();

    const submit = await call('POST', '/api/urls/submit', { ip: u.ip, token: u.token, body: { url: 'https://customer.com/blog/post-1' } });
    assert.equal(submit.status, 201, submit.text);
    const jobId = submit.json.jobId as string;

    // duplicate submission is refused
    const dup = await call('POST', '/api/urls/submit', { ip: u.ip, token: u.token, body: { url: 'https://customer.com/blog/post-1' } });
    assert.equal(dup.status, 400);
    assert.match(dup.json.message, /already submitted/);

    const status = await waitFor(async () => {
      const r = await call('GET', `/api/urls/status/${jobId}`, { ip: u.ip, token: u.token });
      return r.json?.job?.status === 'WAITING_CRAWL' ? r : null;
    }, 'job to be published');
    assert.equal(status.json.job.credentialSource, 'SERVICE_ACCOUNT');

    const list = await call('GET', '/api/urls/jobs', { ip: u.ip, token: u.token });
    assert.equal(list.json.pagination.total, 1);
    assert.equal(list.json.jobs[0].originalUrl, 'https://customer.com/blog/post-1');

    // what Googlebot fetches
    const job = await UrlJob.findById(jobId);
    const wrapperPath = new URL(job!.wrapperUrl!).pathname;
    const page = await call('GET', wrapperPath);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type')!, /text\/html/);
    assert.match(page.headers.get('cache-control')!, /no-store/);
    assert.match(page.text, /"@type": "JobPosting"/);
    assert.equal(page.headers.get('x-robots-tag'), null, 'an active wrapper must be indexable');

    const sitemap = await call('GET', '/sitemap.xml');
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.headers.get('content-type')!, /xml/);
    assert.ok(sitemap.text.includes(job!.wrapperUrl!));
    assert.ok((await call('GET', '/rss.xml')).text.includes(job!.wrapperUrl!));
    const robots = await call('GET', '/robots.txt');
    assert.match(robots.text, /Sitemap: https:\/\/indexer\.test\/sitemap\.xml/);

    // Google now says it is indexed; the user presses "refresh"
    google.onInspect = () => inspect.indexed;
    const refreshed = await call('POST', `/api/urls/status/${jobId}/refresh`, { ip: u.ip, token: u.token });
    assert.equal(refreshed.json.status, 'INDEXED', refreshed.text);

    const me = await call('GET', '/api/auth/me', { ip: u.ip, token: u.token });
    assert.deepEqual([me.json.user.credits, me.json.user.reservedCredits], [4, 0]);

    // retired wrapper is served as noindex
    const retired = await call('GET', wrapperPath);
    assert.equal(retired.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.match(retired.text, /no longer active/);
    assert.equal((await call('GET', '/job/doesnotexist')).status, 404);

    assert.deepEqual(google.blockedCalls, []);
  });

  it('/urls/all: one row per URL with the current status and how many times it was tried', async () => {
    const u = await register();
    const other = await register();
    const at = (day: number) => new Date(Date.UTC(2026, 0, day));
    const base = { userId: u.id, domain: 'customer.com' };
    const A = 'https://customer.com/a-page';

    // A: failed twice before reaching Google, then re-sent twice and failed, then submitted again and indexed
    await UrlJob.create({ ...base, originalUrl: A, status: 'FAILED', publishAttempts: 2, createdAt: at(1) });
    await UrlJob.create({ ...base, originalUrl: A, status: 'FAILED', publishAttempts: 1, retryCount: 2, apiCalledAt: at(3), createdAt: at(2) });
    await UrlJob.create({
      ...base, originalUrl: A, status: 'INDEXED', apiCalledAt: at(5), indexedAt: at(6), createdAt: at(4),
      indexCheckResults: [{ checkedAt: at(5), status: 'NOT_FOUND', source: 'GSC_API' }, { checkedAt: at(6), status: 'INDEXED', source: 'GSC_API' }],
    });
    await UrlJob.create({ ...base, originalUrl: 'https://customer.com/b-page', status: 'QUEUED', createdAt: at(7) });
    await UrlJob.create({ userId: other.id, domain: 'customer.com', originalUrl: A, status: 'QUEUED', createdAt: at(8) }); // someone else's

    const all = await call('GET', '/api/urls/all', { ip: u.ip, token: u.token });
    assert.equal(all.status, 200, all.text);
    assert.deepEqual(all.json.urls.map((r: any) => r.url), ['https://customer.com/b-page', A], 'newest first');
    const a = all.json.urls[1];
    assert.deepEqual(
      { status: a.status, submissions: a.submissions, googleSubmissions: a.googleSubmissions, failedCalls: a.failedCalls, checks: a.checks },
      { status: 'INDEXED', submissions: 3, googleSubmissions: 4, failedCalls: 3, checks: 2 }
    );
    assert.deepEqual(all.json.counts, { INDEXED: 1, QUEUED: 1 });
    assert.equal(all.json.pagination.total, 2);

    const q = (qs: string) => call('GET', `/api/urls/all?${qs}`, { ip: u.ip, token: u.token });
    assert.deepEqual((await q('status=QUEUED')).json.urls.map((r: any) => r.url), ['https://customer.com/b-page']);
    assert.equal((await q('status=QUEUED,INDEXED')).json.pagination.total, 2, 'several statuses at once');
    assert.equal((await q('status=bogus')).json.pagination.total, 2, 'unknown statuses are ignored');
    assert.deepEqual((await q('search=A-PAGE')).json.urls.map((r: any) => r.url), [A]);
    assert.equal((await q('search=.*')).json.pagination.total, 0, 'the search is literal text, not a pattern');
    assert.equal((await q('sort=submissions')).json.urls[0].url, A);
    const paged = await q('limit=1&page=2');
    assert.deepEqual([paged.json.urls.length, paged.json.pagination.totalPages], [1, 2]);
    assert.equal((await call('GET', '/api/urls/all', { ip: other.ip, token: other.token })).json.pagination.total, 1);
    assert.equal((await call('GET', '/api/urls/all')).status, 401);
  });

  it("users can't see each other's jobs", async () => {
    await createServiceAccount();
    const a = await register();
    const b = await register();
    const submit = await call('POST', '/api/urls/submit', { ip: a.ip, token: a.token, body: { url: 'https://customer.com/private' } });
    const jobId = submit.json.jobId;

    assert.equal((await call('GET', `/api/urls/status/${jobId}`, { ip: b.ip, token: b.token })).status, 404);
    assert.equal((await call('POST', `/api/urls/status/${jobId}/refresh`, { ip: b.ip, token: b.token })).status, 404);
    assert.equal((await call('GET', '/api/urls/jobs', { ip: b.ip, token: b.token })).json.pagination.total, 0);
    assert.equal((await call('GET', '/api/urls/status/not-an-id', { ip: b.ip, token: b.token })).status, 400);
  });

  // ─── Rate limiting behind the proxy ─────────────────────────────────

  it('rate limits are per real client IP behind the proxy (TRUST_PROXY=1), not one bucket for everyone', async () => {
    const attacker = nextIp();
    const bystander = nextIp();
    const bad = { email: 'nobody@test.dev', password: 'whatever-it-is' };

    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await call('POST', '/api/auth/login', { ip: attacker, body: bad })).status);
    assert.deepEqual(codes.slice(0, 20), Array(20).fill(401));
    assert.equal(codes[20], 429, 'the 21st attempt from the same IP is blocked');

    // a different person is not affected by the attacker's lockout
    assert.equal((await call('POST', '/api/auth/login', { ip: bystander, body: bad })).status, 401);
  });

  // ─── Admin & config ─────────────────────────────────────────────────

  it('admin endpoints need the admin key', async () => {
    await createServiceAccount();
    const ip = nextIp();
    assert.equal((await call('GET', '/api/admin/service-accounts', { ip })).status, 403);
    assert.equal((await call('GET', '/api/admin/service-accounts', { ip, headers: { 'x-admin-key': 'wrong' } })).status, 403);

    const ok = await call('GET', '/api/admin/service-accounts', { ip, headers: { 'x-admin-key': 'test-admin-key' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.totalAccounts, 1);
    assert.equal(ok.json.accounts[0].privateKey, undefined, 'private keys are never exposed');
  });

  it('OAuth: login URL asks for the Indexing scope in default mode; /accounts reports the mode', async () => {
    const login = await call('GET', '/api/oauth/google/login-url', { ip: nextIp() });
    const scope = new URL(login.json.url).searchParams.get('scope')!;
    assert.ok(scope.includes('auth/indexing'));
    assert.ok(scope.includes('webmasters.readonly'));
    assert.deepEqual(scope.split(' '), GOOGLE_SCOPES);

    const u = await register();
    const accounts = await call('GET', '/api/oauth/google/accounts', { ip: u.ip, token: u.token });
    assert.equal(accounts.json.publishCredentialMode, 'platform_first');
    assert.equal(accounts.json.hasGoogleConnected, false);
    assert.equal((await call('GET', '/api/oauth/google/accounts', { ip: u.ip })).status, 401);
  });

  it('IndexNow key file is served only when a key is configured', async () => {
    assert.equal((await call('GET', '/indexnow.txt')).status, 404);
    env.indexNow.key = 'abcdef0123456789';
    const served = await call('GET', '/indexnow.txt');
    assert.equal(served.status, 200);
    assert.equal(served.text, 'abcdef0123456789');
  });
});
