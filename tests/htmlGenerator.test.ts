import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml,
  escapeXml,
  generateRssFeed,
  generateSitemapXml,
  generateWrapperHtml,
  jsonForScriptTag,
} from '../src/utils/htmlGenerator';
import { isValidUrl } from '../src/utils/helpers';
import {
  JOB_TEMPLATE_IDS,
  LIVE_TEMPLATE_IDS,
  TEMPLATES,
  WRAPPER_TEMPLATE_IDS,
  WrapperTemplateId,
  chooseTemplateId,
  isTheme,
  kindOfTemplate,
  labelFromUrl,
  pickTemplateId,
  thumbnailSvg,
} from '../src/utils/wrapperTemplates';

const WRAPPER = 'https://indexer.test/job/abc';

// U+2028 + U+2029, built from code points so no editor/tool turns them into real line breaks
const SEPARATORS = String.fromCharCode(0x2028, 0x2029);

// Every one of these passes isValidUrl, so a user can submit it.
const HOSTILE_URLS = [
  'https://example.com/p"><script>alert(document.domain)</script><a x="',
  'https://example.com/</script><script>alert(1)</script>',
  'https://example.com/?q="><img src=x onerror=alert(1)>',
  "https://example.com/?q='><svg onload=alert(1)>",
  'https://example.com/#"><script>alert(1)</script>',
  'https://example.com/a?x=1&y=2&amp;z=<b>',
  `https://example.com/${SEPARATORS}`,
  'https://x"onmouseover="alert(1).example/',
  "https://x'y.example/",
];

const htmlUnescape = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/** The organization a page's markup names: the hiring organization of a job, the publisher of a livestream */
function orgOf(ld: Record<string, any>): { name: string; sameAs: string } {
  return ld.hiringOrganization ?? ld.publisher;
}

function jsonLdOf(html: string): Record<string, any> {
  const m = /<script type="application\/ld\+json">\n([\s\S]*?)\n  <\/script>/.exec(html);
  assert.ok(m, 'JSON-LD block present');
  return JSON.parse(m[1]);
}

const render = (
  originalUrl: string,
  extra: Partial<Parameters<typeof generateWrapperHtml>[0]> = {}
): string => generateWrapperHtml({ wrapperId: 'abc', originalUrl, wrapperUrl: WRAPPER, ...extra });

// ─── Tag/attribute allow-list: nothing a URL contains can add markup ───────────────

const ALLOWED_TAGS = new Set([
  '!DOCTYPE', 'html', 'head', 'meta', 'title', 'link', 'style', 'script', 'body', 'header', 'nav',
  'ol', 'ul', 'li', 'a', 'main', 'article', 'p', 'h1', 'h2', 'section', 'dl', 'div', 'dt', 'dd',
  'footer', 'time',
]);
const ALLOWED_ATTRIBUTES = new Set([
  'lang', 'charset', 'name', 'content', 'property', 'rel', 'href', 'type', 'class', 'aria-label',
  'aria-current', 'datetime',
]);

/** Every start tag with its attribute names, ignoring the (our own) CSS and JSON-LD bodies. */
function tagsOf(html: string): Array<{ tag: string; attrs: string[] }> {
  const stripped = html
    .replace(/<style>[\s\S]*?<\/style>/g, '<style></style>')
    .replace(/(<script type="application\/ld\+json">)[\s\S]*?(<\/script>)/g, '$1$2');
  const tags: Array<{ tag: string; attrs: string[] }> = [];
  for (const m of stripped.matchAll(/<([a-zA-Z!][^>\s/]*)([^>]*)>/g)) {
    const attrs = m[2]
      .replace(/="[^"]*"/g, '')
      .split(/\s+/)
      .map((a) => a.replace(/\/$/, ''))
      .filter(Boolean);
    tags.push({ tag: m[1], attrs });
  }
  return tags;
}

