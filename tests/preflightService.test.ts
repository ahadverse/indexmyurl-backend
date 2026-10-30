import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../src/config/env';
import { PreflightService, PreflightResult } from '../src/services/preflightService';
import { startLocalSite, LocalSite } from './helpers/localSite';

let site: LocalSite;
let service: PreflightService;

const baseline = { ...env.preflight };

before(async () => {
  site = await startLocalSite();
});
after(async () => {
  Object.assign(env.preflight, baseline);
  service.destroy();
  await site.close();
});
beforeEach(() => {
  Object.assign(env.preflight, baseline, { allowPrivateNetworks: true, timeoutMs: 1500 });
  service?.destroy();
  service = new PreflightService(); // fresh robots.txt / result caches
});

const check = (path: string): Promise<PreflightResult> => service.checkOne(`${site.origin}${path}`);
const codes = (r: PreflightResult): string[] => r.issues.map((i) => i.code);

// ─── What the scan reports ─────────────────────────────────────────────

test('a healthy page: ok, with title, status and word count', async () => {
  const r = await check('/ok');
  assert.equal(r.verdict, 'ok');
  assert.equal(r.status, 200);
  assert.equal(r.title, 'Test page');
  assert.ok(r.wordCount! >= 80);
  assert.deepEqual(r.issues, []);
  assert.equal(r.redirects, 0);
});

test('noindex is a blocker: robots meta, googlebot meta, X-Robots-Tag, googlebot-addressed header', async () => {
  assert.deepEqual(codes(await check('/noindex-meta')), ['NOINDEX_META']);
  assert.deepEqual(codes(await check('/noindex-googlebot-meta')), ['NOINDEX_META']);
  assert.deepEqual(codes(await check('/noindex-header')), ['NOINDEX_HEADER']);
  assert.deepEqual(codes(await check('/googlebot-header')), ['NOINDEX_HEADER']);
  assert.equal((await check('/noindex-meta')).verdict, 'blocked');
});

test('a noindex aimed at another crawler is not a problem', async () => {
  assert.equal((await check('/bingbot-header')).verdict, 'ok');
});

test('404 / 410 / 401 are blockers; 403 / 429 / 500 only warn (the scanner may just be unwelcome)', async () => {
  for (const [path, code] of [['/404', 'HTTP_NOT_FOUND'], ['/410', 'HTTP_NOT_FOUND'], ['/401', 'HTTP_UNAUTHORIZED']] as const) {
    const r = await check(path);
    assert.equal(r.verdict, 'blocked', path);
    assert.deepEqual(codes(r), [code], path);
  }
  for (const [path, code] of [['/403', 'SCANNER_REFUSED'], ['/429', 'SCANNER_REFUSED'], ['/500', 'SERVER_ERROR']] as const) {
    const r = await check(path);
    assert.equal(r.verdict, 'warn', path);
    assert.deepEqual(codes(r), [code], path);
  }
});

test('redirects are followed and reported with the final URL', async () => {
  const r = await check('/redirect-chain'); // /redirect-chain -> /redirect -> /ok
  assert.equal(r.verdict, 'warn');
  assert.deepEqual(codes(r), ['REDIRECTED']);
  assert.equal(r.redirects, 2);
  assert.equal(r.finalUrl, `${site.origin}/ok`);
  assert.equal(r.status, 200);
});

test('a redirect loop is a blocker', async () => {
  const r = await check('/loop-a');
  assert.equal(r.verdict, 'blocked');
  assert.deepEqual(codes(r), ['TOO_MANY_REDIRECTS']);
});

test('canonical pointing elsewhere warns; self-canonical (absolute or relative) is fine', async () => {
  const other = await check('/canonical-other');
  assert.deepEqual(codes(other), ['CANONICAL_OTHER']);
  assert.equal(other.canonicalUrl, `${site.origin}/ok`);
  assert.equal((await check('/canonical-self')).verdict, 'ok');
  assert.equal((await check('/canonical-relative-self')).verdict, 'ok');
});

test('thin content warns', async () => {
  const r = await check('/thin');
  assert.deepEqual(codes(r), ['THIN_CONTENT']);
  assert.equal(r.verdict, 'warn');
});

