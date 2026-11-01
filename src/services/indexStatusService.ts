import axios from "axios";
import mongoose from "mongoose";
import { UrlJob } from "../models/UrlJob";
import {
  searchConsoleAccessService,
  SearchConsoleAccess,
} from "./searchConsoleAccessService";
import { logger } from "../utils/logger";

export type IndexStatus =
  | "INDEXED"
  | "CRAWLED_NOT_INDEXED"
  | "NOT_FOUND"
  | "ERROR";

export interface IndexCheckResult {
  status: IndexStatus;
  source: "GSC_API" | "GSC_API_PRECHECK" | "ERROR";
  checkedAt: Date;
}

const GSC_INSPECT_URL =
  "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

export class IndexStatusService {
  /**
   * Ask Google whether a URL is indexed. `access` is the credential and property to
   * inspect with; pass the one submit already resolved to skip looking it up again.
   * ERROR when the user has no Search Console access to the site.
   */
  async preCheck(
    url: string,
    userId: mongoose.Types.ObjectId,
    access?: SearchConsoleAccess,
  ): Promise<IndexCheckResult> {
    const resolved =
      access ?? (await this.resolveAccess(userId, url));
    if (!resolved) {
      return { status: "ERROR", source: "ERROR", checkedAt: new Date() };
    }
    return this.callGSC(
      url,
      resolved.siteUrl,
      resolved.accessToken,
      "GSC_API_PRECHECK",
    );
  }

  async checkJobStatus(
    jobId: mongoose.Types.ObjectId,
  ): Promise<IndexCheckResult> {
    const job = await UrlJob.findById(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    const access = await this.resolveAccess(job.userId, job.originalUrl);
    if (!access) {
      // Still stamp the attempt so the cron backs off instead of retrying every tick
      await UrlJob.findByIdAndUpdate(jobId, { lastCheckedAt: new Date() });
      return { status: "ERROR", source: "ERROR", checkedAt: new Date() };
    }

    const result = await this.callGSC(
      job.originalUrl,
      access.siteUrl,
      access.accessToken,
      "GSC_API",
    );

    await UrlJob.findByIdAndUpdate(jobId, {
      $set: { lastCheckedAt: result.checkedAt },
      $push: {
        indexCheckResults: {
          checkedAt: result.checkedAt,
          status: result.status,
          source: result.source,
        },
      },
    });

    logger.info(`Index check | job: ${jobId} | status: ${result.status}`);
    return result;
  }

  private async resolveAccess(
    userId: mongoose.Types.ObjectId,
    url: string,
  ): Promise<SearchConsoleAccess | null> {
    const resolved = await searchConsoleAccessService.resolveForUrl(userId, url);
    if (resolved.ok) return resolved.access;
    logger.warn(
      `No Search Console access to inspect ${url} for user ${userId} (${resolved.reason})`,
    );
    return null;
  }

  private async callGSC(
    url: string,
    siteUrl: string,
    accessToken: string,
    source: IndexCheckResult["source"],
  ): Promise<IndexCheckResult> {
    try {
      logger.debug(`GSC inspect: ${url} | siteUrl: ${siteUrl}`);

      const response = await axios.post<{
        inspectionResult?: {
          indexStatusResult?: { verdict?: string; coverageState?: string };
        };
      }>(
        GSC_INSPECT_URL,
        { inspectionUrl: url, siteUrl },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          timeout: 15000,
        },
      );

      const verdict =
        response.data?.inspectionResult?.indexStatusResult?.verdict ??
        "UNKNOWN";
      const coverage =
        response.data?.inspectionResult?.indexStatusResult?.coverageState ?? "";

      let status: IndexStatus;
      if (verdict === "PASS") {
        status = "INDEXED";
      } else if (
        coverage.includes("Crawled") ||
        coverage.includes("Discovered")
      ) {
        status = "CRAWLED_NOT_INDEXED";
      } else {
        status = "NOT_FOUND";
      }

      logger.debug(
        `GSC result: ${url} | verdict: ${verdict} | coverage: ${coverage} | status: ${status}`,
      );
      return { status, source, checkedAt: new Date() };
    } catch (error) {
      const err = error as {
        response?: { data?: unknown; status?: number };
        code?: string;
        message?: string;
      };
      const errStatus = err.response?.status;
      const errCode = err.code;
      const errMsg = JSON.stringify(err.response?.data) || err.message;
      logger.warn(
        `GSC inspect failed: ${url} | HTTP ${errStatus} | code: ${errCode} | ${errMsg}`,
      );
      return { status: "ERROR", source: "ERROR", checkedAt: new Date() };
    }
  }
}

export const indexStatusService = new IndexStatusService();
