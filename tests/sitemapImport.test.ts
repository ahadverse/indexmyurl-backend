import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../src/config/env';
import { PreflightService } from '../src/services/preflightService';
import { parseSitemap, SitemapImportError, SitemapImportService } from '../src/services/sitemapImportService';
import { startLocalSite, LocalSite } from './helpers/localSite';

let site: LocalSite;
let preflight: PreflightService;
let service: SitemapImportService;
const baseline = { ...env.preflight };

before(async () => {
  site = await startLocalSite();
});
after(async () => {
  Object.assign(env.preflight, baseline);
  preflight?.destroy();
  await site.close();
});
beforeEach(() => {
  Object.assign(env.preflight, baseline, { allowPrivateNetworks: true, timeoutMs: 2000 });
  preflight?.destroy();
  preflight = new PreflightService();
  service = new SitemapImportService(preflight);
});

const at = (path: string): string => `${site.origin}${path}`;
const paths = (urls: string[]): string[] => urls.map((u) => new URL(u).pathname + new URL(u).search);

// ─── parsing ───────────────────────────────────────────────────────────

test('parseSitemap: urlset with entities, CDATA, whitespace and namespace prefixes', () => {
  const xml = `<?xml version="1.0"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://a.com/x?a=1&amp;b=2</loc></url>
      <url><loc>
         https://a.com/spaced
      </loc></url>
      <url><loc><![CDATA[https://a.com/cdata?q=1&b=2]]></loc></url>
      <url><loc>https://a.com/&#233;t&#xE9;</loc></url>
    </urlset>`;
  const r = parseSitemap(xml);
  assert.equal(r.kind, 'urlset');
  assert.deepEqual(r.locs, ['https://a.com/x?a=1&b=2', 'https://a.com/spaced', 'https://a.com/cdata?q=1&b=2', 'https://a.com/été']);

  const prefixed = parseSitemap('<s:urlset xmlns:s="x"><s:url><s:loc>https://a.com/p</s:loc></s:url></s:urlset>');
  assert.deepEqual(prefixed, { kind: 'urlset', locs: ['https://a.com/p'] });
});

test('parseSitemap: sitemap index, plain-text list, and things that are not sitemaps', () => {
  assert.deepEqual(parseSitemap('<sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap></sitemapindex>'), {
    kind: 'index',
    locs: ['https://a.com/s1.xml'],
  });
  assert.deepEqual(parseSitemap('https://a.com/1\r\nhttps://a.com/2\n\n'), { kind: 'text', locs: ['https://a.com/1', 'https://a.com/2'] });
  for (const input of ['', '<html><body>hi</body></html>', 'hello\nworld', '{"a":1}', '<rss><channel/></rss>']) {
    assert.equal(parseSitemap(input).kind, 'unknown', JSON.stringify(input));
  }
});

// ─── importing ─────────────────────────────────────────────────────────

test('import: returns every http(s) page URL, decoded, whatever site it is on; other schemes are ignored', async () => {
  const r = await service.import(at('/sitemap.xml'));
  assert.deepEqual(paths(r.urls), ['/ok', '/404', '/a?x=1&y=2', '/cdata', '/page']);
  assert.equal(r.found, 5);
  assert.equal(r.truncated, false);
  assert.equal(r.sitemaps, 1);
  assert.deepEqual(Object.values(r.hosts), [4, 1]); // four on the sitemap's own site, one elsewhere
});

test("import: a sitemap that lists another website's pages is simply imported", async () => {
  const r = await service.import(at('/sitemap-foreign.xml'));
  assert.deepEqual(r.urls, ['https://elsewhere.example/1', 'https://elsewhere.example/2']);
  assert.deepEqual(r.hosts, { 'elsewhere.example': 2 });
});

test('import: a sitemap index is followed, duplicates removed, a broken child sitemap skipped', async () => {
  const r = await service.import(at('/sitemap-index.xml'));
  assert.deepEqual([...paths(r.urls)].sort(), ['/a1', '/a2', '/b1', '/shared']);
  assert.equal(r.sitemaps, 4); // index + a + b + the missing one (404, skipped)
});

