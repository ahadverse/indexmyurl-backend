import mongoose from 'mongoose';
import { UrlJob, JobStatus } from '../models/UrlJob';
import { WrapperPage, WrapperStatus, IWrapperPage } from '../models/WrapperPage';
import { generateWrapperId } from '../utils/helpers';
import { generateWrapperHtml, FeedEntry } from '../utils/htmlGenerator';
import {
  WrapperTemplateId,
  chooseTemplateId,
  isWrapperTemplateId,
  kindOfTemplate,
} from '../utils/wrapperTemplates';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export interface ServedWrapper {
  html: string;
  isActive: boolean;
  /** When the page content last changed (for Last-Modified) */
  lastModified: Date;
}

const templateOf = (wrapper: Pick<IWrapperPage, 'template'>): WrapperTemplateId | undefined =>
  isWrapperTemplateId(wrapper.template) ? wrapper.template : undefined;

export class WrapperService {
  async createWrapper(
    jobId: mongoose.Types.ObjectId
  ): Promise<{ wrapperId: string; wrapperUrl: string }> {
    const job = await UrlJob.findById(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    // Idempotent: if this job already has a live wrapper (the Google call failed
    // or was deferred and the job is being processed again), reuse it instead of
    // piling up orphaned wrappers in the sitemap.
    if (job.wrapperId && job.wrapperUrl) {
      const existing = await WrapperPage.findOne({
        wrapperId: job.wrapperId,
        status: WrapperStatus.ACTIVE,
        expiresAt: { $gt: new Date() },
      }).select('wrapperId wrapperUrl');
      if (existing) {
        await UrlJob.findByIdAndUpdate(jobId, { status: JobStatus.WRAPPER_CREATED });
        return { wrapperId: existing.wrapperId, wrapperUrl: existing.wrapperUrl };
      }
    }

    // A retry (same job, new attempt) gets a brand-new wrapper: a random design the job has not used
    // before, usually of the other kind (job posting <-> livestream)
    const created = await this.insertWrapper(job, await this.nextTemplate(jobId));

    await UrlJob.findByIdAndUpdate(jobId, {
      status: JobStatus.WRAPPER_CREATED,
      wrapperId: created.wrapperId,
      wrapperUrl: created.wrapperUrl,
      wrapperActiveAt: new Date(),
    });

    logger.info(`Wrapper created: ${created.wrapperUrl} (${created.template}) for job ${jobId}`);
    return { wrapperId: created.wrapperId, wrapperUrl: created.wrapperUrl };
  }

  /** Random template for the job's next wrapper, avoiding every design it has shown Google so far. */
  private async nextTemplate(jobId: mongoose.Types.ObjectId): Promise<WrapperTemplateId> {
    const earlier = await WrapperPage.find({ jobId }).sort({ createdAt: 1 }).select('template');
    return chooseTemplateId(earlier.map((w) => w.template));
  }

  /**
   * One more wrapper for a job that is still waiting: a new URL with a design the job has not used
   * yet, so Google gets another page to fetch that links to the same target. The job keeps pointing
   * at its first wrapper; the extra ones are tracked only through WrapperPage.jobId.
   */
  async createAdditionalWrapper(
    jobId: mongoose.Types.ObjectId
  ): Promise<{ wrapperId: string; wrapperUrl: string } | null> {
    const job = await UrlJob.findById(jobId);
    if (!job || [JobStatus.INDEXED, JobStatus.FAILED].includes(job.status)) return null;

    const template = await this.nextTemplate(jobId);
    const created = await this.insertWrapper(job, template);
    logger.info(`Extra wrapper created: ${created.wrapperUrl} (${template}) for job ${jobId}`);
    return { wrapperId: created.wrapperId, wrapperUrl: created.wrapperUrl };
  }

  private async insertWrapper(
    job: { _id: mongoose.Types.ObjectId; originalUrl: string },
    template: WrapperTemplateId
  ): Promise<{ wrapperId: string; wrapperUrl: string; template: WrapperTemplateId }> {
    const wrapperId = generateWrapperId();
    const wrapperUrl = `${env.server.baseUrl}/job/${wrapperId}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + env.job.wrapperExpiryHours * 60 * 60 * 1000);

    const html = generateWrapperHtml({
      wrapperId,
      originalUrl: job.originalUrl,
      wrapperUrl,
      template,
      postedAt: now,
      now,
    });

    await WrapperPage.create({
      wrapperId,
      jobId: job._id,
      originalUrl: job.originalUrl,
      wrapperUrl,
      htmlContent: html,
      template,
      status: WrapperStatus.ACTIVE,
      expiresAt,
    });
    return { wrapperId, wrapperUrl, template };
  }

  /**
   * Re-generate a live wrapper with fresh content (new "last updated" date, next opening paragraph)
   * so a repeat Indexing API notification points Googlebot at a page that really changed.
   */
  async refreshWrapper(wrapperId: string): Promise<IWrapperPage | null> {
    const wrapper = await WrapperPage.findOne({
      wrapperId,
      status: WrapperStatus.ACTIVE,
      expiresAt: { $gt: new Date() },
    });
    if (!wrapper) return null;

    const now = new Date();
    const revision = wrapper.revision + 1;
    const html = generateWrapperHtml({
      wrapperId,
      originalUrl: wrapper.originalUrl,
      wrapperUrl: wrapper.wrapperUrl,
      template: templateOf(wrapper),
      revision,
      postedAt: wrapper.createdAt,
      now,
    });

    return WrapperPage.findByIdAndUpdate(
      wrapper._id,
      { htmlContent: html, revision, refreshedAt: now },
      { new: true }
    );
  }

  /** Delete a wrapper that was created but never announced to Google (its publish failed). */
  async discardWrapper(wrapperId: string): Promise<void> {
    await WrapperPage.deleteOne({ wrapperId });
    logger.info(`Wrapper discarded (never published): ${wrapperId}`);
  }

  /** Record a successful Indexing API notification for this wrapper. */
  async markNotified(wrapperId: string): Promise<void> {
    await WrapperPage.findOneAndUpdate(
      { wrapperId },
      { $inc: { notifyCount: 1 }, $set: { lastNotifiedAt: new Date() } }
    );
  }

  async serveWrapper(wrapperId: string): Promise<ServedWrapper | null> {
    const wrapper = await WrapperPage.findOne({ wrapperId });
    if (!wrapper) return null;

    if (!wrapper.crawledAt) {
      await WrapperPage.findByIdAndUpdate(wrapper._id, { crawledAt: new Date() });
    }

    const isExpired = new Date() > wrapper.expiresAt;

    if (wrapper.status !== WrapperStatus.ACTIVE || isExpired) {
      const noindexHtml = generateWrapperHtml({
        wrapperId,
        originalUrl: wrapper.originalUrl,
        wrapperUrl: wrapper.wrapperUrl,
        deactivated: true,
      });
      return {
        html: noindexHtml,
        isActive: false,
        lastModified: wrapper.deactivatedAt ?? wrapper.expiresAt,
      };
    }

    return {
      html: wrapper.htmlContent,
      isActive: true,
      lastModified: wrapper.refreshedAt ?? wrapper.createdAt,
    };
  }

  async deactivateWrapper(wrapperId: string, reason: string): Promise<void> {
    const wrapper = await WrapperPage.findOne({ wrapperId });
    if (!wrapper) return;

    const noindexHtml = generateWrapperHtml({
      wrapperId,
      originalUrl: wrapper.originalUrl,
      wrapperUrl: wrapper.wrapperUrl,
      deactivated: true,
    });

    await WrapperPage.findOneAndUpdate(
      { wrapperId },
      {
        status: WrapperStatus.NOINDEX,
        htmlContent: noindexHtml,
        deactivatedAt: new Date(),
      }
    );

    await UrlJob.findByIdAndUpdate(wrapper.jobId, {
      wrapperDeactivatedAt: new Date(),
    });

    logger.info(`Wrapper deactivated: ${wrapperId} | reason: ${reason}`);
  }

  /**
   * Retire every live wrapper of a job (the first one and any extras) and return their URLs, so the
   * caller can also ask Google to drop them.
   */
  async deactivateJobWrappers(jobId: mongoose.Types.ObjectId, reason: string): Promise<string[]> {
    const live = await WrapperPage.find({ jobId, status: WrapperStatus.ACTIVE }).select(
      'wrapperId wrapperUrl'
    );
    for (const wrapper of live) {
      await this.deactivateWrapper(wrapper.wrapperId, reason);
    }
    return live.map((w) => w.wrapperUrl);
  }

  async getActiveWrapperUrls(): Promise<string[]> {
    return (await this.getActiveWrapperEntries()).map((entry) => entry.url);
  }

  /** Live wrappers with their real modification time, for the sitemap and the RSS feed. */
  async getActiveWrapperEntries(): Promise<FeedEntry[]> {
    const wrappers = await WrapperPage.find(
      { status: WrapperStatus.ACTIVE, expiresAt: { $gt: new Date() } },
      { wrapperUrl: 1, originalUrl: 1, template: 1, refreshedAt: 1, createdAt: 1 }
    ).sort({ createdAt: -1 });

    return wrappers.map((w) => {
      const live = isWrapperTemplateId(w.template) && kindOfTemplate(w.template) === 'livestream';
      let title = live ? 'Live broadcast' : 'Listing update';
      try {
        const host = new URL(w.originalUrl).hostname.replace(/^www\./, '');
        title = live ? `Live from ${host}` : `Opportunity at ${host}`;
      } catch {
        /* keep the generic title */
      }
      return { url: w.wrapperUrl, lastmod: w.refreshedAt ?? w.createdAt, title };
    });
  }
}

export const wrapperService = new WrapperService();
