import mongoose, { Document, Schema } from 'mongoose';

export enum JobStatus {
  PENDING = 'PENDING',
  QUEUED = 'QUEUED',
  WRAPPER_CREATED = 'WRAPPER_CREATED',
  API_CALLED = 'API_CALLED',
  WAITING_CRAWL = 'WAITING_CRAWL',
  CRAWLED_NOT_INDEXED = 'CRAWLED_NOT_INDEXED',
  INDEXED = 'INDEXED',
  RETRYING = 'RETRYING',
  FAILED = 'FAILED',
}

export type IndexCheckSource = 'GSC_API' | 'GSC_API_PRECHECK' | 'FALLBACK' | 'ERROR';

export interface IUrlJob extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  originalUrl: string;
  domain: string;
  status: JobStatus;

  // Which credential was used
  credentialSource: 'OAUTH' | 'SERVICE_ACCOUNT' | null;
  googleTokenId: mongoose.Types.ObjectId | null;       // if OAuth
  serviceAccountId: mongoose.Types.ObjectId | null;    // if service account

  // Wrapper
  wrapperId: string | null;
  wrapperUrl: string | null;
  wrapperActiveAt: Date | null;
  wrapperDeactivatedAt: Date | null;

  // Retry
  retryCount: number;
  lastRetryAt: Date | null;
  nextRetryAt: Date | null;

  // Indexing API call tracking
  publishAttempts: number;      // failed API calls (quota waits don't count)
  nextPublishAt: Date | null;   // set when the call is deferred (quota / backoff)
  lastCheckedAt: Date | null;   // last Search Console status check

  // Timestamps
  queuedAt: Date | null;
  apiCalledAt: Date | null;
  indexedAt: Date | null;
  failedAt: Date | null;

  // Credit
  creditReservedAt: Date | null;
  creditDeductedAt: Date | null;
  creditRefundedAt: Date | null;

  // Results
  googleApiResponse: Record<string, unknown> | null;
  indexCheckResults: Array<{
    checkedAt: Date;
    status: string;
    source: IndexCheckSource;
  }>;

  errorLog: Array<{
    timestamp: Date;
    message: string;
    step: string;
  }>;

  createdAt: Date;
  updatedAt: Date;
}

const UrlJobSchema = new Schema<IUrlJob>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    originalUrl: { type: String, required: true, trim: true },
    domain: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: Object.values(JobStatus),
      default: JobStatus.PENDING,
      index: true,
    },

    credentialSource: { type: String, enum: ['OAUTH', 'SERVICE_ACCOUNT'], default: null },
    googleTokenId: { type: Schema.Types.ObjectId, ref: 'GoogleToken', default: null },
    serviceAccountId: { type: Schema.Types.ObjectId, ref: 'ServiceAccount', default: null },

    wrapperId: { type: String, default: null },
    wrapperUrl: { type: String, default: null },
    wrapperActiveAt: { type: Date, default: null },
    wrapperDeactivatedAt: { type: Date, default: null },

    retryCount: { type: Number, default: 0 },
    lastRetryAt: { type: Date, default: null },
    nextRetryAt: { type: Date, default: null },

    publishAttempts: { type: Number, default: 0 },
    nextPublishAt: { type: Date, default: null },
    lastCheckedAt: { type: Date, default: null },

    queuedAt: { type: Date, default: null },
    apiCalledAt: { type: Date, default: null },
    indexedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },

    creditReservedAt: { type: Date, default: null },
    creditDeductedAt: { type: Date, default: null },
    creditRefundedAt: { type: Date, default: null },

    googleApiResponse: { type: Schema.Types.Mixed, default: null },
    indexCheckResults: [{ checkedAt: Date, status: String, source: String }],
    errorLog: [
      {
        timestamp: { type: Date, default: Date.now },
        message: String,
        step: String,
      },
    ],
  },
  { timestamps: true }
);

// Prevent duplicate active submission of same URL by same user.
// MongoDB cannot build a partial index from $nin/$not (CannotCreateIndex), so list the
// still-active statuses explicitly — derived from the enum, so a new status counts as
// active by default. `$in` in a partial filter needs MongoDB >= 6.0.
const ACTIVE_STATUSES = Object.values(JobStatus).filter(
  (status) => status !== JobStatus.FAILED && status !== JobStatus.INDEXED
);
UrlJobSchema.index(
  { userId: 1, originalUrl: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ACTIVE_STATUSES } } }
);

UrlJobSchema.index({ status: 1, nextRetryAt: 1 });
UrlJobSchema.index({ domain: 1, status: 1 });
UrlJobSchema.index({ createdAt: 1 });

export const UrlJob = mongoose.model<IUrlJob>('UrlJob', UrlJobSchema);
