import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicIp } from '../src/utils/ipGuard';
import { Semaphore } from '../src/utils/semaphore';
import { isPathAllowed, parseRobotsTxt } from '../src/services/robotsTxt';
import { extractHtmlSignals, robotsValueBlocksIndexing } from '../src/services/htmlSignals';
import { interleaveByHost, urlKey } from '../src/services/preflightService';

// ─── ipGuard ───────────────────────────────────────────────────────────

test('ipGuard: private, loopback, link-local, CGNAT and reserved addresses are not public', () => {
  for (const ip of [
    '127.0.0.1', '127.255.255.255', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '::ffff:10.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', 'fe80::1%eth0',
  ]) {
    assert.equal(isPublicIp(ip), false, `${ip} must not be public`);
  }
});

test('ipGuard: ordinary public addresses are allowed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
    assert.equal(isPublicIp(ip), true, `${ip} must be public`);
  }
});

test('ipGuard: things that are not IP addresses are rejected', () => {
  for (const s of ['', 'localhost', 'example.com', '999.1.1.1', '1.2.3']) assert.equal(isPublicIp(s), false);
});

// ─── Semaphore ─────────────────────────────────────────────────────────

test('Semaphore: never exceeds its limit and serves waiters in order', async () => {
  const sem = new Semaphore(2);
  let running = 0;
  let peak = 0;
  const order: number[] = [];
  await Promise.all(
    Array.from({ length: 6 }, async (_, i) => {
      const release = await sem.acquire();
      order.push(i);
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      release();
      release(); // releasing twice must not hand out an extra permit
    })
  );
  assert.equal(peak, 2);
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5]);
  assert.equal(sem.idle, true);
});

// ─── robots.txt ────────────────────────────────────────────────────────

const allowed = (robots: string, path: string, agent = 'googlebot'): boolean =>
  isPathAllowed(parseRobotsTxt(robots), agent, path);

test('robots.txt: Disallow blocks by prefix, everything else is allowed', () => {
  const r = 'User-agent: *\nDisallow: /private\n';
  assert.equal(allowed(r, '/private'), false);
  assert.equal(allowed(r, '/private/x?y=1'), false);
  assert.equal(allowed(r, '/privately'), false); // prefix match, as Google does
  assert.equal(allowed(r, '/public'), true);
});

test('robots.txt: empty Disallow allows everything; no file content allows everything', () => {
  assert.equal(allowed('User-agent: *\nDisallow:\n', '/anything'), true);
  assert.equal(allowed('', '/anything'), true);
  assert.equal(allowed('# only a comment\n', '/anything'), true);
});

test('robots.txt: "Disallow: /" blocks the whole site', () => {
  assert.equal(allowed('User-agent: *\nDisallow: /\n', '/'), false);
  assert.equal(allowed('User-agent: *\nDisallow: /\n', '/a/b'), false);
});

test('robots.txt: the longest matching rule wins, Allow wins a tie', () => {
  const r = 'User-agent: *\nDisallow: /folder/\nAllow: /folder/page\n';
  assert.equal(allowed(r, '/folder/other'), false);
  assert.equal(allowed(r, '/folder/page'), true);
  assert.equal(allowed(r, '/folder/page.html'), true);
  assert.equal(allowed('User-agent: *\nDisallow: /p\nAllow: /p\n', '/p'), true);
});

test('robots.txt: * wildcard and $ end anchor', () => {
  const r = 'User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp*/cache\n';
  assert.equal(allowed(r, '/files/a.pdf'), false);
  assert.equal(allowed(r, '/files/a.pdf?x=1'), true); // $ = end of URL, the query is part of it
  assert.equal(allowed(r, '/files/a.pdfx'), true);
  assert.equal(allowed(r, '/tmp-1/cache'), false);
  assert.equal(allowed(r, '/ok'), true);
});

test('robots.txt: regex characters in a rule are literal', () => {
  const r = 'User-agent: *\nDisallow: /a.b(c)+?\n';
  assert.equal(allowed(r, '/a.b(c)+?'), false);
  assert.equal(allowed(r, '/aXb(c)+?'), true);
});

test("robots.txt: Googlebot's own group replaces '*', agents are case-insensitive", () => {
  const r = 'User-agent: *\nDisallow: /\n\nuser-agent: GoogleBot\nDisallow: /secret\n';
  assert.equal(allowed(r, '/anything'), true);
  assert.equal(allowed(r, '/secret/x'), false);
  assert.equal(allowed(r, '/anything', 'otherbot'), false);
});

test('robots.txt: several User-agent lines share one group; groups for the same agent merge', () => {
  const shared = 'User-agent: bingbot\nUser-agent: googlebot\nDisallow: /x\n';
  assert.equal(allowed(shared, '/x'), false);
  const merged = 'User-agent: googlebot\nDisallow: /a\n\nUser-agent: googlebot\nDisallow: /b\n';
  assert.equal(allowed(merged, '/a'), false);
  assert.equal(allowed(merged, '/b'), false);
  assert.equal(allowed(merged, '/c'), true);
});

