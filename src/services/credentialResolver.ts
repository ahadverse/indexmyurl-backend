import mongoose from "mongoose";
import { GoogleToken } from "../models/GoogleToken";
import { googleOAuthService, INDEXING_SCOPE } from "./googleOAuthService";
import { serviceAccountPool } from "./serviceAccountPool";
import { apiUsageService } from "./apiUsageService";
import { IServiceAccount } from "../models/ServiceAccount";
import { IGoogleToken } from "../models/GoogleToken";
import { env, PublishCredentialMode } from "../config/env";
import { logger } from "../utils/logger";

export type CredentialSource = "OAUTH" | "SERVICE_ACCOUNT";

export interface ResolvedCredential {
  accessToken: string;
  source: CredentialSource;
  tokenDoc?: IGoogleToken;
  serviceAccount?: IServiceAccount;
}

export type PublishResolution =
  | { credential: ResolvedCredential }
  | { credential: null; reason: "QUOTA_EXHAUSTED" | "NO_CREDENTIAL" };

// Shared daily budget for publishes made with users' OAuth tokens
export const OAUTH_PUBLISH_BUCKET = "oauth-publish";

const PUBLISH_ORDER: Record<PublishCredentialMode, CredentialSource[]> = {
  platform: ["SERVICE_ACCOUNT"],
  platform_first: ["SERVICE_ACCOUNT", "OAUTH"],
  user_first: ["OAUTH", "SERVICE_ACCOUNT"],
};

export class CredentialResolver {
  /**
   * Credential for Indexing API publishes, honouring PUBLISH_CREDENTIAL_MODE.
   * Pass `exclude` to get the next-best credential after one was rejected.
   */
  async resolveForPublish(
    userId: mongoose.Types.ObjectId,
    domain: string,
    exclude: ReadonlySet<CredentialSource> = new Set(),
  ): Promise<PublishResolution> {
    const order = PUBLISH_ORDER[env.google.publishCredentialMode].filter(
      (source) => !exclude.has(source),
    );
    let quotaExhausted = false;

    for (const source of order) {
      if (source === "SERVICE_ACCOUNT") {
        const credential = await this.resolvePlatform(true);
        if (credential) return { credential };
        if (await serviceAccountPool.isQuotaExhausted()) quotaExhausted = true;
        continue;
      }

      // OAuth: only tokens that were granted the Indexing scope can publish
      const credential = await this.resolveUserToken(userId, domain, INDEXING_SCOPE);
      if (!credential) continue;

      const hasBudget = await apiUsageService.tryConsume(
        OAUTH_PUBLISH_BUCKET,
        env.google.oauthDailyPublishLimit,
      );
      if (!hasBudget) {
        logger.warn("OAuth publish budget for today is spent");
        quotaExhausted = true;
        continue;
      }
      return { credential };
    }

    logger.error(
      `No publish credential for user ${userId} domain ${domain} ` +
        `(mode: ${env.google.publishCredentialMode}, quotaExhausted: ${quotaExhausted})`,
    );
    return {
      credential: null,
      reason: quotaExhausted ? "QUOTA_EXHAUSTED" : "NO_CREDENTIAL",
    };
  }

  /**
   * Credential for read-only Search Console calls (URL Inspection). The user's
   * own token comes first — only it can see the user's property. The platform
   * SA is a last resort and does not spend Indexing API publish quota.
   */
  async resolveForInspection(
    userId: mongoose.Types.ObjectId,
    domain: string,
  ): Promise<ResolvedCredential | null> {
    const userCredential = await this.resolveUserToken(userId, domain);
    if (userCredential) return userCredential;

    const platformCredential = await this.resolvePlatform(false);
    if (platformCredential) return platformCredential;

    logger.error(`No inspection credential for user ${userId} domain ${domain}`);
    return null;
  }

  /** User's OAuth token: domain-specific match first, then any active token. */
  private async resolveUserToken(
    userId: mongoose.Types.ObjectId,
    domain: string,
    requiredScope?: string,
  ): Promise<ResolvedCredential | null> {
    const domainMatch = await googleOAuthService.getValidToken(
      userId,
      `https://${domain}/`,
      requiredScope,
    );
    const result =
      domainMatch ??
      (await googleOAuthService.getValidToken(userId, undefined, requiredScope));

    if (!result) {
      logger.debug(`No usable OAuth token for user ${userId}`);
      return null;
    }

    logger.debug(
      `Credential: OAUTH (${domainMatch ? "domain match" : "any token"}) for user ${userId} domain ${domain}`,
    );
    return {
      accessToken: result.accessToken,
      source: "OAUTH",
      tokenDoc: result.tokenDoc as unknown as IGoogleToken,
    };
  }

  private async resolvePlatform(
    consumeQuota: boolean,
  ): Promise<ResolvedCredential | null> {
    const sa = await serviceAccountPool.getAvailable(consumeQuota);
    if (!sa) return null;

    try {
      const accessToken = await serviceAccountPool.getAccessToken(sa);
      logger.debug(`Credential: SERVICE_ACCOUNT ${sa.email}`);
      return { accessToken, source: "SERVICE_ACCOUNT", serviceAccount: sa };
    } catch (error) {
      logger.error(`SA token fetch failed: ${(error as Error).message}`);
      await serviceAccountPool.reportError(
        sa._id.toString(),
        (error as Error).message,
      );
      return null;
    }
  }

  async hasOAuthConnected(userId: mongoose.Types.ObjectId): Promise<boolean> {
    const count = await GoogleToken.countDocuments({ userId, isActive: true });
    return count > 0;
  }
}

export const credentialResolver = new CredentialResolver();
