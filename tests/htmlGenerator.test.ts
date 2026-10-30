import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, generateWrapperHtml, jsonForScriptTag } from '../src/utils/htmlGenerator';
import { isValidUrl } from '../src/utils/helpers';

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

function jsonLdOf(html: string): Record<string, any> {
  const m = /<script type="application\/ld\+json">\n([\s\S]*?)\n  <\/script>/.exec(html);
  assert.ok(m, 'JSON-LD block present');
  return JSON.parse(m[1]);
}

test('wrapper: a normal URL renders exactly as before', () => {
  const html = generateWrapperHtml({ wrapperId: 'abc', originalUrl: 'https://customer.com/blog/post-1', wrapperUrl: WRAPPER });
  assert.ok(html.includes('<link rel="canonical" href="https://customer.com/blog/post-1" />'));
  assert.match(html, /"@type": "JobPosting"/);
  assert.equal(jsonLdOf(html).url, 'https://customer.com/blog/post-1');
});

for (const url of HOSTILE_URLS) {
  test(`wrapper: cannot be broken out of by ${JSON.stringify(url)}`, () => {
    assert.ok(isValidUrl(url), 'precondition: this URL is accepted by submit validation');
    const href = new URL(url).href;
    const orgName = new URL(url).hostname.replace(/^www\./, '');

    for (const deactivated of [false, true]) {
      const html = generateWrapperHtml({ wrapperId: 'abc', originalUrl: url, wrapperUrl: WRAPPER, deactivated });

      // Nothing the user typed can add a tag: the only <script> is our own JSON-LD block,
      // and the only anchors are the ones in the template.
      assert.equal(count(html, '<script'), deactivated ? 0 : 1, 'one <script>');
      assert.equal(count(html, '</script'), deactivated ? 0 : 1, 'one </script>');
      assert.equal(count(html, '<a '), deactivated ? 1 : 2, 'template anchors only');
      assert.equal(count(html, '<img'), 0);
      assert.equal(count(html, '<svg'), 0);
      assert.equal(count(html, '<link '), 1, 'one <link>');

      // canonical + link survive as a single, whole attribute value that decodes to the real URL
      const canonical = /<link rel="canonical" href="([^"]*)" \/>/.exec(html);
      assert.ok(canonical, 'canonical attribute is well-formed');
      assert.equal(htmlUnescape(canonical[1]), href);

      if (!deactivated) {
        const ld = jsonLdOf(html);
        assert.equal(ld.url, href);
        assert.equal(ld.hiringOrganization.name, orgName);
        assert.equal(html.match(/<h1>(.*)<\/h1>/)![1], `Professional Opportunity at ${escapeHtml(orgName)}`);
      }
    }
  });
}

test('wrapper: deactivated page stays noindex', () => {
  const html = generateWrapperHtml({ wrapperId: 'abc', originalUrl: 'https://customer.com/p', wrapperUrl: WRAPPER, deactivated: true });
  assert.match(html, /<meta name="robots" content="noindex, nofollow" \/>/);
});

test('escapeHtml escapes every HTML-significant character', () => {
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  assert.equal(escapeHtml('plain-text_1/2'), 'plain-text_1/2');
});

test('jsonForScriptTag: valid JSON that round-trips, with no raw < > & or line separators', () => {
  const value = { a: '</script><!--', b: 'x&y>z', c: SEPARATORS, d: ['"quoted"', 1, null] };
  const out = jsonForScriptTag(value);
  assert.deepEqual(JSON.parse(out), value);
  assert.ok(!/[<>&]/.test(out));
  assert.ok(!out.includes(SEPARATORS[0]) && !out.includes(SEPARATORS[1]));
});
