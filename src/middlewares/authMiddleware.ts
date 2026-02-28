import { Request, Response, NextFunction } from 'express';
import { User, IUser } from '../models/User';
import { verifyToken } from '../utils/jwt';

declare global {
  namespace Express {
    interface Request {
      user?: IUser;
    }
  }
}

/**
 * JWT Auth — checks Authorization: Bearer <token>
 * Also supports X-Api-Key for developer/API usage
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    let user: IUser | null = null;

    const authHeader = req.headers['authorization'];
    const apiKeyHeader = req.headers['x-api-key'] as string;

    if (authHeader?.startsWith('Bearer ')) {
      // JWT token
      const token = authHeader.split(' ')[1];
      const payload = verifyToken(token);
      user = await User.findById(payload.userId);
    } else if (apiKeyHeader) {
      // API key (for developer integrations)
      user = await User.findOne({ apiKey: apiKeyHeader });
    }

    if (!user || !user.isActive) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized. Send: Authorization: Bearer <token>',
      });
      return;
    }

    req.user = user;
    next();
  } catch {
    res.status(401).json({
      success: false,
      message: 'Invalid or expired token. Please login again.',
    });
  }
}

/**
 * Admin key middleware
 */
export function adminMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_SECRET_KEY) {
    res.status(403).json({ success: false, message: 'Admin access required' });
    return;
  }
  next();
}
