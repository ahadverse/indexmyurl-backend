import { Request, Response } from 'express';
import { env } from '../config/env';
import { preflightService, urlKey } from '../services/preflightService';
import { sitemapImportService, SitemapImportError } from '../services/sitemapImportService';
import { openSse } from '../utils/sse';
import { logger } from '../utils/logger';

const MAX_URL_LENGTH = 2048;

/**
 * Validate and de-duplicate a list of URLs from a request body.
 * Returns the cleaned list, or an error message.
 */
export function parseUrlList(
  body: unknown,
  max: number
): { urls: string[]; duplicates: number } | { error: string } {
  const raw = (body as { urls?: unknown } | undefined)?.urls;
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'urls must be a non-empty array of strings' };
  if (raw.length > max) return { error: `At most ${max} URLs per request (got ${raw.length})` };

  const seen = new Set<string>();
  const urls: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { error: 'urls must be an array of strings' };
    const url = item.trim();
    if (!url) continue;
    if (url.length > MAX_URL_LENGTH) return { error: `A URL is longer than ${MAX_URL_LENGTH} characters` };
    const key = urlKey(url) ?? url;
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
  }
  if (urls.length === 0) return { error: 'urls must contain at least one URL' };
  return { urls, duplicates: raw.length - urls.length };
}

export class PreflightController {
  /**
   * POST /api/urls/preflight  { urls: string[] }
   *
   * Responds with a Server-Sent Events stream so the client can show live progress:
   *   {type:'start',  total, duplicates, urls}
   *   {type:'result', index, done, total, result}      one per URL, as soon as it is scanned
   *   {type:'done',   total, ok, warn, blocked, elapsedMs}
   */
  async scan(req: Request, res: Response): Promise<void> {
    const parsed = parseUrlList(req.body, env.preflight.maxUrlsPerScan);
    if ('error' in parsed) {
      res.status(400).json({ success: false, message: parsed.error });
      return;
    }
    const { urls, duplicates } = parsed;

    const stream = openSse(res);
    try {
      const startedAt = Date.now();
      const tally = { ok: 0, warn: 0, blocked: 0 };
      stream.send({ type: 'start', total: urls.length, duplicates, urls });

      await preflightService.scan(urls, {
        signal: stream.signal,
        onResult: (index, result, done) => {
          tally[result.verdict]++;
          stream.send({ type: 'result', index, done, total: urls.length, result });
        },
      });

      stream.send({ type: 'done', total: urls.length, ...tally, elapsedMs: Date.now() - startedAt });
    } catch (error) {
      logger.error(`Pre-flight scan failed: ${(error as Error).message}`);
      if (stream.closed) return;
      stream.send({ type: 'error', message: 'The scan failed unexpectedly. Please try again.' });
    } finally {
      stream.end();
    }
  }
}

/**
 * POST /api/urls/sitemap  { url }
 * The page URLs listed in a sitemap (or sitemap index), ready to be scanned. Streams progress
 * as Server-Sent Events so a big sitemap index shows how far it has got:
 *   {type:'start'}
 *   {type:'progress', filesRead, filesTotal, found}
 *   {type:'done', urls, found, truncated, sitemaps, hosts}
 *   {type:'error', message}
 */
export async function importSitemap(req: Request, res: Response): Promise<void> {
  const url = (req.body as { url?: unknown } | undefined)?.url;
  if (typeof url !== 'string' || !url.trim() || url.length > MAX_URL_LENGTH) {
    res.status(400).json({ success: false, message: 'url is required' });
    return;
  }

  const stream = openSse(res);
  try {
    stream.send({ type: 'start' });
    const result = await sitemapImportService.import(url.trim(), {
      signal: stream.signal,
      onProgress: (progress) => stream.send({ type: 'progress', ...progress }),
    });
    stream.send({ type: 'done', ...result });
  } catch (error) {
    if (stream.closed) return;
    if (error instanceof SitemapImportError) {
      stream.send({ type: 'error', message: error.message });
    } else {
      logger.error(`Sitemap import failed: ${(error as Error).message}`);
      stream.send({ type: 'error', message: 'The sitemap could not be imported. Please try again.' });
    }
  } finally {
    stream.end();
  }
}

export const preflightController = new PreflightController();
