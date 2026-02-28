import mongoose from 'mongoose';
import { UrlJob, JobStatus } from '../models/UrlJob';
import { WrapperPage, WrapperStatus } from '../models/WrapperPage';
import { generateWrapperId } from '../utils/helpers';
import { generateWrapperHtml } from '../utils/htmlGenerator';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export class WrapperService {
  async createWrapper(
    jobId: mongoose.Types.ObjectId
  ): Promise<{ wrapperId: string; wrapperUrl: string }> {
    const job = await UrlJob.findById(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    const wrapperId = generateWrapperId();
    const wrapperUrl = `${env.server.baseUrl}/job/${wrapperId}`;
    const expiresAt = new Date(
      Date.now() + env.job.wrapperExpiryHours * 60 * 60 * 1000
    );

    const html = generateWrapperHtml({
      wrapperId,
      originalUrl: job.originalUrl,
      wrapperUrl,
    });

    await WrapperPage.create({
      wrapperId,
      jobId,
      originalUrl: job.originalUrl,
      wrapperUrl,
      htmlContent: html,
      status: WrapperStatus.ACTIVE,
      expiresAt,
    });

    await UrlJob.findByIdAndUpdate(jobId, {
      status: JobStatus.WRAPPER_CREATED,
      wrapperId,
      wrapperUrl,
      wrapperActiveAt: new Date(),
    });

    logger.info(`Wrapper created: ${wrapperUrl} for job ${jobId}`);
    return { wrapperId, wrapperUrl };
  }

  async serveWrapper(
    wrapperId: string
  ): Promise<{ html: string; isActive: boolean } | null> {
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
      return { html: noindexHtml, isActive: false };
    }

    return { html: wrapper.htmlContent, isActive: true };
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

  async getActiveWrapperUrls(): Promise<string[]> {
    const wrappers = await WrapperPage.find(
      { status: WrapperStatus.ACTIVE, expiresAt: { $gt: new Date() } },
      { wrapperUrl: 1 }
    );
    return wrappers.map((w) => w.wrapperUrl);
  }
}

export const wrapperService = new WrapperService();
