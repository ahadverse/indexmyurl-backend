import axios from 'axios';
import mongoose from 'mongoose';
import { UrlJob, JobStatus } from '../models/UrlJob';
import {
  credentialResolver,
  CredentialSource,
  ResolvedCredential,
  OAUTH_PUBLISH_BUCKET,
} from './credentialResolver';
import { serviceAccountPool } from './serviceAccountPool';
import { apiUsageService } from './apiUsageService';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const INDEXING_API_URL =
  'https://indexing.googleapis.com/v3/urlNotifications:publish';

type NotifyType = 'URL_UPDATED' | 'URL_DELETED';

/**
 * SUCCESS          — Google accepted the notification
 * QUOTA_EXHAUSTED  — daily quota is spent; wait for the Pacific-midnight reset
 * RETRYABLE        — transient or fixable (5xx, network, auth, no credential): try again later
 * PERMANENT        — Google rejected the request itself (e.g. 400); retrying won't help
 */
export type PublishOutcome =
  | 'SUCCESS'
  | 'QUOTA_EXHAUSTED'
  | 'RETRYABLE'
  | 'PERMANENT';

export interface PublishResult {
  outcome: PublishOutcome;
  message?: string;
}

interface AttemptResult extends PublishResult {
  /** The credential itself was rejected/spent — another credential may still work */
  tryNextCredential: boolean;
}

export class GoogleIndexingService {
  /**
   * Notify Google about a URL. Tries credentials in PUBLISH_CREDENTIAL_MODE
   * order and falls through to the next one when a credential is rejected (401/403)
   * or out of quota (429).
   */
  async notifyUrl(
    jobId: mongoose.Types.ObjectId,
    wrapperUrl: string,
    type: NotifyType = 'URL_UPDATED'
  ): Promise<PublishResult> {
    const job = await UrlJob.findById(jobId);
    if (!job) return { outcome: 'PERMANENT', message: 'Job not found' };

    const tried = new Set<CredentialSource>();
    let sawQuota = false;
    let last: PublishResult | null = null;

    for (;;) {
      const resolution = await credentialResolver.resolveForPublish(
        job.userId,
        job.domain,
        tried
      );

      if (!resolution.credential) {
        if (resolution.reason === 'QUOTA_EXHAUSTED') sawQuota = true;
        if (last === null) {
          const message =
            resolution.reason === 'QUOTA_EXHAUSTED'
              ? 'Daily Indexing API quota is used up — will resume after the quota resets.'
              : 'No Google credential available. Ask an admin to add a platform service account, or connect your Google account in Settings → Google.';
          await this.logJobError(jobId, message, 'GOOGLE_INDEXING_API');
          return {
            outcome: sawQuota ? 'QUOTA_EXHAUSTED' : 'RETRYABLE',
            message,
          };
        }
        break;
      }

      const credential = resolution.credential;
      tried.add(credential.source);

      const attempt = await this.publishWith(
        jobId,
        wrapperUrl,
        type,
        credential
      );
      if (attempt.outcome === 'SUCCESS') return attempt;
      if (attempt.outcome === 'QUOTA_EXHAUSTED') sawQuota = true;
      last = attempt;
      if (!attempt.tryNextCredential) break;
    }

    // Every credential was tried. Report quota if that was any part of the story.
    return sawQuota
      ? { outcome: 'QUOTA_EXHAUSTED', message: last?.message }
      : last ?? { outcome: 'RETRYABLE' };
  }

  private async publishWith(
    jobId: mongoose.Types.ObjectId,
    wrapperUrl: string,
    type: NotifyType,
    credential: ResolvedCredential
  ): Promise<AttemptResult> {
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
        nextPublishAt: null,
        credentialSource: credential.source,
        googleTokenId: credential.tokenDoc?._id ?? null,
        serviceAccountId: credential.serviceAccount?._id ?? null,
        googleApiResponse: { ...response.data, _credentialSource: credential.source },
      });

      logger.info(
        `Google Indexing API notified | job: ${jobId} | source: ${credential.source}`
      );
      return { outcome: 'SUCCESS', tryNextCredential: false };
    } catch (error: unknown) {
      const err = error as {
        response?: { data?: { error?: { message?: string } }; status?: number };
        message?: string;
      };
      const errMsg =
        err.response?.data?.error?.message || err.message || 'Unknown error';
      const status = err.response?.status;
      const message = `Google API error [${credential.source}${status ? ` ${status}` : ''}]: ${errMsg}`;

      logger.error(
        `Google Indexing API failed | job: ${jobId} | source: ${credential.source} | ${status ?? 'no response'} | ${errMsg}`
      );
      await this.logJobError(jobId, message, 'GOOGLE_INDEXING_API');

      // 429: this credential is out of quota for today. It is healthy, so don't
      // count it as an error — just stop using it until the quota resets.
      if (status === 429) {
        await this.markCredentialExhausted(credential);
        return { outcome: 'QUOTA_EXHAUSTED', message, tryNextCredential: true };
      }

      // 401/403: this credential isn't allowed to publish this URL (e.g. it
      // doesn't own the property). Another credential might be.
      if (status === 401 || status === 403) {
        if (credential.source === 'SERVICE_ACCOUNT' && credential.serviceAccount) {
          await serviceAccountPool.reportError(
            credential.serviceAccount._id.toString(),
            errMsg
          );
        }
        return { outcome: 'RETRYABLE', message, tryNextCredential: true };
      }

      // Other 4xx: Google rejected the request itself
      if (status && status >= 400 && status < 500 && status !== 408) {
        return { outcome: 'PERMANENT', message, tryNextCredential: false };
      }

      // 5xx, timeouts, network errors
      return { outcome: 'RETRYABLE', message, tryNextCredential: false };
    }
  }

  private async markCredentialExhausted(
    credential: ResolvedCredential
  ): Promise<void> {
    if (credential.source === 'SERVICE_ACCOUNT' && credential.serviceAccount) {
      await serviceAccountPool.markQuotaExhausted(
        credential.serviceAccount._id.toString()
      );
    } else if (credential.source === 'OAUTH') {
      await apiUsageService.markExhausted(
        OAUTH_PUBLISH_BUCKET,
        env.google.oauthDailyPublishLimit
      );
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
