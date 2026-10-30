import './env.proxy'; // TRUST_PROXY=1 — must come first
import { startBackend, stopBackend, resetData, createServiceAccount, models } from './harness';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';
import app from '../../src/app';
import { env } from '../../src/config/env';
import { preflightService } from '../../src/services/preflightService';
import { startLocalSite, LocalSite } from '../helpers/localSite';
import { readSseEvents, SseEvent } from '../helpers/sse';

const { UrlJob } = models;

let base = '';
let server: http.Server;
let site: LocalSite;
let ipCounter = 0;
const nextIp = (): string => `10.40.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

interface User { token: string; ip: string }

async function register(): Promise<User> {
  const ip = nextIp();
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ firstName: 'Ada', lastName: 'Lovelace', email: `u${Date.now()}${ipCounter}@test.dev`, password: 'correct-horse-battery' }),
  });
  assert.equal(res.status, 201);
  return { token: (await res.json()).token, ip };
}

const post = (path: string, u: Partial<User>, body: unknown): Promise<Response> =>
  fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': u.ip ?? '10.99.99.99',
      ...(u.token ? { authorization: `Bearer ${u.token}` } : {}),
    },
    body: JSON.stringify(body),
  });

/** Call an SSE endpoint; also returns the response for header checks. */
async function stream(path: string, u: User, body: unknown): Promise<{ res: Response; events: SseEvent[] }> {
  const t0 = Date.now();
  const res = await post(path, u, body);
  assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/, `expected a stream, got ${res.status}`);
  return { res, events: await readSseEvents(res, t0) };
}

const me = async (u: User) =>
  (await (await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${u.token}`, 'x-forwarded-for': u.ip } })).json()).user;

