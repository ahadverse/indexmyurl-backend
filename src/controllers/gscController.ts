import { Request, Response, NextFunction } from 'express';
import {
  searchConsoleAccessService,
  describeAccessFailure,
} from '../services/searchConsoleAccessService';
import { isValidUrl } from '../utils/helpers';

export class GscController {
  /**
   * GET /api/gsc/access?url=<page url>[&refresh=1]
   *
   * Does this user have Search Console access to the site of this URL, and through what?
   * Always answers 200 with `hasAccess`; the reason and the fix are in `reason`/`message`.
   * `refresh=1` re-reads our service account's properties (for "I just added you" → "Check").
   */
  async getAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const url = typeof req.query.url === 'string' ? req.query.url.trim() : '';
      if (!isValidUrl(url)) {
        res.status(400).json({
          success: false,
          message: 'url is required and must start with http:// or https://',
        });
        return;
      }

      const serviceAccountEmail = await searchConsoleAccessService.getServiceAccountEmail();
      const result = await searchConsoleAccessService.resolveForUrl(req.user!._id, url, {
        refresh: req.query.refresh === '1',
      });

      if (result.ok) {
        res.json({
          success: true,
          hasAccess: true,
          source: result.access.source,
          siteUrl: result.access.siteUrl,
          serviceAccountEmail,
        });
        return;
      }

      res.json({
        success: true,
        hasAccess: false,
        reason: result.reason,
        message: describeAccessFailure(result.reason, url, serviceAccountEmail),
        serviceAccountEmail,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const gscController = new GscController();
