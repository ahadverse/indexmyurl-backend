import { env } from '../config/env';

interface WrapperOptions {
  wrapperId: string;
  originalUrl: string;
  wrapperUrl: string;
  deactivated?: boolean;
}

// U+2028/U+2029 are legal in JSON but were line terminators inside JS strings before ES2019
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** Escape for HTML text and double-quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * JSON for an inline <script type="application/ld+json"> block. A raw "<" would let a
 * "</script>" inside a value close the block, so these characters are \u-escaped
 * (still valid JSON, parsed back to the same value).
 */
export function jsonForScriptTag(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .split(LINE_SEPARATOR).join('\\u2028')
    .split(PARAGRAPH_SEPARATOR).join('\\u2029');
}

/** The URL as the browser/Googlebot will request it (host lower-cased, unsafe chars percent-encoded). */
function normalizedHref(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

export function generateWrapperHtml(opts: WrapperOptions): string {
  const { originalUrl, wrapperUrl, deactivated = false } = opts;

  if (deactivated) {
    const href = escapeHtml(normalizedHref(originalUrl));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Page No Longer Available</title>
  <meta name="robots" content="noindex, nofollow" />
  <link rel="canonical" href="${href}" />
</head>
<body>
  <p>This listing is no longer active. <a href="${href}">View original page</a>.</p>
</body>
</html>`;
  }

  const parsedUrl = new URL(originalUrl);
  const orgName = parsedUrl.hostname.replace(/^www\./, '');
  // User-controlled values, escaped for the HTML context they are placed in below
  const href = escapeHtml(parsedUrl.href);
  const orgNameHtml = escapeHtml(orgName);
  const siteHref = escapeHtml(`${parsedUrl.protocol}//${parsedUrl.hostname}`);
  const datePosted = new Date().toISOString().split('T')[0];
  const validThrough = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];

  const jsonLd = {
    '@context': 'https://schema.org/',
    '@type': 'JobPosting',
    title: 'Professional Opportunity',
    description:
      'A new professional opportunity is available. Please visit the original listing for complete details.',
    datePosted,
    validThrough,
    employmentType: 'FULL_TIME',
    hiringOrganization: {
      '@type': 'Organization',
      name: orgName,
      sameAs: `${parsedUrl.protocol}//${parsedUrl.hostname}`,
    },
    jobLocation: {
      '@type': 'Place',
      address: { '@type': 'PostalAddress', addressCountry: 'US' },
    },
    url: parsedUrl.href,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Job Opportunity at ${orgNameHtml}</title>
  <link rel="canonical" href="${href}" />
  <meta name="robots" content="index, follow" />
  <script type="application/ld+json">
${jsonForScriptTag(jsonLd)}
  </script>
</head>
<body>
  <main>
    <h1>Professional Opportunity at ${orgNameHtml}</h1>
    <p>
      View the complete details at the
      <a href="${href}" rel="noopener">original listing page</a>.
    </p>
    <p>
      This opportunity is posted by
      <a href="${siteHref}">${orgNameHtml}</a>.
    </p>
  </main>
</body>
</html>`;
}

export function generateSitemapXml(urls: string[]): string {
  const now = new Date().toISOString();
  const entries = urls
    .map(
      (url) =>
        `  <url>\n    <loc>${url}</loc>\n    <lastmod>${now}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.8</priority>\n  </url>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>`;
}

export function generateRssFeed(urls: string[]): string {
  const now = new Date().toUTCString();
  const items = urls
    .map(
      (url) =>
        `    <item>\n      <title>Job Listing Update</title>\n      <link>${url}</link>\n      <pubDate>${now}</pubDate>\n      <guid isPermaLink="true">${url}</guid>\n    </item>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
  <channel>
    <title>IndexMeNow Listings</title>
    <link>${env.server.baseUrl}</link>
    <description>Latest listing updates</description>
    <lastBuildDate>${now}</lastBuildDate>
${items}
  </channel>
</rss>`;
}
