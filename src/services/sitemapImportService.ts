import zlib from 'zlib';
import { env } from '../config/env';
import { preflightService, PreflightService } from './preflightService';

/**
 * Read the page URLs out of a sitemap (or a sitemap index) so they can be scanned and
 * submitted. Every http(s) page URL is returned whatever site it is on: a sitemap may
 * legitimately list pages of several domains the same owner runs. Fetching is as safe as a
 * scan (public addresses only, size and time capped), and the number of sitemap files read
 * and URLs returned is capped.
 */

export interface SitemapImport {
  /** page URLs, at most PREFLIGHT_SITEMAP_MAX_URLS */
  urls: string[];
  /** page URLs found (can exceed urls.length) */
  found: number;
  /** more URLs or sitemap files exist than were read */
  truncated: boolean;
  /** sitemap files read, including the first */
  sitemaps: number;
  /** the sites the returned URLs are on, with how many each (largest first, at most 5) */
  hosts: Record<string, number>;
}

export interface SitemapProgress {
  filesRead: number;
  /** files read plus files still queued: grows as a sitemap index is opened */
  filesTotal: number;
  /** page URLs found so far */
  found: number;
}

/** A problem the user can act on; the message is safe to show. */
export class SitemapImportError extends Error {}

export type SitemapKind = 'urlset' | 'index' | 'text' | 'unknown';

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function xmlDecode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Pull the <loc> entries out of sitemap XML (or a one-URL-per-line text sitemap). */
export function parseSitemap(text: string): { kind: SitemapKind; locs: string[] } {
  const isIndex = /<(?:\w+:)?sitemapindex\b/i.test(text);
  const isUrlset = /<(?:\w+:)?urlset\b/i.test(text);

  if (isIndex || isUrlset) {
    const locs: string[] = [];
    const re = /<(?:\w+:)?loc\b[^>]*>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/(?:\w+:)?loc>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const loc = (m[1] ?? xmlDecode(m[2] ?? '')).trim();
      if (loc) locs.push(loc);
    }
    return { kind: isIndex ? 'index' : 'urlset', locs };
  }

  // plain-text sitemap: one URL per line
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 0 && lines.every((l) => /^https?:\/\//i.test(l))) return { kind: 'text', locs: lines };
  return { kind: 'unknown', locs: [] };
}

/** Sitemap files requested at the same time. */
const FILES_AT_ONCE = 4;

export class SitemapImportService {
  constructor(private readonly fetcher: Pick<PreflightService, 'fetchResource'> = preflightService) {}

  async import(
    rawUrl: string,
    opts: { onProgress?: (p: SitemapProgress) => void; signal?: AbortSignal } = {}
  ): Promise<SitemapImport> {
    let root: URL;
    try {
      root = new URL(rawUrl);
    } catch {
      throw new SitemapImportError('That is not a valid URL.');
    }
    if (root.protocol !== 'http:' && root.protocol !== 'https:') {
      throw new SitemapImportError('Only http:// and https:// sitemap URLs are supported.');
    }

    const maxUrls = env.preflight.sitemapMaxUrls;
    const maxFiles = env.preflight.sitemapMaxFiles;

    const urls = new Set<string>();
    const seenFiles = new Set<string>();
    let found = 0;
    let truncated = false;
    let filesRead = 0;
    let queue: string[] = [root.href];
    opts.onProgress?.({ filesRead: 0, filesTotal: 1, found: 0 });

    while (queue.length > 0) {
      const batch: string[] = [];
      while (queue.length > 0 && batch.length < FILES_AT_ONCE && filesRead + batch.length < maxFiles) {
        const next = queue.shift()!;
        if (!seenFiles.has(next)) {
          seenFiles.add(next);
          batch.push(next);
        }
      }
      if (batch.length === 0) {
        truncated = truncated || queue.length > 0; // sitemap files left unread
        break;
      }

      // a few files at a time; a failing child sitemap is skipped, a failing root is an error
      const loaded = await Promise.all(batch.map((file) => this.load(file, file === root.href, opts.signal)));
      filesRead += batch.length;
      const children: string[] = [];

      for (const sitemap of loaded) {
        if (!sitemap) continue;
        truncated = truncated || sitemap.truncated;
        for (const loc of sitemap.locs) {
          let url: URL;
          try {
            url = new URL(loc);
          } catch {
            continue;
          }
          if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
          if (sitemap.kind === 'index') {
            children.push(url.href);
            continue;
          }
          found++;
          if (urls.size < maxUrls) urls.add(url.href);
        }
      }

      queue = [...queue, ...children];
      opts.onProgress?.({ filesRead, filesTotal: filesRead + queue.length, found });
      if (urls.size >= maxUrls) {
        truncated = truncated || found > urls.size || queue.length > 0;
        break;
      }
    }

    if (found > urls.size) truncated = true;
    if (urls.size === 0) throw new SitemapImportError('No page URLs were found in this sitemap.');

    const perHost = new Map<string, number>();
    for (const u of urls) {
      const host = new URL(u).host;
      perHost.set(host, (perHost.get(host) ?? 0) + 1);
    }
    const hosts = Object.fromEntries([...perHost].sort((a, b) => b[1] - a[1]).slice(0, 5));
    return { urls: [...urls], found, truncated, sitemaps: filesRead, hosts };
  }

  private async load(
    file: string,
    isRoot: boolean,
    signal?: AbortSignal
  ): Promise<{ kind: SitemapKind; locs: string[]; truncated: boolean } | null> {
    try {
      const res = await this.fetcher.fetchResource(file, { maxBytes: env.preflight.sitemapMaxBytes, signal });
      if (res.status < 200 || res.status >= 300) {
        throw new SitemapImportError(
          res.status === 404 || res.status === 410
            ? `The sitemap was not found (HTTP ${res.status}).`
            : `The sitemap could not be read (HTTP ${res.status}).`
        );
      }

      let body = res.body;
      if (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b) {
        // .xml.gz, served as a file rather than with Content-Encoding
        try {
          body = zlib.gunzipSync(body, { maxOutputLength: 4 * env.preflight.sitemapMaxBytes });
        } catch {
          throw new SitemapImportError('The compressed sitemap could not be unpacked.');
        }
      }

      const parsed = parseSitemap(body.toString('utf8'));
      if (parsed.kind === 'unknown') {
        throw new SitemapImportError('This does not look like a sitemap: no <urlset> or <sitemapindex> was found.');
      }
      return { ...parsed, truncated: res.truncated };
    } catch (err) {
      if (!isRoot) return null; // one broken child sitemap should not sink the import
      if (err instanceof SitemapImportError) throw err;
      throw new SitemapImportError(describeFetchError(err as NodeJS.ErrnoException));
    }
  }
}

function describeFetchError(err: NodeJS.ErrnoException): string {
  switch (err.code) {
    case 'ENOTFOUND':
      return "The domain does not resolve (DNS lookup failed), so the sitemap can't be read.";
    case 'UNSAFE_TARGET':
    case 'EUNSAFE':
    case 'INVALID_URL':
      return err.message || 'This address cannot be fetched.';
    case 'TOO_MANY_REDIRECTS':
      return 'The sitemap URL redirects in a loop or through too many hops.';
    default:
      return 'The sitemap could not be fetched (the server did not answer in time or refused the connection).';
  }
}

export const sitemapImportService = new SitemapImportService();
