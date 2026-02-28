import { env } from '../config/env';

interface WrapperOptions {
  wrapperId: string;
  originalUrl: string;
  wrapperUrl: string;
  deactivated?: boolean;
}

export function generateWrapperHtml(opts: WrapperOptions): string {
  const { originalUrl, wrapperUrl, deactivated = false } = opts;

  if (deactivated) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Page No Longer Available</title>
  <meta name="robots" content="noindex, nofollow" />
  <link rel="canonical" href="${originalUrl}" />
</head>
<body>
  <p>This listing is no longer active. <a href="${originalUrl}">View original page</a>.</p>
</body>
</html>`;
  }

  const parsedUrl = new URL(originalUrl);
  const orgName = parsedUrl.hostname.replace(/^www\./, '');
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
    url: originalUrl,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Job Opportunity at ${orgName}</title>
  <link rel="canonical" href="${originalUrl}" />
  <meta name="robots" content="index, follow" />
  <script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2)}
  </script>
</head>
<body>
  <main>
    <h1>Professional Opportunity at ${orgName}</h1>
    <p>
      View the complete details at the
      <a href="${originalUrl}" rel="noopener">original listing page</a>.
    </p>
    <p>
      This opportunity is posted by
      <a href="${parsedUrl.protocol}//${parsedUrl.hostname}">${orgName}</a>.
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
