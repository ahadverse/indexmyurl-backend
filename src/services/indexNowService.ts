import axios from 'axios';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

/**
 * IndexNow (Bing, Yandex, Seznam, Naver). Opt-in via INDEXNOW_KEY.
 *
 * IndexNow only accepts URLs on the host that serves the key file, so this
 * submits the wrapper URLs on BASE_URL — not customers' own URLs, which would
 * need the key file hosted on their domain. It does not notify Google.
 */
export class IndexNowService {
  isEnabled(): boolean {
    return env.indexNow.key.length > 0;
  }

  get keyFileUrl(): string {
    return `${env.server.baseUrl}/indexnow.txt`;
  }

  async submit(urls: string[]): Promise<void> {
    if (!this.isEnabled() || urls.length === 0) return;

    try {
      await axios.post(
        INDEXNOW_ENDPOINT,
        {
          host: new URL(env.server.baseUrl).host,
          key: env.indexNow.key,
          keyLocation: this.keyFileUrl,
          urlList: urls,
        },
        { timeout: 10000 }
      );
      logger.debug(`IndexNow: submitted ${urls.length} URL(s)`);
    } catch (error) {
      const status = (error as { response?: { status?: number } }).response?.status;
      logger.warn(`IndexNow submit failed (HTTP ${status ?? 'n/a'})`);
    }
  }
}

export const indexNowService = new IndexNowService();