describe('pre-flight scan — real Express app, MongoDB and Redis, local website, fake Google', () => {
  before(async () => {
    site = await startLocalSite();
    await startBackend();
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    preflightService.destroy();
    await new Promise((r) => server.close(r));
    await stopBackend();
    await site.close();
  });
  beforeEach(async () => {
    await resetData(); // also restores env.preflight to the test defaults
    await createServiceAccount();
  });

  /** Scan the local website, submit for real. */
  const scanLocal = (): void => {
    env.preflight.allowPrivateNetworks = true;
    env.preflight.enforceOnSubmit = true;
  };

  it('/preflight needs a login and validates its input', async () => {
    assert.equal((await post('/api/urls/preflight', {}, { urls: ['https://x.com'] })).status, 401);
    const u = await register();
    for (const body of [{}, { urls: [] }, { urls: 'https://x.com' }, { urls: [42] }]) {
      const res = await post('/api/urls/preflight', u, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((await res.json()).success, false);
    }
  });

  it('streams progress through the real middleware stack (compression, helmet, CORS), results before the end', async () => {
    scanLocal();
    const u = await register();
    const { res, events } = await stream('/api/urls/preflight', u, {
      urls: [`${site.origin}/ok`, `${site.origin}/slower`, `${site.origin}/404`, `${site.origin}/noindex-meta`],
    });

    assert.equal(res.headers.get('content-encoding'), null, 'an event stream must not be compressed/buffered');
    assert.match(res.headers.get('cache-control')!, /no-transform/);
    assert.equal(res.headers.get('x-accel-buffering'), 'no');

    assert.deepEqual(events.map((e) => e.type), ['start', 'result', 'result', 'result', 'result', 'done']);
    const results = events.filter((e) => e.type === 'result');
    assert.deepEqual(results.map((e) => e.done), [1, 2, 3, 4]);
    const slow = results.find((e) => e.result.url.endsWith('/slower'))!;
    assert.equal(slow.done, 4, 'the slow URL finishes last');
    assert.ok(results.filter((e) => e !== slow).every((e) => e.at < slow.at - 200), 'quick URLs were reported while the slow one was still running');

    const done = events.at(-1)!;
    assert.deepEqual({ ok: done.ok, warn: done.warn, blocked: done.blocked }, { ok: 2, warn: 0, blocked: 2 });
  });

  it('submit refuses unindexable URLs before they cost a credit, and lets good ones through', async () => {
    scanLocal();
    const u = await register();

    for (const [path, code] of [['/404', 'HTTP_NOT_FOUND'], ['/noindex-meta', 'NOINDEX_META'], ['/g-private/secret', 'ROBOTS_BLOCKED']] as const) {
      const res = await post('/api/urls/submit', u, { url: `${site.origin}${path}` });
      const body = await res.json();
      assert.equal(res.status, 422, path);
      assert.equal(body.code, 'PREFLIGHT_BLOCKED');
      assert.deepEqual(body.issues.map((i: any) => i.code), [code], path);
      assert.match(body.message, /\w/);
    }
    assert.equal(await UrlJob.countDocuments(), 0, 'no job was created');
    let user = await me(u);
    assert.deepEqual([user.credits, user.reservedCredits], [5, 0], 'no credit was reserved');

    const ok = await post('/api/urls/submit', u, { url: `${site.origin}/ok` });
    assert.equal(ok.status, 201, await ok.text());
    user = await me(u);
    assert.equal(user.reservedCredits, 1);
  });

  it('a warning (here: a redirect) does not block submission', async () => {
    scanLocal();
    const u = await register();
    const res = await post('/api/urls/submit', u, { url: `${site.origin}/redirect` });
    assert.equal(res.status, 201, await res.text());
  });

  it('submit reuses the scan the dashboard just did: the page is fetched once, not twice', async () => {
    scanLocal();
    const u = await register();
    const url = `${site.origin}/ok?reuse=1`;
    await stream('/api/urls/preflight', u, { urls: [url] });
    const before = site.hits.get('/ok') ?? 0;
    const res = await post('/api/urls/submit', u, { url });
    assert.equal(res.status, 201, await res.text());
    assert.equal(site.hits.get('/ok') ?? 0, before, 'submit did not fetch the page again');
  });

  it('with enforcement off, submit behaves as before', async () => {
    env.preflight.allowPrivateNetworks = true;
    env.preflight.enforceOnSubmit = false;
    const u = await register();
    const res = await post('/api/urls/submit', u, { url: `${site.origin}/404` });
    assert.equal(res.status, 201, await res.text());
  });

  it('SSRF: nothing internal can be reached through scan or submit', async () => {
    env.preflight.enforceOnSubmit = true; // allowPrivateNetworks stays false, as in production
    const u = await register();
    const hitsBefore = [...site.hits.values()].reduce((a, b) => a + b, 0);

    const targets = [`${site.origin}/ok`, 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://localhost/', 'http://[::1]/', 'http://10.0.0.1/'];
    const { events } = await stream('/api/urls/preflight', u, { urls: targets });
    const results = events.filter((e) => e.type === 'result');
    assert.equal(results.length, targets.length);
    for (const e of results) {
      assert.equal(e.result.verdict, 'blocked', e.result.url);
      assert.deepEqual(e.result.issues.map((i: any) => i.code), ['UNSAFE_TARGET'], e.result.url);
    }

    const res = await post('/api/urls/submit', u, { url: 'http://169.254.169.254/latest/meta-data/' });
    assert.equal(res.status, 422);
    assert.equal(await UrlJob.countDocuments(), 0);
    assert.equal([...site.hits.values()].reduce((a, b) => a + b, 0), hitsBefore, 'the local website was never contacted');
  });

  it('/sitemap lists the pages of a sitemap, needs a login, and reports problems as a 400 with a reason', async () => {
    scanLocal();
    assert.equal((await post('/api/urls/sitemap', {}, { url: `${site.origin}/sitemap.xml` })).status, 401);

    const u = await register();
    const ok = await stream('/api/urls/sitemap', u, { url: `${site.origin}/sitemap.xml` });
    assert.deepEqual([ok.events[0].type, ok.events.at(-1)!.type], ['start', 'done']);
    assert.ok(ok.events.some((e) => e.type === 'progress'), 'progress is streamed');
    const body = ok.events.at(-1)!;
    assert.deepEqual(body.urls.map((x: string) => new URL(x).pathname), ['/ok', '/404', '/a', '/cdata', '/page']);
    assert.deepEqual([body.found, body.truncated], [5, false]);

    // pages on another website are imported like any other
    const foreign = await stream('/api/urls/sitemap', u, { url: `${site.origin}/sitemap-foreign.xml` });
    assert.deepEqual([foreign.events.at(-1)!.type, foreign.events.at(-1)!.urls.length], ['done', 2]);

    const notSitemap = await stream('/api/urls/sitemap', u, { url: `${site.origin}/ok` });
    assert.match(notSitemap.events.at(-1)!.message, /does not look like a sitemap/);
    assert.equal((await post('/api/urls/sitemap', u, {})).status, 400);

    // a sitemap pasted into the scanner is refused as a "page", and never costs a credit
    const scanned = await stream('/api/urls/preflight', u, { urls: [`${site.origin}/sitemap.xml`] });
    const result = scanned.events.find((e) => e.type === 'result')!.result;
    assert.deepEqual([result.verdict, result.issues.map((i: any) => i.code)], ['blocked', ['SITEMAP_NOT_A_PAGE']]);
    const submit = await post('/api/urls/submit', u, { url: `${site.origin}/sitemap.xml` });
    assert.equal(submit.status, 422);
  });

  it('bulk submit streams per-URL outcomes, refuses the unindexable ones and reserves one credit per queued URL', async () => {
    scanLocal();
    const u = await register();
    const { events } = await stream('/api/urls/submit/bulk', u, {
      urls: [`${site.origin}/ok?a=1`, `${site.origin}/ok?a=2`, `${site.origin}/404`, `${site.origin}/ok?a=1#again`],
    });

    assert.equal(events[0].type, 'start');
    assert.equal(events[0].total, 3);
    assert.equal(events[0].duplicates, 1);
    const results = events.filter((e) => e.type === 'result');
    assert.deepEqual(results.map((e) => e.done).sort(), [1, 2, 3]);

    const byUrl = new Map(results.map((e) => [new URL(e.url).pathname + new URL(e.url).search, e]));
    assert.equal(byUrl.get('/ok?a=1')!.success, true);
    assert.equal(byUrl.get('/ok?a=2')!.success, true);
    assert.equal(byUrl.get('/404')!.success, false);
    assert.equal(byUrl.get('/404')!.code, 'PREFLIGHT_BLOCKED');

    const done = events.at(-1)!;
    assert.deepEqual({ type: done.type, submitted: done.submitted, alreadyIndexed: done.alreadyIndexed, failed: done.failed }, { type: 'done', submitted: 2, alreadyIndexed: 0, failed: 1 });

    assert.equal(await UrlJob.countDocuments(), 2);
    const user = await me(u);
    assert.deepEqual([user.credits, user.reservedCredits], [5, 2]);
  });

  it('bulk submit: input is validated, the URL cap is enforced, and running out of credits stops the rest', async () => {
    scanLocal();
    const u = await register();
    assert.equal((await post('/api/urls/submit/bulk', {}, { urls: ['https://x.com'] })).status, 401);
    assert.equal((await post('/api/urls/submit/bulk', u, { urls: [] })).status, 400);
    const tooMany = await post('/api/urls/submit/bulk', u, { urls: Array.from({ length: 51 }, (_, i) => `${site.origin}/ok?n=${i}`) });
    assert.equal(tooMany.status, 400);
    assert.match((await tooMany.json()).message, /At most 50/);

    // more URLs than credits: the first five are queued, the rest are refused one by one
    const { events } = await stream('/api/urls/submit/bulk', u, {
      urls: Array.from({ length: 7 }, (_, i) => `${site.origin}/ok?credit=${i}`),
    });
    const done = events.at(-1)!;
    assert.deepEqual({ submitted: done.submitted, failed: done.failed }, { submitted: 5, failed: 2 });
    assert.ok(events.filter((e) => e.type === 'result' && !e.success).every((e) => /credit/i.test(e.message)));
    assert.equal((await me(u)).reservedCredits, 5);
  });
});
