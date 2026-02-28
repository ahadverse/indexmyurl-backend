import axios from 'axios';
import mongoose from 'mongoose';
import { UrlJob, JobStatus } from '../models/UrlJob';
import { credentialResolver } from './credentialResolver';
import { serviceAccountPool } from './serviceAccountPool';
import { logger } from '../utils/logger';

const INDEXING_API_URL =
  'https://indexing.googleapis.com/v3/urlNotifications:publish';

type NotifyType = 'URL_UPDATED' | 'URL_DELETED';

export class GoogleIndexingService {
  /**
   * Notify Google about a URL — auto-picks best credential
   */
  async notifyUrl(
    jobId: mongoose.Types.ObjectId,
    wrapperUrl: string,
    type: NotifyType = 'URL_UPDATED'
  ): Promise<boolean> {
    const job = await UrlJob.findById(jobId);
    if (!job) return false;

    const credential = await credentialResolver.resolve(job.userId, job.domain);

    if (!credential) {
      await this.logJobError(
        jobId,
        'No credential available. Connect your Google account at /api/oauth/google.',
        'GOOGLE_INDEXING_API'
      );
      return false;
    }

    try {
      const response = await axios.post(
        INDEXING_API_URL,
        { url: wrapperUrl, type },
        {
          headers: {
            Authorization: `Bearer ${credential.accessToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );

      // Report success to pool if SA was used
      if (credential.source === 'SERVICE_ACCOUNT' && credential.serviceAccount) {
        await serviceAccountPool.reportSuccess(
          credential.serviceAccount._id.toString()
        );
      }

      // Update job
      await UrlJob.findByIdAndUpdate(jobId, {
        status: JobStatus.WAITING_CRAWL,
        apiCalledAt: new Date(),
        credentialSource: credential.source,
        googleTokenId: credential.tokenDoc?._id ?? null,
        serviceAccountId: credential.serviceAccount?._id ?? null,
        googleApiResponse: { ...response.data, _credentialSource: credential.source },
      });

      logger.info(
        `Google Indexing API notified | job: ${jobId} | source: ${credential.source}`
      );
      return true;
    } catch (error: unknown) {
      const err = error as {
        response?: { data?: { error?: { message?: string } }; status?: number };
        message?: string;
      };
      const errMsg =
        err.response?.data?.error?.message || err.message || 'Unknown error';
      const status = err.response?.status;

      logger.error(
        `Google Indexing API failed | job: ${jobId} | source: ${credential.source} | ${errMsg}`
      );

      // Quota exceeded on SA → report error (pool will auto-rotate next time)
      if (
        status === 429 &&
        credential.source === 'SERVICE_ACCOUNT' &&
        credential.serviceAccount
      ) {
        await serviceAccountPool.reportError(
          credential.serviceAccount._id.toString(),
          'Quota exceeded (429)'
        );
      }

      // SA error
      if (
        credential.source === 'SERVICE_ACCOUNT' &&
        credential.serviceAccount
      ) {
        await serviceAccountPool.reportError(
          credential.serviceAccount._id.toString(),
          errMsg
        );
      }

      await this.logJobError(
        jobId,
        `Google API error [${credential.source}]: ${errMsg}`,
        'GOOGLE_INDEXING_API'
      );
      return false;
    }
  }

  /**
   * Tell Google to remove/deindex a wrapper URL
   */
  async removeUrl(wrapperUrl: string): Promise<void> {
    const sa = await serviceAccountPool.getAvailable();
    if (!sa) {
      logger.warn(`No SA available to remove wrapper: ${wrapperUrl}`);
      return;
    }

    try {
      const token = await serviceAccountPool.getAccessToken(sa);
      await axios.post(
        INDEXING_API_URL,
        { url: wrapperUrl, type: 'URL_DELETED' },
        {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          timeout: 30000,
        }
      );
      await serviceAccountPool.reportSuccess(sa._id.toString());
    } catch {
      logger.warn(`Failed to remove wrapper from Google: ${wrapperUrl}`);
    }
  }

  private async logJobError(
    jobId: mongoose.Types.ObjectId,
    message: string,
    step: string
  ): Promise<void> {
    await UrlJob.findByIdAndUpdate(jobId, {
      $push: { errorLog: { timestamp: new Date(), message, step } },
    });
  }
}

export const googleIndexingService = new GoogleIndexingService();
