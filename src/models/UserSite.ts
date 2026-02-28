import mongoose, { Document, Schema } from 'mongoose';

export enum SiteVerificationStatus {
  PENDING = 'PENDING',
  VERIFIED = 'VERIFIED',
  FAILED = 'FAILED',
  REVOKED = 'REVOKED',
}

export interface IUserSite extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;

  siteUrl: string;     // e.g. https://storewike.store/
  domain: string;      // e.g. storewike.store

  // Which Google token gives access to this site
  googleTokenId: mongoose.Types.ObjectId | null;
  googleEmail: string | null;    // which Google account has access

  // Fallback: platform service account (if no OAuth token)
  fallbackServiceAccountId: mongoose.Types.ObjectId | null;

  verificationStatus: SiteVerificationStatus;
  verifiedAt: Date | null;
  lastVerificationCheck: Date | null;

  // Stats
  totalUrlsSubmitted: number;
  totalUrlsIndexed: number;

  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const UserSiteSchema = new Schema<IUserSite>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    siteUrl: { type: String, required: true, trim: true },
    domain: { type: String, required: true, lowercase: true, index: true },

    googleTokenId: { type: Schema.Types.ObjectId, ref: 'GoogleToken', default: null },
    googleEmail: { type: String, default: null },

    fallbackServiceAccountId: {
      type: Schema.Types.ObjectId,
      ref: 'ServiceAccount',
      default: null,
    },

    verificationStatus: {
      type: String,
      enum: Object.values(SiteVerificationStatus),
      default: SiteVerificationStatus.PENDING,
    },
    verifiedAt: { type: Date, default: null },
    lastVerificationCheck: { type: Date, default: null },

    totalUrlsSubmitted: { type: Number, default: 0 },
    totalUrlsIndexed: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

UserSiteSchema.index({ userId: 1, siteUrl: 1 }, { unique: true });

export const UserSite = mongoose.model<IUserSite>('UserSite', UserSiteSchema);
