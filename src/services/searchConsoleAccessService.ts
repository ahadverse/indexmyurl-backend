import mongoose from 'mongoose';
import { GoogleToken } from '../models/GoogleToken';
import { ServiceAccount } from '../models/ServiceAccount';
import { googleOAuthService } from './googleOAuthService';
import { serviceAccountPool } from './serviceAccountPool';
import { matchProperty } from '../utils/gscProperty';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export type AccessSource = 'OAUTH' | 'SERVICE_ACCOUNT';

export interface SearchConsoleAccess {
  source: AccessSource;
  /** The property that covers the URL, in the exact form the URL Inspection API needs */
  siteUrl: string;
  /** Token to call Search Console with for this site. Never send this to a client. */
  accessToken: string;
}

/**
 * Why a user has no usable access to a URL's site:
 *  - NOT_CONNECTED:    no Google account connected, and our service account has no role on the site
 *  - NO_PROPERTY:      a Google account is connected, but the site is not in it
 *  - RECONNECT_NEEDED: the Google connection broke (access revoked or expired)
 *  - CHECK_FAILED:     Google could not be asked just now; trying again may work
 */
export type AccessFailure = 'NOT_CONNECTED' | 'NO_PROPERTY' | 'RECONNECT_NEEDED' | 'CHECK_FAILED';

export type AccessResult =
  | { ok: true; access: SearchConsoleAccess }
  | { ok: false; reason: AccessFailure };

/** Plain-language explanation of a failure, with the way to fix it. */
export function describeAccessFailure(
  reason: AccessFailure,
  url: string,
  serviceAccountEmail: string | null
): string {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    /* keep the raw text */
  }
  const orAddUs = serviceAccountEmail
    ? ` Or, in Search Console under Settings → Users and permissions, add ${serviceAccountEmail} as a Full user of ${host}.`
    : '';

  switch (reason) {
    case 'RECONNECT_NEEDED':
      return `Your Google connection has expired. Reconnect it in Settings → Google.${orAddUs}`;
    case 'NO_PROPERTY':
      return (
        `${host} is not in the Search Console of your connected Google account. ` +
        `Add and verify it there, then press Sync in Settings → Google.${orAddUs}`
      );
    case 'CHECK_FAILED':
      return "We couldn't check your Search Console access right now. Please try again in a minute.";
    case 'NOT_CONNECTED':
    default:
      return (
        `Search Console access to ${host} is required, so we can confirm the page gets indexed ` +
        `and charge you only when it does. Connect your Google account in Settings → Google.${orAddUs}`
      );
  }
}

/**
 * Decides whether a user may work on a URL, and with which credential.
 *
 * Search Console access is what lets us confirm a page was indexed, and credits are
 * charged only for confirmed pages. Access comes from either:
 *  1. the user's own connected Google account, or
 *  2. our service account, once the user has added it to their property as a Full user.
 *
 * Either way the same credential is then used for URL Inspection of that site.
 */
export class SearchConsoleAccessService {
  /** How long a service account's property list is trusted before it is read again. */
  propertiesTtlMs = 5 * 60 * 1000;
  /** Never read the same service account's list more often than this, however often asked. */
  refreshCooldownMs = 10 * 1000;

  private readonly cache = new Map<string, { at: number; properties: string[] }>();
  private readonly inflight = new Map<string, Promise<string[] | null>>();

  /** Forget every cached service-account property list (tests, or after an admin change). */
  clearCache(): void {
    this.cache.clear();
    this.inflight.clear();
  }

