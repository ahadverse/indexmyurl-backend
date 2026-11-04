import mongoose, { Document, Schema } from 'mongoose';

export enum WrapperStatus {
  ACTIVE = 'ACTIVE',
  NOINDEX = 'NOINDEX',
  DELETED = 'DELETED',
}

export interface IWrapperPage extends Document {
  _id: mongoose.Types.ObjectId;
  wrapperId: string;
  jobId: mongoose.Types.ObjectId;
  originalUrl: string;
  wrapperUrl: string;
  htmlContent: string;
  status: WrapperStatus;
  /** Which design this wrapper uses (see utils/wrapperTemplates.ts) */
  template: string;
  /** How many times the content has been refreshed (0 = never) */
  revision: number;
  /** When the content last changed; served as Last-Modified. Null = still the first version. */
  refreshedAt: Date | null;
  /** Indexing API notifications that succeeded for this URL (the first publish counts as 1) */
  notifyCount: number;
  lastNotifiedAt: Date | null;
  expiresAt: Date;
  crawledAt: Date | null;
  deactivatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const WrapperPageSchema = new Schema<IWrapperPage>(
  {
    wrapperId: { type: String, required: true, unique: true, index: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'UrlJob', required: true, index: true },
    originalUrl: { type: String, required: true },
    wrapperUrl: { type: String, required: true },
    htmlContent: { type: String, required: true },
    status: {
      type: String,
      enum: Object.values(WrapperStatus),
      default: WrapperStatus.ACTIVE,
      index: true,
    },
    template: { type: String, default: 'listing' },
    revision: { type: Number, default: 0 },
    refreshedAt: { type: Date, default: null },
    notifyCount: { type: Number, default: 0 },
    lastNotifiedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true, index: true },
    crawledAt: { type: Date, default: null },
    deactivatedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const WrapperPage = mongoose.model<IWrapperPage>('WrapperPage', WrapperPageSchema);