test('wrapper: a normal URL gets a complete, well-formed page in every template', () => {
  for (const template of WRAPPER_TEMPLATE_IDS) {
    const html = render('https://customer.com/blog/post-1', { template });
    assert.ok(html.includes('<link rel="canonical" href="https://customer.com/blog/post-1" />'), template);
    assert.match(html, /<!DOCTYPE html>\n<html lang="en">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1.0" \/>/);
    assert.match(html, /<meta name="robots" content="index, follow/);
    assert.match(html, /<meta property="og:url" content="https:\/\/customer.com\/blog\/post-1" \/>/);
    assert.equal(count(html, '<h1>'), 1, 'exactly one h1');
    assert.ok(count(html, '<h2>') >= 2, 'has real sections');
    assert.ok(count(html, '<main') === 1 && count(html, '<article>') === 1 && count(html, '<footer') === 1);

    const description = /<meta name="description" content="([^"]*)" \/>/.exec(html);
    assert.ok(description && description[1].length > 40 && description[1].length <= 160, `${template}: description length`);
    const title = /<title>([^<]*)<\/title>/.exec(html);
    assert.ok(title && title[1].length > 10 && title[1].length <= 70, `${template}: title length`);

    const ld = jsonLdOf(html);
    assert.equal(ld.url, 'https://customer.com/blog/post-1');
    assert.equal(orgOf(ld).name, 'customer.com');
    assert.equal(ld.identifier.value, 'abc');

    if (kindOfTemplate(template) === 'job') {
      assert.equal(ld['@type'], 'JobPosting', template);
      for (const field of ['title', 'description', 'datePosted', 'validThrough', 'employmentType', 'jobLocation']) {
        assert.ok(ld[field], `${template}: JSON-LD has ${field}`);
      }
      assert.ok(ld.validThrough > ld.datePosted);
    } else {
      assert.equal(ld['@type'], 'VideoObject', template);
      for (const field of ['name', 'description', 'thumbnailUrl', 'uploadDate', 'embedUrl', 'publication']) {
        assert.ok(ld[field], `${template}: JSON-LD has ${field}`);
      }
      assert.equal(ld.publication['@type'], 'BroadcastEvent');
      assert.equal(ld.publication.isLiveBroadcast, true);
      assert.match(ld.publication.startDate, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.ok(ld.publication.endDate > ld.publication.startDate, 'the broadcast ends after it starts');
      assert.equal(ld.uploadDate, ld.publication.startDate);
      const thumb = `https://indexer.test/thumb/${TEMPLATES[template].theme}.svg`;
      assert.deepEqual(ld.thumbnailUrl, [thumb]);
      assert.ok(html.includes(`<meta property="og:image" content="${thumb}" />`));
    }
  }
});

for (const url of HOSTILE_URLS) {
  test(`wrapper: cannot be broken out of by ${JSON.stringify(url)}`, () => {
    assert.ok(isValidUrl(url), 'precondition: this URL is accepted by submit validation');
    const parsed = new URL(url);
    const href = parsed.href;
    const siteHref = `${parsed.protocol}//${parsed.hostname}`;
    const orgName = parsed.hostname.replace(/^www\./, '');

    for (const deactivated of [false, true]) {
      for (const template of deactivated ? ['listing' as const] : WRAPPER_TEMPLATE_IDS) {
        const html = render(url, { template, deactivated });

        // Nothing the user typed can add a tag, an attribute or a script
        assert.equal(count(html, '<script'), deactivated ? 0 : 1, `${template}: one <script>`);
        assert.equal(count(html, '</script'), deactivated ? 0 : 1, `${template}: one </script>`);
        for (const needle of ['<img', '<svg', '<iframe', '<object', '<form', '<base', '<input']) {
          assert.equal(count(html, needle), 0, `${template}: no ${needle}`);
        }
        for (const { tag, attrs } of tagsOf(html)) {
          assert.ok(ALLOWED_TAGS.has(tag.replace(/^\//, '')), `${template}: unexpected tag <${tag}>`);
          if (tag === '!DOCTYPE') continue; // "html" there is a keyword, not an attribute
          for (const attr of attrs) assert.ok(ALLOWED_ATTRIBUTES.has(attr), `${template}: unexpected attribute "${attr}"`);
        }

        // Every link goes only to the page itself or to its site, and is a whole attribute value
        const links = [...html.matchAll(/<a href="([^"]*)"( rel="noopener")?>/g)];
        assert.equal(links.length, count(html, '<a '), `${template}: every anchor is well-formed`);
        for (const link of links) {
          assert.ok([href, siteHref].includes(htmlUnescape(link[1])), `${template}: link target ${link[1]}`);
        }

        // canonical survives as a single, whole attribute value that decodes to the real URL
        assert.equal(count(html, '<link '), 1, `${template}: one <link>`);
        const canonical = /<link rel="canonical" href="([^"]*)" \/>/.exec(html);
        assert.ok(canonical, `${template}: canonical attribute is well-formed`);
        assert.equal(htmlUnescape(canonical[1]), href);

        if (!deactivated) {
          const ld = jsonLdOf(html);
          assert.equal(ld.url, href);
          assert.equal(orgOf(ld).name, orgName);
          assert.equal(orgOf(ld).sameAs, siteHref);
          assert.ok(html.match(/<h1>(.*)<\/h1>/)![1].includes(escapeHtml(orgName)), `${template}: h1 names the site`);
        }
      }
    }
  });
}

test('wrapper: deactivated page stays noindex', () => {
  const html = render('https://customer.com/p', { deactivated: true });
  assert.match(html, /<meta name="robots" content="noindex, nofollow" \/>/);
});

test('wrapper: the templates really look and read differently', () => {
  const pages = WRAPPER_TEMPLATE_IDS.map((template) => render('https://customer.com/blog/post-1', { template }));
  const distinct = (pick: (html: string) => string): number => new Set(pages.map(pick)).size;

  assert.equal(distinct((h) => /<title>(.*)<\/title>/.exec(h)![1]), WRAPPER_TEMPLATE_IDS.length, 'titles');
  assert.equal(distinct((h) => /<h1>(.*)<\/h1>/.exec(h)![1]), WRAPPER_TEMPLATE_IDS.length, 'h1s');
  assert.equal(distinct((h) => /<p class="lede">(.*)<\/p>/.exec(h)![1]), WRAPPER_TEMPLATE_IDS.length, 'opening paragraphs');
  assert.equal(distinct((h) => jsonLdOf(h).title ?? jsonLdOf(h).name), WRAPPER_TEMPLATE_IDS.length, 'markup titles');
  assert.equal(distinct((h) => jsonLdOf(h).description), WRAPPER_TEMPLATE_IDS.length, 'markup descriptions');
  assert.equal(distinct((h) => /<style>([\s\S]*?)<\/style>/.exec(h)![1]), WRAPPER_TEMPLATE_IDS.length, 'stylesheets');
});

test('wrapper: a livestream page and its BroadcastEvent markup agree', () => {
  const posted = new Date('2026-11-04T10:00:00Z');
  const html = render('https://www.customer.com/news/launch-day', { template: 'live-now', postedAt: posted, now: posted });
  const ld = jsonLdOf(html);
  assert.equal(ld.publication.startDate, '2026-11-04T10:00:00Z');
  assert.equal(ld.publication.endDate, '2026-11-04T11:30:00Z', 'live-now runs 90 minutes');
  assert.ok(html.includes('November 4, 2026, 10:00–11:30 UTC'), 'the window shown to visitors is the window in the markup');
  assert.ok(html.includes('Launch Day'), 'the page name comes from the URL');

  const overnight = render('https://customer.com/p', {
    template: 'live-event',
    postedAt: new Date('2026-11-04T23:30:00Z'),
    now: new Date('2026-11-04T23:30:00Z'),
  });
  assert.ok(overnight.includes('November 4, 2026, 23:30 – November 5, 2026, 01:30 UTC'));
});

test('wrapper: the visible text and the JobPosting markup agree', () => {
  const html = render('https://www.customer.com/careers/senior-engineer', { template: 'profile' });
  const ld = jsonLdOf(html);
  assert.equal(ld.hiringOrganization.name, 'customer.com');
  assert.ok(html.includes('Full-time') && ld.employmentType === 'FULL_TIME');
  assert.ok(html.includes('United States') && ld.jobLocation.address.addressCountry === 'US');
});

test('wrapper: a refresh changes the content, not the posting date', () => {
  const posted = new Date('2026-11-01T10:00:00Z');
  const first = render('https://customer.com/p', { template: 'bulletin', postedAt: posted, now: posted, revision: 0 });
  const refreshed = render('https://customer.com/p', {
    template: 'bulletin',
    postedAt: posted,
    now: new Date('2026-11-02T16:00:00Z'),
    revision: 1,
  });

  assert.notEqual(first, refreshed);
  assert.equal(jsonLdOf(first).datePosted, '2026-11-01');
  assert.equal(jsonLdOf(refreshed).datePosted, '2026-11-01', 'posting date does not move');
  assert.match(first, /<time datetime="2026-11-01">November 1, 2026<\/time>/);
  assert.match(refreshed, /<time datetime="2026-11-02">November 2, 2026<\/time>/);
  assert.notEqual(
    /<p class="lede">(.*)<\/p>/.exec(first)![1],
    /<p class="lede">(.*)<\/p>/.exec(refreshed)![1],
    'the opening paragraph rotates'
  );
  assert.equal(
    render('https://customer.com/p', { template: 'bulletin', postedAt: posted, now: posted, revision: 2 }),
    first,
    'rotation is stable (revision 2 = revision 0)'
  );
});

test('wrapper: the default template is stable per wrapper id', () => {
  const fixed = { now: new Date('2026-11-04T09:00:00Z') };
  assert.equal(render('https://customer.com/p', fixed), render('https://customer.com/p', fixed));
  const ids = new Set(Array.from({ length: 200 }, (_, i) => pickTemplateId(`wrapper-${i}`)));
  assert.equal(ids.size, WRAPPER_TEMPLATE_IDS.length, 'all templates get used across wrappers');
});

test('pickTemplateId: offsets walk through every template once', () => {
  const walk = (offset: number): WrapperTemplateId => pickTemplateId('job-1', offset);
  const seen = new Set(WRAPPER_TEMPLATE_IDS.map((_, i) => walk(i)));
  assert.equal(seen.size, WRAPPER_TEMPLATE_IDS.length);
  assert.equal(walk(0), walk(WRAPPER_TEMPLATE_IDS.length), 'wraps around');
  assert.equal(pickTemplateId('job-1'), walk(0));
  assert.equal(pickTemplateId('job-1', -3), walk(0), 'negative offsets are treated as 0');
});

test('labelFromUrl: readable names from paths, nothing from ids or the home page', () => {
  const label = (u: string): string => labelFromUrl(new URL(u));
  assert.equal(label('https://a.com/blog/getting-started-with-seo.html'), 'Getting Started With Seo');
  assert.equal(label('https://a.com/pricing'), 'Pricing');
  assert.equal(label('https://a.com/Products/iPhone-case'), 'iPhone Case');
  assert.equal(label('https://a.com/blog/2026/11/04/my_first_post/'), 'My First Post');
  assert.equal(label('https://a.com/'), '');
  assert.equal(label('https://a.com/12345'), '');
  assert.equal(label('https://a.com/blog/0f8fad5bd9cb469fa16570867728950e'), 'Blog');
  assert.equal(label('https://a.com/caf%C3%A9-menu'), 'Café Menu');
  assert.equal(label(`https://a.com/${'word-'.repeat(40)}end`).length <= 60, true);
});

test('labelFromUrl: markup characters never survive', () => {
  for (const url of HOSTILE_URLS) {
    const label = labelFromUrl(new URL(url));
    assert.ok(!/[<>"=\\/`]/.test(label), `${JSON.stringify(label)} from ${url}`);
  }
});

test('escapeHtml escapes every HTML-significant character', () => {
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  assert.equal(escapeHtml('plain-text_1/2'), 'plain-text_1/2');
});

test('escapeXml escapes every XML-significant character', () => {
  assert.equal(escapeXml(`<>&"'`), '&lt;&gt;&amp;&quot;&apos;');
});

test('jsonForScriptTag: valid JSON that round-trips, with no raw < > & or line separators', () => {
  const value = { a: '</script><!--', b: 'x&y>z', c: SEPARATORS, d: ['"quoted"', 1, null] };
  const out = jsonForScriptTag(value);
  assert.deepEqual(JSON.parse(out), value);
  assert.ok(!/[<>&]/.test(out));
  assert.ok(!out.includes(SEPARATORS[0]) && !out.includes(SEPARATORS[1]));
});

test('sitemap: each URL carries its real modification time, and values are XML-escaped', () => {
  const xml = generateSitemapXml([
    { url: 'https://indexer.test/job/a?x=1&y=2', lastmod: new Date('2026-11-01T10:00:00Z') },
    { url: 'https://indexer.test/job/b', lastmod: new Date('2026-11-03T08:30:00Z') },
  ]);
  assert.match(xml, /<loc>https:\/\/indexer.test\/job\/a\?x=1&amp;y=2<\/loc>\s*<lastmod>2026-11-01T10:00:00.000Z<\/lastmod>/);
  assert.match(xml, /<loc>https:\/\/indexer.test\/job\/b<\/loc>\s*<lastmod>2026-11-03T08:30:00.000Z<\/lastmod>/);
  assert.ok(!xml.includes('<changefreq>') && !xml.includes('<priority>'), 'Google ignores both');
  assert.match(generateSitemapXml(['https://indexer.test/job/c']), /<loc>https:\/\/indexer.test\/job\/c<\/loc>/);
});

test('rss: items use the real date and an escaped title', () => {
  const rss = generateRssFeed([
    { url: 'https://indexer.test/job/a', lastmod: new Date('2026-11-01T10:00:00Z'), title: 'Opportunity at a&b.com' },
  ]);
  assert.match(rss, /<title>Opportunity at a&amp;b.com<\/title>/);
  assert.match(rss, /<pubDate>Sun, 01 Nov 2026 10:00:00 GMT<\/pubDate>/);
});

// ─── Random template choice ─────────────────────────────────────────────

/** Small seeded generator so these tests are repeatable */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('templates: 5 job and 8 livestream designs, each with its own colours and layout', () => {
  assert.equal(JOB_TEMPLATE_IDS.length, 5);
  assert.equal(LIVE_TEMPLATE_IDS.length, 8);
  for (const id of JOB_TEMPLATE_IDS) assert.equal(TEMPLATES[id].kind, 'job');
  for (const id of LIVE_TEMPLATE_IDS) assert.equal(TEMPLATES[id].kind, 'livestream');
  const looks = new Set(WRAPPER_TEMPLATE_IDS.map((id) => `${TEMPLATES[id].layout}/${TEMPLATES[id].theme}`));
  assert.equal(looks.size, WRAPPER_TEMPLATE_IDS.length, 'no two templates share layout and colour');
});

test('chooseTemplateId: a first wrapper is a job posting or a livestream with equal chance', () => {
  const rng = seeded(1);
  let live = 0;
  const draws = 4000;
  for (let i = 0; i < draws; i++) if (kindOfTemplate(chooseTemplateId([], rng)) === 'livestream') live++;
  assert.ok(live / draws > 0.45 && live / draws < 0.55, `livestream share ${live / draws}`);
});

test('chooseTemplateId: never repeats a design until every design has been used', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const rng = seeded(seed);
    const used: string[] = [];
    for (let i = 0; i < WRAPPER_TEMPLATE_IDS.length; i++) used.push(chooseTemplateId(used, rng));
    assert.equal(new Set(used).size, WRAPPER_TEMPLATE_IDS.length, `seed ${seed}: all ${used.length} distinct`);
    const next = chooseTemplateId(used, rng);
    assert.notEqual(next, used[used.length - 1], 'once all are used, at least not the last one again');
  }
});

test('chooseTemplateId: mostly switches kind, so a job shows Google both shapes', () => {
  const rng = seeded(7);
  let switched = 0;
  let bothWithinFour = 0;
  const runs = 3000;
  for (let i = 0; i < runs; i++) {
    const first = chooseTemplateId([], rng);
    const second = chooseTemplateId([first], rng);
    if (kindOfTemplate(second) !== kindOfTemplate(first)) switched++;

    const used = [first, second];
    used.push(chooseTemplateId(used, rng), chooseTemplateId(used, rng));
    if (new Set(used.map(kindOfTemplate)).size === 2) bothWithinFour++;
  }
  assert.ok(switched / runs > 0.62 && switched / runs < 0.78, `switch rate ${switched / runs}`);
  assert.ok(bothWithinFour / runs > 0.95, `both kinds within 4 wrappers: ${bothWithinFour / runs}`);
});

test('chooseTemplateId: moves to the other kind when one is used up, and ignores unknown names', () => {
  const rng = seeded(3);
  assert.equal(kindOfTemplate(chooseTemplateId([...JOB_TEMPLATE_IDS], rng)), 'livestream');
  assert.equal(kindOfTemplate(chooseTemplateId([...LIVE_TEMPLATE_IDS], rng)), 'job');
  assert.ok((WRAPPER_TEMPLATE_IDS as readonly string[]).includes(chooseTemplateId(['no-such-template', 'listing'], rng)));
});

test('thumbnail: a fixed, text-free SVG per theme; only known themes are served', () => {
  for (const id of LIVE_TEMPLATE_IDS) {
    const svg = thumbnailSvg(TEMPLATES[id].theme);
    assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && svg.endsWith('</svg>'));
    assert.ok(!/<script|onload|href/i.test(svg));
  }
  assert.ok(isTheme('indigo') && isTheme('teal'));
  for (const bad of ['', '__proto__', 'constructor', 'toString', '../etc/passwd', 'INDIGO', undefined, 5]) {
    assert.equal(isTheme(bad), false, String(bad));
  }
});