  async resolveForUrl(
    userId: mongoose.Types.ObjectId,
    url: string,
    opts: { refresh?: boolean } = {}
  ): Promise<AccessResult> {
    // 1. The user's own Google accounts. Their properties were stored when they
    //    connected or synced, so this needs no call to Google.
    const tokens = await GoogleToken.find({ userId, isActive: true }).sort({ createdAt: -1 });
    let brokenConnection = false;
    for (const tokenDoc of tokens) {
      const siteUrl = matchProperty(tokenDoc.gscProperties, url);
      if (!siteUrl) continue;
      const accessToken = await googleOAuthService.accessTokenFor(tokenDoc);
      if (accessToken) return { ok: true, access: { source: 'OAUTH', siteUrl, accessToken } };
      brokenConnection = true;
    }

    // 2. Our service account, if the user gave it a role on the site
    const viaServiceAccount = await this.findServiceAccountAccess(url, opts.refresh === true);
    if (viaServiceAccount.access) return { ok: true, access: viaServiceAccount.access };

    if (brokenConnection) return { ok: false, reason: 'RECONNECT_NEEDED' };
    if (viaServiceAccount.failed) return { ok: false, reason: 'CHECK_FAILED' };
    if (tokens.length > 0) return { ok: false, reason: 'NO_PROPERTY' };
    if (await GoogleToken.exists({ userId, refreshFailCount: { $gte: 3 } })) {
      return { ok: false, reason: 'RECONNECT_NEEDED' };
    }
    return { ok: false, reason: 'NOT_CONNECTED' };
  }

  /** The address users are told to add in Search Console. */
  async getServiceAccountEmail(): Promise<string | null> {
    const account = await ServiceAccount.findOne({ isActive: true }).sort({ createdAt: 1 }).select('email');
    return account?.email ?? (env.google.platformSa.email || null);
  }

  // ─── Service account path ──────────────────────────────────────────
  private async findServiceAccountAccess(
    url: string,
    refresh: boolean
  ): Promise<{ access: SearchConsoleAccess | null; failed: boolean }> {
    // Deliberately not filtered by publish quota or publish errors: reading Search
    // Console spends neither, and a service account that cannot publish can still inspect.
    const accounts = await ServiceAccount.find({ isActive: true }).sort({ createdAt: 1 });
    let failed = false;

    for (const account of accounts) {
      let accessToken: string;
      try {
        accessToken = await serviceAccountPool.getAccessToken(account);
      } catch (error) {
        failed = true;
        logger.warn(`Search Console: no token for ${account.email}: ${(error as Error).message}`);
        continue;
      }

      let properties = await this.listProperties(account.email, accessToken, refresh);
      if (properties === null) {
        failed = true;
        continue;
      }

      let siteUrl = matchProperty(properties, url);
      if (!siteUrl && !refresh) {
        // The user may have added us a moment ago. Read again, unless we just did.
        properties = (await this.listProperties(account.email, accessToken, true)) ?? properties;
        siteUrl = matchProperty(properties, url);
      }
      if (siteUrl) {
        return { access: { source: 'SERVICE_ACCOUNT', siteUrl, accessToken }, failed: false };
      }
    }
    return { access: null, failed };
  }

  /**
   * Properties this service account may act on (owner or full user), minus the
   * platform's own: anyone must not be able to claim our wrapper domain as their site.
   * Null when Google could not be asked and nothing older is known.
   */
  private async listProperties(
    key: string,
    accessToken: string,
    refresh: boolean
  ): Promise<string[] | null> {
    const cached = this.cache.get(key);
    const age = cached ? Date.now() - cached.at : Infinity;
    if (cached && age < (refresh ? this.refreshCooldownMs : this.propertiesTtlMs)) {
      return cached.properties;
    }

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = googleOAuthService
        .fetchGSCProperties(accessToken)
        .then((all) => (all === null ? null : all.filter((p) => !this.isPlatformProperty(p))))
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }

    const fresh = await pending;
    if (fresh) {
      this.cache.set(key, { at: Date.now(), properties: fresh });
      return fresh;
    }
    // Google had a hiccup: the last list we know is better than refusing everyone
    return cached?.properties ?? null;
  }

  private isPlatformProperty(property: string): boolean {
    if (env.google.platformGscSiteUrl && property === env.google.platformGscSiteUrl) return true;
    return matchProperty([property], env.server.baseUrl) !== null;
  }
}

export const searchConsoleAccessService = new SearchConsoleAccessService();
