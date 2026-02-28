import { Request, Response, NextFunction } from 'express';
import { User } from '../models/User';
import { signToken } from '../utils/jwt';
import { generateApiKey } from '../utils/helpers';

export class AuthController {
  /**
   * POST /api/auth/register
   * Body: { firstName, lastName, email, password }
   */
  async register(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { firstName, lastName, email, password } = req.body as {
        firstName: string;
        lastName: string;
        email: string;
        password: string;
      };

      // Validate fields
      if (!firstName?.trim()) {
        res.status(400).json({ success: false, message: 'firstName is required' });
        return;
      }
      if (!lastName?.trim()) {
        res.status(400).json({ success: false, message: 'lastName is required' });
        return;
      }
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        res.status(400).json({ success: false, message: 'Valid email is required' });
        return;
      }
      if (!password || password.length < 8) {
        res.status(400).json({
          success: false,
          message: 'Password must be at least 8 characters',
        });
        return;
      }

      // Check duplicate email
      const existing = await User.findOne({ email: email.toLowerCase() });
      if (existing) {
        res.status(409).json({ success: false, message: 'Email already registered' });
        return;
      }

      // Create user (password hashed by pre-save hook)
      const user = await User.create({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.toLowerCase(),
        password,
        authProvider: 'local',
        apiKey: generateApiKey(),
        credits: 5,
        isEmailVerified: false,
      });

      const token = signToken({ userId: user._id.toString(), email: user.email });

      res.status(201).json({
        success: true,
        message: 'Account created successfully! You have 5 free credits.',
        token,
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          credits: user.credits,
          apiKey: user.apiKey,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/auth/login
   * Body: { email, password }
   */
  async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { email, password } = req.body as { email: string; password: string };

      if (!email || !password) {
        res.status(400).json({ success: false, message: 'Email and password are required' });
        return;
      }

      const user = await User.findOne({ email: email.toLowerCase() });

      if (!user) {
        res.status(401).json({ success: false, message: 'Invalid email or password' });
        return;
      }

      if (!user.isActive) {
        res.status(403).json({ success: false, message: 'Account is deactivated' });
        return;
      }

      // Google-only account trying to use password login
      if (user.authProvider === 'google' && !user.password) {
        res.status(400).json({
          success: false,
          message: 'This account uses Google login. Please sign in with Google.',
        });
        return;
      }

      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        res.status(401).json({ success: false, message: 'Invalid email or password' });
        return;
      }

      await User.findByIdAndUpdate(user._id, { lastLoginAt: new Date() });

      const token = signToken({ userId: user._id.toString(), email: user.email });

      res.json({
        success: true,
        message: 'Login successful',
        token,
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          credits: user.credits,
          availableCredits: user.credits - user.reservedCredits,
          apiKey: user.apiKey,
          authProvider: user.authProvider,
          profilePicture: user.profilePicture,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/auth/me
   * Returns logged-in user's profile
   */
  async getProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = req.user!;

      res.json({
        success: true,
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          fullName: user.getFullName(),
          email: user.email,
          profilePicture: user.profilePicture,
          authProvider: user.authProvider,
          credits: user.credits,
          reservedCredits: user.reservedCredits,
          availableCredits: user.credits - user.reservedCredits,
          dailySubmissions: user.dailySubmissions,
          apiKey: user.apiKey,
          isEmailVerified: user.isEmailVerified,
          memberSince: user.createdAt,
          lastLoginAt: user.lastLoginAt,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/auth/profile
   * Update name / profile picture
   */
  async updateProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { firstName, lastName, profilePicture } = req.body as {
        firstName?: string;
        lastName?: string;
        profilePicture?: string;
      };

      const updates: Record<string, string> = {};
      if (firstName?.trim()) updates.firstName = firstName.trim();
      if (lastName?.trim()) updates.lastName = lastName.trim();
      if (profilePicture) updates.profilePicture = profilePicture;

      if (Object.keys(updates).length === 0) {
        res.status(400).json({ success: false, message: 'No fields to update' });
        return;
      }

      const user = await User.findByIdAndUpdate(req.user!._id, updates, { new: true });

      res.json({
        success: true,
        message: 'Profile updated',
        user: {
          id: user!._id,
          firstName: user!.firstName,
          lastName: user!.lastName,
          profilePicture: user!.profilePicture,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/auth/change-password
   * Body: { currentPassword, newPassword }
   */
  async changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { currentPassword, newPassword } = req.body as {
        currentPassword: string;
        newPassword: string;
      };

      if (!currentPassword || !newPassword) {
        res.status(400).json({
          success: false,
          message: 'currentPassword and newPassword are required',
        });
        return;
      }

      if (newPassword.length < 8) {
        res.status(400).json({
          success: false,
          message: 'New password must be at least 8 characters',
        });
        return;
      }

      const user = req.user!;

      if (!user.password) {
        res.status(400).json({
          success: false,
          message: 'Google account. Set a password first via /api/auth/set-password',
        });
        return;
      }

      const isMatch = await user.comparePassword(currentPassword);
      if (!isMatch) {
        res.status(400).json({ success: false, message: 'Current password is incorrect' });
        return;
      }

      user.password = newPassword; // pre-save hook will hash it
      await user.save();

      res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/auth/regenerate-key
   * Get new API key
   */
  async regenerateApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const newKey = generateApiKey();
      await User.findByIdAndUpdate(req.user!._id, { apiKey: newKey });
      res.json({ success: true, message: 'API key regenerated', apiKey: newKey });
    } catch (error) {
      next(error);
    }
  }
}

export const authController = new AuthController();
