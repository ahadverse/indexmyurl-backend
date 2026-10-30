import { Request, Response, NextFunction } from 'express';
import { googleOAuthService } from '../services/googleOAuthService';
import { credentialResolver } from '../services/credentialResolver';
import { env } from '../config/env';

export class OAuthController {
  /**
   * GET /api/oauth/google/login-url
   * Returns Google login URL — for new login / register via Google
   * No auth required
   */
  async getLoginUrl(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const url = googleOAuthService.generateLoginUrl();
      res.json({
        success: true,
        url,
        instructions: 'Redirect user to this URL to login/register with Google',
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/oauth/google/connect-url
   * Returns Google connect URL — to link GSC to existing logged-in account
   * Auth required
   */
  async getConnectUrl(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const url = googleOAuthService.generateConnectUrl(req.user!._id.toString());
      res.json({
        success: true,
        url,
        instructions: 'Redirect user to this URL to connect their Google Search Console',
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/oauth/google/callback?code=...&state=...
   * Google redirects here after consent
   * Handles both: login flow and connect flow
   */
  async handleCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code, state, error } = req.query as {
        code?: string;
        state?: string;
        error?: string;
      };

      if (error) {
        return void res.redirect(
          `${env.server.frontendUrl}/auth/callback?error=${encodeURIComponent(error)}`
        );
      }

      if (!code || !state) {
        res.status(400).json({ success: false, message: 'Missing code or state' });
        return;
      }

      const result = await googleOAuthService.handleCallback(code, state);

      if (!result.success) {
        return void res.redirect(
          `${env.server.frontendUrl}/auth/callback?error=${encodeURIComponent(result.message)}`
        );
      }

      // Login flow → redirect with JWT token
      if (result.jwtToken) {
        return void res.redirect(
          `${env.server.frontendUrl}/auth/callback?` +
          `token=${encodeURIComponent(result.jwtToken)}&` +
          `success=true`
        );
      }

      // Connect flow → redirect to settings
      return void res.redirect(
        `${env.server.frontendUrl}/settings/google?connected=true`
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/oauth/google/accounts
   * List Google accounts connected to this user (for GSC access)
   */
  async listAccounts(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!._id;
      const accounts = await googleOAuthService.getConnectedAccounts(userId);
      const hasOAuth = await credentialResolver.hasOAuthConnected(userId);

      res.json({
        success: true,
        hasGoogleConnected: hasOAuth,
        // Lets the UI describe accurately whether a user's own token can publish
        publishCredentialMode: env.google.publishCredentialMode,
        totalAccounts: accounts.length,
        totalProperties: accounts.reduce((s, a) => s + a.propertiesCount, 0),
        accounts,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/oauth/google/sync
   * Re-fetch GSC properties from Google
   */
  async syncProperties(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await googleOAuthService.syncProperties(req.user!._id);
      const accounts = await googleOAuthService.getConnectedAccounts(req.user!._id);
      res.json({ success: true, message: 'GSC properties synced', accounts });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/oauth/google/:googleAccountId
   * Disconnect a Google account
   */
  async disconnect(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await googleOAuthService.disconnectAccount(req.user!._id, req.params.googleAccountId);
      res.json({ success: true, message: 'Google account disconnected' });
    } catch (error) {
      next(error);
    }
  }
}

export const oauthController = new OAuthController();
