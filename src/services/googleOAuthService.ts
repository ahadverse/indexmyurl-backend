import { OAuth2Client } from 'google-auth-library';
import axios from 'axios';
import mongoose from 'mongoose';
import { User } from '../models/User';
import { GoogleToken } from '../models/GoogleToken';
import { UserSite, SiteVerificationStatus } from '../models/UserSite';
import { signToken } from '../utils/jwt';
import { generateApiKey, extractDomain, normalizeSiteUrl } from '../utils/helpers';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/indexing',
  'https://www.googleapis.com/auth/webmasters.readonly',
  'openid',
  'email',
  'profile',
];

// state param আলাদা করি: login vs connect
// login:   state = "login"
// connect: state = "connect:userId"
function parseState(state: string): { type: 'login' | 'connect'; userId?: string } {
  if (state.startsWith('connect:')) {
    return { type: 'connect', userId: state.replace('connect:', '') };
  }
  return { type: 'login' };
}

export class GoogleOAuthService {
  private createClient(): OAuth2Client {
    return new OAuth2Client(
      env.google.oauth.clientId,
      env.google.oauth.clientSecret,
      env.google.oauth.redirectUri
    );
  }

  // ─── Auth URL for new login ───────────────────────────────────────
  generateLoginUrl(): string {
    return this.createClient().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: GOOGLE_SCOPES,
      state: 'login',
    });
  }

  // ─── Auth URL to connect GSC to existing account ──────────────────
  generateConnectUrl(userId: string): string {
    return this.createClient().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: GOOGLE_SCOPES,
      state: `connect:${userId}`,
    });
  }

  // ─── Handle callback from Google ─────────────────────────────────
  async handleCallback(code: string, state: string): Promise<{
    success: boolean;
    jwtToken?: string;      // returned for login flow
    user?: object;
    gscProperties?: string[];
    message: string;
  }> {
    const client = this.createClient();

    try {
      const { tokens } = await client.getToken(code);
      if (!tokens.access_token) {
        return { success: false, message: 'Google did not return an access token' };
      }

      // Get user info from Google
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token!,
        audience: env.google.oauth.clientId,
      });
      const payload = ticket.getPayload()!;
      const googleId = payload.sub!;
      const email = payload.email!;
      const firstName = payload.given_name || 'User';
      const lastName = payload.family_name || '';
      const picture = payload.picture || null;
      const expiresAt = new Date(tokens.expiry_date || Date.now() + 3600 * 1000);

      const { type, userId: stateUserId } = parseState(state);

      // ─── CONNECT flow: attach Google to existing account ──────────
      if (type === 'connect' && stateUserId) {
        return this.handleConnect(
          stateUserId, googleId, email, tokens, expiresAt, picture
        );
      }

      // ─── LOGIN flow: login or auto-register ───────────────────────
      return this.handleLogin(
        googleId, email, firstName, lastName, picture, tokens, expiresAt
      );
    } catch (error) {
      logger.error('Google OAuth callback error:', error);
      return { success: false, message: `OAuth error: ${(error as Error).message}` };
    }
  }

  // ─── LOGIN: find or create user, return JWT ───────────────────────
  private async handleLogin(
    googleId: string,
    email: string,
    firstName: string,
    lastName: string,
    picture: string | null,
    tokens: { access_token?: string | null; refresh_token?: string | null; scope?: string; token_type?: string | null },
    expiresAt: Date
  ) {
    // Find by googleId or email
    let user = await User.findOne({ $or: [{ googleId }, { email }] });

    if (!user) {
      // Auto-register with Google
      user = await User.create({
        firstName,
        lastName,
        email,
        password: null,
        profilePicture: picture,
        authProvider: 'google',
        googleId,
        apiKey: generateApiKey(),
        credits: 5,
        isEmailVerified: true, // Google verified the email
      });
      logger.info(`New user registered via Google: ${email}`);
    } else {
      // Existing user — update Google info
      const updates: Record<string, unknown> = {
        googleId,
        lastLoginAt: new Date(),
        ...(picture && { profilePicture: picture }),
        authProvider: user.authProvider === 'local' ? 'both' : user.authProvider,
      };
      await User.findByIdAndUpdate(user._id, updates);
    }

    // Save/update Google token for GSC access
    if (tokens.access_token) {
      await this.saveGoogleToken(
        user._id, googleId, email, tokens, expiresAt
      );
    }

    const jwtToken = signToken({ userId: user._id.toString(), email: user.email });
    await User.findByIdAndUpdate(user._id, { lastLoginAt: new Date() });

    return {
      success: true,
      jwtToken,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        profilePicture: picture || user.profilePicture,
        credits: user.credits,
        apiKey: user.apiKey,
      },
      message: 'Google login successful',
    };
  }

  // ─── CONNECT: link Google to existing logged-in account ───────────
  private async handleConnect(
    userId: string,
    googleId: string,
    email: string,
    tokens: { access_token?: string | null; refresh_token?: string | null; scope?: string; token_type?: string | null },
    expiresAt: Date,
    picture: string | null
  ) {
    const user = await User.findById(userId);
    if (!user) return { success: false, message: 'User not found' };

    // Update user
    await User.findByIdAndUpdate(userId, {
      googleId,
      authProvider: 'both',
      isEmailVerified: true,
      ...(picture && !user.profilePicture && { profilePicture: picture }),
    });

    // Save token + fetch GSC properties
    if (tokens.access_token) {
      const tokenDoc = await this.saveGoogleToken(
        user._id, googleId, email, tokens, expiresAt
      );

      // Sync GSC properties
      if (tokenDoc && tokens.access_token) {
        const props = await this.fetchGSCProperties(tokens.access_token);
        await GoogleToken.findByIdAndUpdate(tokenDoc._id, {
          gscProperties: props,
          lastPropertiesSyncAt: new Date(),
        });
        await this.syncUserSites(user._id, tokenDoc._id, email, props);
      }
    }

    const accounts = await this.getConnectedAccounts(user._id);

    return {
      success: true,
      message: 'Google account connected to your profile',
      accounts,
    };
  }

  // ─── Save/update Google token in DB ──────────────────────────────
  private async saveGoogleToken(
    userId: mongoose.Types.ObjectId,
    googleAccountId: string,
    googleEmail: string,
    tokens: { access_token?: string | null; refresh_token?: string | null; scope?: string; token_type?: string | null },
    expiresAt: Date
  ) {
    if (!tokens.access_token) return null;

    const update: Record<string, unknown> = {
      accessToken: tokens.access_token,
      tokenType: tokens.token_type || 'Bearer',
      expiresAt,
      googleEmail,
      googleAccountId,
      scopes: tokens.scope?.split(' ') || GOOGLE_SCOPES,
      isActive: true,
      refreshFailCount: 0,
    };

    // Only update refreshToken if a new one came (Google sometimes omits it)
    if (tokens.refresh_token) {
      update.refreshToken = tokens.refresh_token;
    }

    return GoogleToken.findOneAndUpdate(
      { userId, googleAccountId },
      update,
      { upsert: true, new: true }
    );
  }

  // ─── Get valid access token (auto-refresh if expired) ────────────
  async getValidToken(
    userId: mongoose.Types.ObjectId,
    siteUrl?: string
  ): Promise<{ accessToken: string; tokenDoc: InstanceType<typeof GoogleToken> } | null> {
    const query: Record<string, unknown> = { userId, isActive: true };

    if (siteUrl) {
      const normalized = normalizeSiteUrl(siteUrl);
      query.$or = [
        { gscProperties: normalized },
        { gscProperties: normalized.replace(/\/$/, '') },
        { gscProperties: `sc-domain:${extractDomain(siteUrl)}` },
      ];
    }

    const tokenDoc = await GoogleToken.findOne(query).sort({ createdAt: -1 });
    if (!tokenDoc) return null;

    const isExpired = new Date() >= new Date(tokenDoc.expiresAt.getTime() - 5 * 60 * 1000);
    if (!isExpired) return { accessToken: tokenDoc.accessToken, tokenDoc };

    const refreshed = await this.refreshToken(tokenDoc);
    if (!refreshed) return null;

    return { accessToken: refreshed, tokenDoc };
  }

  private async refreshToken(tokenDoc: InstanceType<typeof GoogleToken>): Promise<string | null> {
    const client = this.createClient();
    client.setCredentials({ refresh_token: tokenDoc.refreshToken });

    try {
      const { credentials } = await client.refreshAccessToken();
      await GoogleToken.findByIdAndUpdate(tokenDoc._id, {
        accessToken: credentials.access_token!,
        expiresAt: new Date(credentials.expiry_date || Date.now() + 3600 * 1000),
        refreshFailCount: 0,
        lastUsedAt: new Date(),
      });
      return credentials.access_token!;
    } catch {
      const count = tokenDoc.refreshFailCount + 1;
      await GoogleToken.findByIdAndUpdate(tokenDoc._id, {
        refreshFailCount: count,
        ...(count >= 3 && { isActive: false }),
      });
      return null;
    }
  }

  async fetchGSCProperties(accessToken: string): Promise<string[]> {
    try {
      const res = await axios.get<{
        siteEntry?: Array<{ siteUrl: string; permissionLevel: string }>;
      }>('https://www.googleapis.com/webmasters/v3/sites', {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 10000,
      });
      return (res.data.siteEntry || [])
        .filter((s) => ['siteOwner', 'siteFullUser'].includes(s.permissionLevel))
        .map((s) => s.siteUrl);
    } catch {
      return [];
    }
  }

  private async syncUserSites(
    userId: mongoose.Types.ObjectId,
    tokenId: mongoose.Types.ObjectId,
    googleEmail: string,
    gscProperties: string[]
  ): Promise<void> {
    for (const siteUrl of gscProperties) {
      try {
        const urlForDomain = siteUrl.startsWith('sc-domain:')
          ? `https://${siteUrl.replace('sc-domain:', '')}`
          : siteUrl;
        const domain = extractDomain(urlForDomain);

        await UserSite.findOneAndUpdate(
          { userId, siteUrl },
          {
            userId, siteUrl, domain,
            googleTokenId: tokenId,
            googleEmail,
            verificationStatus: SiteVerificationStatus.VERIFIED,
            verifiedAt: new Date(),
            lastVerificationCheck: new Date(),
          },
          { upsert: true, new: true }
        );
      } catch {
        logger.warn(`Failed to sync UserSite for ${siteUrl}`);
      }
    }
  }

  async disconnectAccount(userId: mongoose.Types.ObjectId, googleAccountId: string): Promise<void> {
    const token = await GoogleToken.findOneAndUpdate(
      { userId, googleAccountId },
      { isActive: false }
    );
    if (token) {
      await UserSite.updateMany(
        { userId, googleTokenId: token._id },
        { verificationStatus: SiteVerificationStatus.REVOKED }
      );
    }
  }

  async getConnectedAccounts(userId: mongoose.Types.ObjectId) {
    const tokens = await GoogleToken.find({ userId }).select(
      'googleEmail googleAccountId gscProperties isActive refreshFailCount createdAt lastUsedAt'
    );
    return tokens.map((t) => ({
      id: t._id,
      googleEmail: t.googleEmail,
      googleAccountId: t.googleAccountId,
      gscProperties: t.gscProperties,
      isActive: t.isActive,
      needsReconnect: t.refreshFailCount >= 3,
      propertiesCount: t.gscProperties.length,
      connectedAt: t.createdAt,
    }));
  }

  async syncProperties(userId: mongoose.Types.ObjectId): Promise<void> {
    const tokens = await GoogleToken.find({ userId, isActive: true });
    for (const token of tokens) {
      const result = await this.getValidToken(userId);
      if (!result) continue;
      const props = await this.fetchGSCProperties(result.accessToken);
      await GoogleToken.findByIdAndUpdate(token._id, {
        gscProperties: props,
        lastPropertiesSyncAt: new Date(),
      });
      await this.syncUserSites(token.userId, token._id, token.googleEmail, props);
    }
  }
}

export const googleOAuthService = new GoogleOAuthService();
