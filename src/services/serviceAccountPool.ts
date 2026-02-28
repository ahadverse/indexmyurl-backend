import { JWT } from 'google-auth-library';
import { ServiceAccount, IServiceAccount } from '../models/ServiceAccount';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// Cache JWT clients in memory
const jwtClientCache = new Map<string, JWT>();

export class ServiceAccountPool {
  // ─── Seed platform SA from env on startup ─────────────────────────
  async seedFromEnv(): Promise<void> {
    const { email, privateKey, projectId } = env.google.platformSa;
    if (!email || !privateKey || !projectId) {
      logger.warn('No platform service account in env — fallback pool empty');
      return;
    }

    await ServiceAccount.findOneAndUpdate(
      { email },
      { email, privateKey, projectId, isActive: true },
      { upsert: true }
    );

    logger.info(`Platform service account seeded: ${email}`);
  }

  // ─── Get best available SA (least used, has quota) ────────────────
  async getAvailable(): Promise<IServiceAccount | null> {
    await this.resetExpiredQuotas();

    const account = await ServiceAccount.findOneAndUpdate(
      {
        isActive: true,
        consecutiveErrors: { $lt: 5 },
        $expr: { $lt: ['$dailyQuotaUsed', '$dailyQuotaLimit'] },
      },
      {
        $inc: { dailyQuotaUsed: 1 },
        $set: { lastUsedAt: new Date() },
      },
      { sort: { dailyQuotaUsed: 1 }, new: true }
    );

    if (!account) {
      logger.warn('No service account available in pool');
      return null;
    }

    logger.debug(
      `SA selected: ${account.email} | quota: ${account.dailyQuotaUsed}/${account.dailyQuotaLimit}`
    );
    return account;
  }

  // ─── Get JWT client (cached) ──────────────────────────────────────
  getJwtClient(account: IServiceAccount): JWT {
    const cached = jwtClientCache.get(account.email);
    if (cached) return cached;

    const client = new JWT({
      email: account.email,
      key: account.privateKey.replace(/\\n/g, '\n'),
      scopes: [
        'https://www.googleapis.com/auth/indexing',
        'https://www.googleapis.com/auth/webmasters.readonly',
      ],
    });

    jwtClientCache.set(account.email, client);
    return client;
  }

  // ─── Get access token ─────────────────────────────────────────────
  async getAccessToken(account: IServiceAccount): Promise<string> {
    const client = this.getJwtClient(account);
    const res = await client.getAccessToken();
    if (!res.token) throw new Error(`Failed to get token for SA: ${account.email}`);
    return res.token;
  }

  // ─── Report success/error ────────────────────────────────────────
  async reportSuccess(accountId: string): Promise<void> {
    await ServiceAccount.findByIdAndUpdate(accountId, {
      $set: { consecutiveErrors: 0 },
    });
  }

  async reportError(accountId: string, message: string): Promise<void> {
    const account = await ServiceAccount.findByIdAndUpdate(
      accountId,
      {
        $inc: { consecutiveErrors: 1 },
        $set: { lastErrorAt: new Date(), lastErrorMessage: message },
      },
      { new: true }
    );

    if (account && account.consecutiveErrors >= 5) {
      await ServiceAccount.findByIdAndUpdate(accountId, { isActive: false });
      logger.error(
        `SA ${account.email} auto-deactivated after ${account.consecutiveErrors} consecutive errors`
      );
    }
  }

  // ─── Reset expired quotas ─────────────────────────────────────────
  private async resetExpiredQuotas(): Promise<void> {
    const now = new Date();
    const tomorrow = new Date();
    tomorrow.setUTCHours(24, 0, 0, 0);

    await ServiceAccount.updateMany(
      { quotaResetAt: { $lte: now } },
      { $set: { dailyQuotaUsed: 0, quotaResetAt: tomorrow } }
    );
  }

  // ─── Add new SA to pool ───────────────────────────────────────────
  async addAccount(data: {
    email: string;
    privateKey: string;
    projectId: string;
    dailyQuotaLimit?: number;
  }): Promise<IServiceAccount> {
    // Clear cached JWT client if exists
    jwtClientCache.delete(data.email);

    const account = await ServiceAccount.findOneAndUpdate(
      { email: data.email },
      {
        email: data.email,
        privateKey: data.privateKey.replace(/\\n/g, '\n'),
        projectId: data.projectId,
        dailyQuotaLimit: data.dailyQuotaLimit ?? 180,
        isActive: true,
        consecutiveErrors: 0,
      },
      { upsert: true, new: true }
    );

    logger.info(`Service account added/updated: ${account.email}`);
    return account;
  }

  // ─── Quota summary ────────────────────────────────────────────────
  async getQuotaSummary() {
    await this.resetExpiredQuotas();
    const accounts = await ServiceAccount.find({ isActive: true });
    const available = accounts.filter(
      (a) => a.dailyQuotaUsed < a.dailyQuotaLimit && a.consecutiveErrors < 5
    );

    return {
      totalAccounts: accounts.length,
      availableAccounts: available.length,
      totalDailyCapacity: accounts.reduce((s, a) => s + a.dailyQuotaLimit, 0),
      totalQuotaRemaining: available.reduce(
        (s, a) => s + (a.dailyQuotaLimit - a.dailyQuotaUsed),
        0
      ),
      accounts: accounts.map((a) => ({
        id: a._id,
        email: a.email,
        isActive: a.isActive,
        quotaUsed: a.dailyQuotaUsed,
        quotaLimit: a.dailyQuotaLimit,
        quotaRemaining: a.dailyQuotaLimit - a.dailyQuotaUsed,
        consecutiveErrors: a.consecutiveErrors,
        lastError: a.lastErrorMessage,
        lastUsedAt: a.lastUsedAt,
      })),
    };
  }
}

export const serviceAccountPool = new ServiceAccountPool();
