import { Request, Response, NextFunction } from 'express';
import { wrapperService } from '../services/wrapperService';
import { sitemapService } from '../services/sitemapService';
import { env } from '../config/env';

export class WrapperController {
  /** GET /job/:wrapperId — serve wrapper HTML to Googlebot */
  async serveWrapper(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await wrapperService.serveWrapper(req.params.wrapperId);

      if (!result) {
        res.status(404).send('<html><body><h1>Not Found</h1></body></html>');
        return;
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache');

      if (!result.isActive) {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      }

      res.send(result.html);
    } catch (error) {
      next(error);
    }
  }

  /** GET /sitemap.xml */
  async serveSitemap(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const xml = await sitemapService.getCurrentSitemap();
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.send(xml);
    } catch (error) {
      next(error);
    }
  }

  /** GET /rss.xml */
  async serveRss(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const rss = await sitemapService.getRssFeed();
      res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.send(rss);
    } catch (error) {
      next(error);
    }
  }

  /** GET /indexnow.txt — IndexNow key verification file (only when INDEXNOW_KEY is set) */
  serveIndexNowKey(req: Request, res: Response): void {
    if (!env.indexNow.key) {
      res.status(404).send('Not Found');
      return;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(env.indexNow.key);
  }

  /** GET /robots.txt */
  serveRobots(req: Request, res: Response): void {
    const sitemapUrl = `${env.server.baseUrl}/sitemap.xml`;
    const rssUrl = `${env.server.baseUrl}/rss.xml`;

    const content = [
      'User-agent: *',
      'Allow: /job/',
      'Allow: /sitemap.xml',
      'Allow: /rss.xml',
      'Disallow: /api/',
      '',
      'User-agent: Googlebot',
      'Allow: /job/',
      'Crawl-delay: 1',
      '',
      `Sitemap: ${sitemapUrl}`,
      `Sitemap: ${rssUrl}`,
    ].join('\n');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(content);
  }
}

export const wrapperController = new WrapperController();
