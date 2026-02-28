import axios from "axios";
import mongoose from "mongoose";
import { UrlJob } from "../models/UrlJob";
import { GoogleToken } from "../models/GoogleToken";
import { credentialResolver } from "./credentialResolver";
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
  async preCheck(
    url: string,
    userId: mongoose.Types.ObjectId,
  ): Promise<IndexCheckResult> {
    const domain = new URL(url).hostname.replace(/^www\./, "");
    const credential = await credentialResolver.resolve(userId, domain);
    if (!credential) {
      return { status: "ERROR", source: "ERROR", checkedAt: new Date() };
    }
    const siteUrl = await this.resolveSiteUrl(userId, domain);
    return this.callGSC(
      url,
      siteUrl,
      credential.accessToken,
      "GSC_API_PRECHECK",
    );
  }

  async checkJobStatus(
    jobId: mongoose.Types.ObjectId,
  ): Promise<IndexCheckResult> {
    const job = await UrlJob.findById(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    const credential = await credentialResolver.resolve(job.userId, job.domain);
    if (!credential) {
      return { status: "ERROR", source: "ERROR", checkedAt: new Date() };
    }

    const siteUrl = await this.resolveSiteUrl(job.userId, job.domain);
    const result = await this.callGSC(
      job.originalUrl,
      siteUrl,
      credential.accessToken,
      "GSC_API",
    );

    await UrlJob.findByIdAndUpdate(jobId, {
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

  /**
   * Resolve correct siteUrl for GSC Inspect API.
   *
   * GSC has two property types:
   *   - Domain property:     sc-domain:storewike.store
   *   - URL prefix property: https://storewike.store/
   *
   * The Inspect API needs the EXACT property identifier that matches.
   * sc-domain: properties → pass sc-domain: format directly
   * https:// properties   → pass https:// format
   */
  private async resolveSiteUrl(
    userId: mongoose.Types.ObjectId,
    domain: string,
  ): Promise<string> {
    const token = await GoogleToken.findOne({ userId, isActive: true });

    if (token?.gscProperties?.length) {
      // Priority 1: sc-domain property (domain-wide, covers all subdomains + protocols)
      const scDomain = token.gscProperties.find(
        (p) => p === `sc-domain:${domain}` || p === `sc-domain:www.${domain}`,
      );
      if (scDomain) {
        logger.debug(`Using sc-domain property: ${scDomain}`);
        return scDomain;
      }

      // Priority 2: exact https:// match
      const httpsMatch = token.gscProperties.find(
        (p) => p === `https://${domain}/` || p === `https://www.${domain}/`,
      );
      if (httpsMatch) {
        logger.debug(`Using https property: ${httpsMatch}`);
        return httpsMatch;
      }

      // Priority 3: http:// match
      const httpMatch = token.gscProperties.find(
        (p) => p === `http://${domain}/` || p === `http://www.${domain}/`,
      );
      if (httpMatch) return httpMatch;

      // Priority 4: any property containing the domain
      const anyMatch = token.gscProperties.find((p) => p.includes(domain));
      if (anyMatch) {
        logger.debug(`Using partial match property: ${anyMatch}`);
        return anyMatch;
      }

      logger.warn(
        `No matching GSC property for domain ${domain}. Available: ${token.gscProperties.join(", ")}`,
      );
    }

    // Final fallback
    return `https://${domain}/`;
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
