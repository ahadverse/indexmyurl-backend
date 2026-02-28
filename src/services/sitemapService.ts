import axios from 'axios';
import { env } from '../config/env';
import { wrapperService } from './wrapperService';
import { generateSitemapXml, generateRssFeed } from '../utils/htmlGenerator';
import { logger } from '../utils/logger';

export class SitemapService {
  private cachedSitemap = '';
  private lastGenerated = new Date(0);

  async sendSecondaryCrawlSignals(): Promise<void> {
    try {
      await this.updateSitemap();
      await this.pingGoogle();
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

  private async pingGoogle(): Promise<void> {
    try {
      await axios.get('https://www.google.com/ping', {
        params: { sitemap: `${env.server.baseUrl}/sitemap.xml` },
        timeout: 10000,
      });
    } catch {
      // Non-200 is normal for Google ping
    }
  }
}

export const sitemapService = new SitemapService();