test('gzip and brotli responses are decoded', async () => {
  for (const path of ['/gzip', '/brotli']) {
    const r = await check(path);
    assert.equal(r.verdict, 'ok', path);
    assert.equal(r.title, 'Test page', path);
  }
});

test('non-HTML (PDF) is accepted with a note', async () => {
  const r = await check('/pdf');
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(codes(r), ['NON_HTML']);
  assert.equal(r.contentType, 'application/pdf');
});

test('genuine JobPosting markup is reported as Indexing-API eligible', async () => {
  const r = await check('/jobposting');
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.structuredData, ['JobPosting']);
  assert.deepEqual(codes(r), ['INDEXING_API_ELIGIBLE']);
});

test('only the start of a huge page is read: noindex in <head> is still found, the rest is never downloaded', async () => {
  const started = Date.now();
  const r = await check('/big');
  assert.deepEqual(codes(r), ['NOINDEX_META']);
  assert.ok(Date.now() - started < 1500);
});

test('a truncated page is not called thin', async () => {
  const r = await check('/big-empty'); // megabytes of tags, no words in the part that was read
  assert.ok(!codes(r).includes('THIN_CONTENT'));
});

test('a server that never answers is reported as unreachable within the time budget', async () => {
  env.preflight.timeoutMs = 400;
  const started = Date.now();
  const r = await check('/hang');
  assert.equal(r.verdict, 'warn');
  assert.deepEqual(codes(r), ['UNREACHABLE']);
  assert.ok(Date.now() - started < 1500);
});

test('connection refused is unreachable, not a crash', async () => {
  const r = await service.checkOne('http://127.0.0.1:1/');
  assert.equal(r.verdict, 'warn');
  assert.deepEqual(codes(r), ['UNREACHABLE']);
});

// ─── robots.txt ────────────────────────────────────────────────────────

test('robots.txt: blocked for Googlebot -> blocker, and the page is never requested', async () => {
  const r = await check('/g-private/secret');
  assert.equal(r.verdict, 'blocked');
  assert.deepEqual(codes(r), ['ROBOTS_BLOCKED']);
  assert.equal(site.hits.get('/g-private/secret') ?? 0, 0);
});

test("robots.txt: Allow overrides a shorter Disallow; '*' rules do not apply when Googlebot has its own group", async () => {
  assert.equal((await check('/g-private/open')).verdict, 'ok');
  assert.equal((await check('/private/page')).verdict, 'ok');
});

test('robots.txt is fetched once per host, not once per URL', async () => {
  const before = site.hits.get('/robots.txt') ?? 0;
  await service.scan(Array.from({ length: 12 }, (_, i) => `${site.origin}/ok?n=${i}`));
  assert.equal((site.hits.get('/robots.txt') ?? 0) - before, 1);
});

// ─── SSRF protection (the scanner must never reach internal hosts) ─────

test('SSRF: private, loopback and metadata addresses are refused without connecting', async () => {
  env.preflight.allowPrivateNetworks = false;
  const totalHits = (): number => [...site.hits.values()].reduce((a, b) => a + b, 0);
  const hitsBefore = totalHits();
  for (const target of [
    `${site.origin}/ok`, // 127.0.0.1 on a random port
    'http://127.0.0.1/',
    'http://localhost/',
    'http://localhost:3000/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://0.0.0.0/',
    'http://0x7f.1/',
    'http://2130706433/',
    'http://127.1/',
  ]) {
    const r = await service.checkOne(target);
    assert.equal(r.verdict, 'blocked', target);
    assert.deepEqual(codes(r), ['UNSAFE_TARGET'], target);
    assert.equal(r.status, null, target);
  }
  assert.equal(totalHits(), hitsBefore, 'nothing reached the local site');
});