test('import: a sitemap that lists itself does not loop', async () => {
  const r = await service.import(at('/sitemap-loop.xml'));
  assert.deepEqual([...paths(r.urls)].sort(), ['/a1', '/a2', '/shared']);
});

test('import: redirects, .xml.gz files and plain-text sitemaps work', async () => {
  assert.equal((await service.import(at('/sitemap-redirect.xml'))).urls.length, 4);
  assert.deepEqual(paths((await service.import(at('/sitemap.xml.gz'))).urls), ['/gz1', '/gz2']);
  assert.deepEqual(paths((await service.import(at('/sitemap.txt'))).urls), ['/t1', '/t2']);
});

test('import: capped at the configured number of URLs and reports that it was cut', async () => {
  env.preflight.sitemapMaxUrls = 500;
  const r = await service.import(at('/sitemap-huge.xml'));
  assert.equal(r.urls.length, 500);
  assert.equal(r.found, 700);
  assert.equal(r.truncated, true);
});

test('import: sitemap files read are capped', async () => {
  env.preflight.sitemapMaxFiles = 2; // the index and one child
  const r = await service.import(at('/sitemap-index.xml'));
  assert.equal(r.sitemaps, 2);
  assert.equal(r.truncated, true);
});

test('import: errors are specific and user-facing', async () => {
  const fails = async (url: string, pattern: RegExp): Promise<void> => {
    await assert.rejects(
      () => service.import(url),
      (err: unknown) => err instanceof SitemapImportError && pattern.test(err.message),
      url
    );
  };
  await fails('not a url', /not a valid URL/);
  await fails('ftp://x.com/sitemap.xml', /http/);
  await fails(at('/ok'), /does not look like a sitemap/); // an HTML page
  await fails(at('/404'), /not found.*404/i);
  await fails(at('/500'), /HTTP 500/);
  await fails(at('/sitemap-empty.xml'), /No page URLs/);
  await fails(at('/sitemap-broken.xml.gz'), /unpacked/);
  await fails('http://127.0.0.1:1/sitemap.xml', /could not be fetched/);
});

test('import: reports progress as sitemap files are read, and the count of URLs found grows', async () => {
  const seen: Array<{ filesRead: number; filesTotal: number; found: number }> = [];
  await service.import(at('/sitemap-index.xml'), { onProgress: (p) => seen.push({ ...p }) });
  assert.deepEqual(seen[0], { filesRead: 0, filesTotal: 1, found: 0 }, 'announces itself before reading anything');
  const last = seen.at(-1)!;
  assert.equal(last.filesRead, 4);
  assert.equal(last.found, 5); // a lists 3 pages, b lists 2 ("shared" is in both, so it is found twice)
  assert.ok(seen.some((p) => p.filesTotal > 1), 'the total grows once the index has been read');
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i].filesRead >= seen[i - 1].filesRead && seen[i].found >= seen[i - 1].found);
});

test('import: SSRF protection applies (private addresses are never fetched)', async () => {
  env.preflight.allowPrivateNetworks = false;
  const totalHits = (): number => [...site.hits.values()].reduce((a, b) => a + b, 0);
  const before = totalHits();
  for (const target of [at('/sitemap.xml'), 'http://127.0.0.1/sitemap.xml', 'http://169.254.169.254/sitemap.xml', 'http://localhost/sitemap.xml', 'http://[::1]/sitemap.xml']) {
    await assert.rejects(() => service.import(target), SitemapImportError, target);
  }
  assert.equal(totalHits(), before);
});

// ─── scanning a sitemap as if it were a page ───────────────────────────

test('scan: a sitemap URL is a blocker, not a page to index', async () => {
  for (const path of ['/sitemap.xml', '/sitemap-index.xml']) {
    const r = await preflight.checkOne(at(path));
    assert.equal(r.verdict, 'blocked', path);
    assert.deepEqual(r.issues.map((i) => i.code), ['SITEMAP_NOT_A_PAGE'], path);
  }
  // other non-HTML files are still only a note
  assert.deepEqual((await preflight.checkOne(at('/pdf'))).issues.map((i) => i.code), ['NON_HTML']);
});
