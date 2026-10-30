import axios from 'axios';
import { env } from '../config/env';
import { wrapperService } from './wrapperService';
import { serviceAccountPool } from './serviceAccountPool';
import { indexNowService } from './indexNowService';
import { generateSitemapXml, generateRssFeed } from '../utils/htmlGenerator';
import { logger } from '../utils/logger';

// Every job triggers signals; resubmitting the same feeds each time adds nothing
const SUBMIT_MIN_INTERVAL_MS = 5 * 60 * 1000;

export class SitemapService {
  private cachedSitemap = '';
  private lastGenerated = new Date(0);
  private lastSubmittedAt = 0;

  async sendSecondaryCrawlSignals(newUrls: string[] = []): Promise<void> {
    try {
      await this.updateSitemap();
      await this.submitFeeds();
      await indexNowService.submit(newUrls);
    } catch (error) {
      logger.warn('Secondary crawl signals failed:', error);
    }
  }

  async updateSitemap(): Promise<string> {
    const urls = await wrapperService.getActiveWrapperUrls();
    this.cachedSitemap = generateSitemapXml(urls);
    this.lastGenerated = new Date();
    return this.cachedSitemap;
  }

  async getCurrentSitemap(): Promise<string> {
    if (Date.now() - this.lastGenerated.getTime() > 10 * 60 * 1000) {
      return this.updateSitemap();
    }
    return this.cachedSitemap;
  }

  async getRssFeed(): Promise<string> {
    const urls = await wrapperService.getActiveWrapperUrls();
    return generateRssFeed(urls);
  }

  /**
   * Google retired the sitemap "ping" endpoint in 2023, so submit the feeds
   * through the Search Console API instead. Needs a platform service account
   * that is an owner of the Search Console property covering BASE_URL.
   */
  private async submitFeeds(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSubmittedAt < SUBMIT_MIN_INTERVAL_MS) return;
    this.lastSubmittedAt = now;

    // Search Console calls don't spend Indexing API publish quota
    const sa = await serviceAccountPool.getAvailable(false);
    if (!sa) {
      logger.debug('No platform service account — skipping sitemap submit');
      return;
    }

    const siteUrl =
      env.google.platformGscSiteUrl || `${new URL(env.server.baseUrl).origin}/`;

    try {
      const token = await serviceAccountPool.getAccessToken(sa);
      for (const feed of [
        `${env.server.baseUrl}/sitemap.xml`,
        `${env.server.baseUrl}/rss.xml`,
      ]) {
        await axios.put(
          `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(feed)}`,
          undefined,
          {
            headers: { Authorization: `Bearer ${token}`, 'Content-Length': '0' },
            timeout: 10000,
          }
        );
      }
      logger.debug(`Sitemap feeds submitted to Search Console (${siteUrl})`);
    } catch (error) {
      const status = (error as { response?: { status?: number } }).response?.status;
      logger.warn(
        `Sitemap submit failed (HTTP ${status ?? 'n/a'}) — is ${sa.email} an owner of ${siteUrl}?`
      );
    }
  }
}

export const sitemapService = new SitemapService();