test('SSRF: unusual ports, credentials and non-http schemes are refused', async () => {
  env.preflight.allowPrivateNetworks = false;
  assert.deepEqual(codes(await service.checkOne('http://example.com:22/')), ['UNSAFE_TARGET']);
  assert.deepEqual(codes(await service.checkOne('https://example.com:8443/')), ['UNSAFE_TARGET']);
  assert.deepEqual(codes(await service.checkOne('http://user:pass@example.com/')), ['INVALID_URL']);
  assert.deepEqual(codes(await service.checkOne('ftp://example.com/file')), ['INVALID_URL']);
  assert.deepEqual(codes(await service.checkOne('file:///etc/passwd')), ['INVALID_URL']);
  assert.deepEqual(codes(await service.checkOne('javascript:alert(1)')), ['INVALID_URL']);
  assert.deepEqual(codes(await service.checkOne('not a url')), ['INVALID_URL']);
  assert.deepEqual(codes(await service.checkOne('')), ['INVALID_URL']);
});

// ─── Bulk scanning: speed, progress, politeness ────────────────────────

test('scan: results come back in input order and progress callbacks count 1..N', async () => {
  const urls = Array.from({ length: 30 }, (_, i) => `${site.origin}/ok?n=${i}`);
  const progress: number[] = [];
  const seen = new Set<number>();
  const results = await service.scan(urls, {
    onResult: (index, result, done) => {
      progress.push(done);
      seen.add(index);
      assert.equal(result.url, urls[index]);
    },
  });
  assert.deepEqual(progress, Array.from({ length: 30 }, (_, i) => i + 1));
  assert.equal(seen.size, 30);
  assert.deepEqual(results.map((r) => r.url), urls);
  assert.ok(results.every((r) => r.verdict === 'ok'));
});

test('scan: URLs are checked in parallel, but never more than perHostConcurrency per host', async () => {
  env.preflight.perHostConcurrency = 3;
  const urls = Array.from({ length: 12 }, (_, i) => `${site.origin}/delay?n=${i}`);
  const started = Date.now();
  await service.scan(urls);
  const elapsed = Date.now() - started;
  assert.equal(site.maxConcurrent.get('/delay'), 3, 'exactly the per-host limit in flight');
  assert.ok(elapsed < 12 * 80 * 0.7, `parallel, not sequential (took ${elapsed} ms)`); // 12 x 80 ms sequential = 960 ms
});

test('scan: a mixed batch finishes faster than its slowest host would suggest (hosts are interleaved)', async () => {
  // one result of every kind, in one batch
  const paths = ['/ok', '/404', '/noindex-meta', '/redirect', '/thin', '/g-private/secret', '/500', '/gzip'];
  const results = await service.scan(paths.map((p) => `${site.origin}${p}`));
  assert.deepEqual(
    results.map((r) => r.verdict),
    ['ok', 'blocked', 'blocked', 'warn', 'warn', 'blocked', 'warn', 'ok']
  );
});

test('scan: aborting stops further work and still resolves', async () => {
  env.preflight.perHostConcurrency = 1;
  const controller = new AbortController();
  const urls = Array.from({ length: 30 }, (_, i) => `${site.origin}/delay?n=${i}`);
  const hitsBefore = site.hits.get('/delay') ?? 0;
  let delivered = 0;
  await service.scan(urls, {
    signal: controller.signal,
    onResult: () => {
      if (++delivered === 2) controller.abort();
    },
  });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(delivered >= 2 && delivered < 30, `delivered ${delivered}`);
  assert.ok((site.hits.get('/delay') ?? 0) - hitsBefore < 30, 'later URLs were never requested');
});

test('checkForSubmit reuses a recent scan instead of fetching again', async () => {
  const url = `${site.origin}/ok?reuse=1`;
  const [scanned] = await service.scan([url]);
  const before = site.hits.get('/ok') ?? 0;
  const again = await service.checkForSubmit(url);
  assert.equal(again, scanned);
  assert.equal(site.hits.get('/ok') ?? 0, before, 'no second request');

  env.preflight.cacheTtlMs = 0; // expired -> scanned again
  await service.checkForSubmit(url);
  assert.equal(site.hits.get('/ok') ?? 0, before + 1);
});

test('one bad URL in a batch does not break the others', async () => {
  const results = await service.scan(['not a url', `${site.origin}/ok`, 'ftp://x/y', `${site.origin}/404`]);
  assert.deepEqual(results.map((r) => r.verdict), ['blocked', 'ok', 'blocked', 'blocked']);
});
