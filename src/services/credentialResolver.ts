import mongoose from "mongoose";
import { GoogleToken } from "../models/GoogleToken";
import { googleOAuthService } from "./googleOAuthService";
import { serviceAccountPool } from "./serviceAccountPool";
import { IServiceAccount } from "../models/ServiceAccount";
import { IGoogleToken } from "../models/GoogleToken";
import { logger } from "../utils/logger";

export type CredentialSource = "OAUTH" | "SERVICE_ACCOUNT";

export interface ResolvedCredential {
  accessToken: string;
  source: CredentialSource;
  tokenDoc?: IGoogleToken;
  serviceAccount?: IServiceAccount;
}

export class CredentialResolver {
  async resolve(
    userId: mongoose.Types.ObjectId,
    domain: string,
  ): Promise<ResolvedCredential | null> {
    // 1. Try domain-specific OAuth token (checks https:// and sc-domain:)
    const siteUrl = `https://${domain}/`;
    const oauthResult = await googleOAuthService.getValidToken(userId, siteUrl);

    if (oauthResult) {
      logger.debug(
        `Credential: OAUTH (domain match) for user ${userId} domain ${domain}`,
      );
      return {
        accessToken: oauthResult.accessToken,
        source: "OAUTH",
        tokenDoc: oauthResult.tokenDoc as unknown as IGoogleToken,
      };
    }

    // 2. Try ANY active token for this user — direct DB query, no property filter
    const anyToken = await GoogleToken.findOne({ userId, isActive: true }).sort(
      { createdAt: -1 },
    );

    if (anyToken) {
      logger.debug(
        `Credential: OAUTH (any token) for user ${userId} | token: ${anyToken._id} | expires: ${anyToken.expiresAt}`,
      );

      const isExpired =
        new Date() >= new Date(anyToken.expiresAt.getTime() - 5 * 60 * 1000);

      if (!isExpired) {
        logger.debug(`Token still valid, using directly`);
        return {
          accessToken: anyToken.accessToken,
          source: "OAUTH",
          tokenDoc: anyToken as unknown as IGoogleToken,
        };
      }

      // Token expired — try refresh
      logger.debug(
        `Token expired, attempting refresh for ${anyToken.googleEmail}`,
      );
      const result = await googleOAuthService.getValidToken(userId);
      if (result) {
        logger.debug(`Token refreshed successfully`);
        return {
          accessToken: result.accessToken,
          source: "OAUTH",
          tokenDoc: result.tokenDoc as unknown as IGoogleToken,
        };
      }

      logger.warn(
        `Token refresh failed for user ${userId} — token may need reconnect`,
      );
    }

    // 3. Fallback: platform service account
    const sa = await serviceAccountPool.getAvailable();
    if (sa) {
      try {
        const accessToken = await serviceAccountPool.getAccessToken(sa);
        logger.debug(
          `Credential: SERVICE_ACCOUNT for user ${userId} domain ${domain}`,
        );
        return { accessToken, source: "SERVICE_ACCOUNT", serviceAccount: sa };
      } catch (error) {
        logger.error(`SA token fetch failed: ${(error as Error).message}`);
        await serviceAccountPool.reportError(
          sa._id.toString(),
          (error as Error).message,
        );
      }
    }

    logger.error(
      `No credential available for user ${userId} domain ${domain}. ` +
        `Active tokens: ${anyToken ? 1 : 0}. SA pool available: ${!!sa}`,
    );
    return null;
  }

  async hasOAuthConnected(userId: mongoose.Types.ObjectId): Promise<boolean> {
    const count = await GoogleToken.countDocuments({ userId, isActive: true });
    return count > 0;
  }
}

export const credentialResolver = new CredentialResolver();