test('robots.txt: comments, CRLF, BOM, Sitemap lines and unknown directives are handled', () => {
  const r = '﻿User-agent: *   # everyone\r\nSitemap: https://x/sitemap.xml\r\nCrawl-delay: 5\r\nDisallow: /no # trailing\r\n';
  assert.equal(allowed(r, '/no'), false);
  assert.equal(allowed(r, '/yes'), true);
});

test('robots.txt: rules before any User-agent are ignored', () => {
  assert.equal(allowed('Disallow: /\nUser-agent: *\nDisallow: /a\n', '/b'), true);
});

// ─── robots meta / X-Robots-Tag ────────────────────────────────────────

test('robots directives: noindex and none block, others do not', () => {
  for (const v of ['noindex', 'NOINDEX', 'none', 'noindex, nofollow', 'index, noindex', ' None ', 'googlebot: noindex', 'unavailable_after: 25 Jun 2010 15:00:00 PST, noindex']) {
    assert.equal(robotsValueBlocksIndexing(v), true, v);
  }
  for (const v of ['', 'index, follow', 'nofollow', 'noarchive', 'nosnippet', 'max-snippet: 20', 'bingbot: noindex', 'otherbot: none']) {
    assert.equal(robotsValueBlocksIndexing(v), false, v);
  }
});

// ─── HTML signals ──────────────────────────────────────────────────────

test('html signals: title, canonical, robots meta in any attribute order and quoting', () => {
  const html = `<html><head>
    <title>  A &amp; B
      page </title>
    <META CONTENT='noindex,nofollow' NAME=robots>
    <link href=/canon rel="Canonical">
    </head><body><p>one two three</p></body></html>`;
  const s = extractHtmlSignals(html);
  assert.equal(s.title, 'A & B page');
  assert.equal(s.metaNoindex, true);
  assert.equal(s.canonical, '/canon');
  assert.equal(s.wordCount, 3);
});

test('html signals: tags inside comments or the body do not count; googlebot meta does', () => {
  assert.equal(extractHtmlSignals('<head><!-- <meta name="robots" content="noindex"> --></head><body></body>').metaNoindex, false);
  assert.equal(extractHtmlSignals('<head></head><body><meta name="robots" content="noindex"></body>').metaNoindex, false);
  assert.equal(extractHtmlSignals('<head><meta name="googlebot" content="noindex"></head>').metaNoindex, true);
  assert.equal(extractHtmlSignals('<head><meta name="bingbot" content="noindex"></head>').metaNoindex, false);
  assert.equal(extractHtmlSignals('<head><link rel="alternate canonical" href="/x"><link rel="canonical" href="/y"></head>').canonical, '/x');
});

test('html signals: word count ignores scripts, styles and markup', () => {
  const s = extractHtmlSignals(
    '<head><title>t</title></head><body><script>var a = "many many words";</script><style>p{color:red}</style><nav>home about</nav><p>Hello&nbsp;world — 2026</p></body>'
  );
  assert.equal(s.wordCount, 5); // home about Hello world 2026 (the dash is not a word)
});

test('html signals: schema.org types from JSON-LD, including @graph, arrays and nested objects', () => {
  const s = extractHtmlSignals(`<head>
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":["VideoObject","Thing"],"publication":{"@type":"BroadcastEvent"}}]}</script>
    <script type="application/ld+json">{ not json </script>
    <script type="application/ld+json">{"@type":"https://schema.org/JobPosting"}</script>
  </head>`);
  assert.deepEqual([...s.jsonLdTypes].sort(), ['BroadcastEvent', 'JobPosting', 'Thing', 'VideoObject', 'WebSite']);
});

test('html signals: garbage in, no throw', () => {
  for (const input of ['', '<', '<<<<>>>>', '<meta', '<title>', '\u0000\u0001', 'x'.repeat(100000)]) {
    assert.doesNotThrow(() => extractHtmlSignals(input));
  }
});

// ─── scheduling helpers ────────────────────────────────────────────────

test('urlKey: same page, different spelling', () => {
  assert.equal(urlKey('HTTPS://Example.com:443/a/#frag'), urlKey('https://example.com/a'));
  assert.equal(urlKey('https://example.com/a/'), urlKey('https://example.com/a'));
  assert.notEqual(urlKey('https://example.com/a?x=1'), urlKey('https://example.com/a'));
  assert.notEqual(urlKey('http://example.com/a'), urlKey('https://example.com/a'));
  assert.notEqual(urlKey('https://www.example.com/a'), urlKey('https://example.com/a'));
  assert.equal(urlKey('nonsense'), null);
});

test('interleaveByHost: round-robin across hosts, every index exactly once', () => {
  const urls = ['https://a.com/1', 'https://a.com/2', 'https://a.com/3', 'https://b.com/1', 'https://c.com/1', 'https://b.com/2', 'junk'];
  const order = interleaveByHost(urls);
  assert.deepEqual([...order].sort((x, y) => x - y), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(order.slice(0, 4).map((i) => urls[i]), ['https://a.com/1', 'https://b.com/1', 'https://c.com/1', 'junk']);
});
