import { env } from '../config/env';
import {
  Block,
  Seg,
  TEMPLATES,
  TemplateContext,
  WrapperTemplateId,
  labelFromUrl,
  pickTemplateId,
  templateCss,
} from './wrapperTemplates';

interface WrapperOptions {
  wrapperId: string;
  originalUrl: string;
  wrapperUrl: string;
  deactivated?: boolean;
  /** Which design to use. Default: one picked from the wrapper id. */
  template?: WrapperTemplateId;
  /** How many times the page has been refreshed (0 = first version). Varies the opening paragraph. */
  revision?: number;
  /** When the wrapper was first published (the JobPosting's datePosted). Default: now. */
  postedAt?: Date;
  /** When this version of the page was generated ("last updated"). Default: now. */
  now?: Date;
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

/** Escape for XML text (sitemap and RSS values). */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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
/** Scheme + host of a URL, or '' when it cannot be parsed */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function normalizedHref(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDate = (date: Date): string => date.toISOString().split('T')[0];
/** ISO 8601 with a time zone and no milliseconds ("2026-11-04T10:00:00Z") */
const isoDateTime = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
const clock = (date: Date): string => date.toISOString().slice(11, 16);
const humanDate = (date: Date): string =>
  new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(date);

/** "November 4, 2026, 10:00–11:30 UTC" (both dates when the window crosses midnight) */
function windowText(start: Date, end: Date): string {
  return isoDate(start) === isoDate(end)
    ? `${humanDate(start)}, ${clock(start)}–${clock(end)} UTC`
    : `${humanDate(start)}, ${clock(start)} – ${humanDate(end)}, ${clock(end)} UTC`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

const plainText = (segs: Seg[]): string =>
  segs.map((seg) => (typeof seg === 'string' ? seg : seg.text)).join('');

// ─── Rendering ────────────────────────────────────────────────────────

interface Links {
  original: string; // already escaped
  site: string; // already escaped
}

function renderSegs(segs: Seg[], links: Links): string {
  return segs
    .map((seg) => {
      if (typeof seg === 'string') return escapeHtml(seg);
      const rel = seg.link === 'original' ? ' rel="noopener"' : '';
      return `<a href="${links[seg.link]}"${rel}>${escapeHtml(seg.text)}</a>`;
    })
    .join('');
}

function renderBlock(block: Block, links: Links): string {
  switch (block.type) {
    case 'p':
      return `<p>${renderSegs(block.segs, links)}</p>`;
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.items.map((item) => `<li>${renderSegs(item, links)}</li>`).join('');
      return `<${tag}>${items}</${tag}>`;
    }
    case 'facts': {
      const rows = block.rows
        .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${renderSegs(value, links)}</dd></div>`)
        .join('');
      return `<dl class="facts">${rows}</dl>`;
    }
  }
}

export function generateWrapperHtml(opts: WrapperOptions): string {
  const { originalUrl, wrapperId, deactivated = false } = opts;

  if (deactivated) {
    const href = escapeHtml(normalizedHref(originalUrl));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Page No Longer Available</title>
  <meta name="robots" content="noindex, nofollow" />
  <link rel="canonical" href="${href}" />
</head>
<body>
  <p>This listing is no longer active. <a href="${href}">View original page</a>.</p>
</body>
</html>`;
  }

  const def = TEMPLATES[opts.template ?? pickTemplateId(wrapperId)];
  const now = opts.now ?? new Date();
  const postedAt = opts.postedAt ?? now;
  const parsedUrl = new URL(originalUrl);
  const startsAt = postedAt;
  const endsAt = new Date(startsAt.getTime() + (def.durationMinutes ?? 0) * 60 * 1000);

  const org = parsedUrl.hostname.replace(/^www\./, '');
  const siteOrigin = `${parsedUrl.protocol}//${parsedUrl.hostname}`;
  const ctx: TemplateContext = {
    org,
    label: labelFromUrl(parsedUrl),
    revision: Math.max(0, opts.revision ?? 0),
    postedHuman: humanDate(postedAt),
    modifiedHuman: humanDate(now),
    windowHuman: windowText(startsAt, endsAt),
  };
  const content = def.build(ctx);

  // User-controlled values, escaped for the HTML context they are placed in below
  const links: Links = { original: escapeHtml(parsedUrl.href), site: escapeHtml(siteOrigin) };
  const title = escapeHtml(clip(content.title, 70));
  const description = escapeHtml(clip(plainText(content.lede[0] ?? []), 158));
  const orgHtml = escapeHtml(org);

  const organization = { '@type': 'Organization', name: org, sameAs: siteOrigin };
  const identifier = { '@type': 'PropertyValue', name: org, value: wrapperId };
  const thumbnail = `${originOf(opts.wrapperUrl)}/thumb/${def.theme}.svg`;

  const jsonLd =
    def.kind === 'livestream'
      ? {
          '@context': 'https://schema.org/',
          '@type': 'VideoObject',
          name: content.data.title,
          description: content.data.description,
          thumbnailUrl: [thumbnail],
          uploadDate: isoDateTime(startsAt),
          embedUrl: parsedUrl.href,
          url: parsedUrl.href,
          identifier,
          publisher: organization,
          publication: {
            '@type': 'BroadcastEvent',
            isLiveBroadcast: true,
            startDate: isoDateTime(startsAt),
            endDate: isoDateTime(endsAt),
          },
        }
      : {
          '@context': 'https://schema.org/',
          '@type': 'JobPosting',
          title: content.data.title,
          description: content.data.description,
          datePosted: isoDate(postedAt),
          validThrough: isoDate(new Date(postedAt.getTime() + 30 * DAY_MS)),
          employmentType: 'FULL_TIME',
          directApply: false,
          identifier,
          hiringOrganization: organization,
          jobLocation: {
            '@type': 'Place',
            address: { '@type': 'PostalAddress', addressCountry: 'US' },
          },
          url: parsedUrl.href,
        };

  const lede = content.lede.map((paragraph) => `<p class="lede">${renderSegs(paragraph, links)}</p>`).join('\n        ');
  const sections = content.sections
    .map(
      (section) => `      <section>
        <h2>${escapeHtml(section.heading)}</h2>
        ${section.blocks.map((block) => renderBlock(block, links)).join('\n        ')}
      </section>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <meta name="description" content="${description}" />
  <meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large" />
  <link rel="canonical" href="${links.original}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:url" content="${links.original}" />
  <meta property="og:site_name" content="${orgHtml}" />${
    def.kind === 'livestream' ? `
  <meta property="og:image" content="${escapeHtml(thumbnail)}" />` : ''
  }
  <style>
${templateCss(def)}
  </style>
  <script type="application/ld+json">
${jsonForScriptTag(jsonLd)}
  </script>
</head>
<body>
  <header class="top">
    <div class="wrap">
      <p class="brand">${orgHtml}</p>
      <nav class="crumbs" aria-label="Breadcrumb">
        <ol>
          <li><a href="${links.site}">${orgHtml}</a></li>
          <li aria-current="page">${escapeHtml(content.kicker)}</li>
        </ol>
      </nav>
    </div>
  </header>
  <main class="wrap">
    <article>
      <header>
        <p class="kicker">${escapeHtml(content.kicker)}</p>
        <h1>${escapeHtml(content.h1)}</h1>
        ${lede}
      </header>
${sections}
    </article>
  </main>
  <footer class="foot">
    <div class="wrap">
      <p>A summary of a ${def.kind === 'livestream' ? 'broadcast' : 'listing'} from <a href="${links.site}">${orgHtml}</a>. <a href="${links.original}" rel="noopener">Original page</a></p>
      <p>Last updated <time datetime="${isoDate(now)}">${escapeHtml(humanDate(now))}</time></p>
    </div>
  </footer>
</body>
</html>`;
}

// ─── Sitemap and RSS ──────────────────────────────────────────────────

/** A published wrapper as it appears in the sitemap and the RSS feed. */
export interface FeedEntry {
  url: string;
  /** When the page last changed — its real modification time, not "now" */
  lastmod: Date;
  title?: string;
}

const toEntry = (entry: string | FeedEntry): FeedEntry =>
  typeof entry === 'string' ? { url: entry, lastmod: new Date() } : entry;

export function generateSitemapXml(entries: Array<string | FeedEntry>): string {
  const items = entries
    .map(toEntry)
    .map(
      ({ url, lastmod }) =>
        `  <url>\n    <loc>${escapeXml(url)}</loc>\n    <lastmod>${lastmod.toISOString()}</lastmod>\n  </url>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${items}
</urlset>`;
}

export function generateRssFeed(entries: Array<string | FeedEntry>): string {
  const built = new Date().toUTCString();
  const items = entries
    .map(toEntry)
    .map(
      ({ url, lastmod, title }) =>
        `    <item>\n      <title>${escapeXml(title ?? 'Listing update')}</title>\n      <link>${escapeXml(url)}</link>\n      <pubDate>${lastmod.toUTCString()}</pubDate>\n      <guid isPermaLink="true">${escapeXml(url)}</guid>\n    </item>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
  <channel>
    <title>IndexMeNow Listings</title>
    <link>${escapeXml(env.server.baseUrl)}</link>
    <description>Latest listing updates</description>
    <lastBuildDate>${built}</lastBuildDate>
${items}
  </channel>
</rss>`;
}
