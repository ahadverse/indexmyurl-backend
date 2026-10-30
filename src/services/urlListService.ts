import mongoose from 'mongoose';
import { UrlJob, JobStatus } from '../models/UrlJob';

/**
 * One row per URL the user has submitted, however many times. Every submission is a job, so
 * a URL that failed and was submitted again has several; they are folded into one row that
 * shows where the URL stands now and how much has been tried.
 */

export type UrlSort = 'recent' | 'submissions' | 'url';

export interface UrlRow {
  url: string;
  domain: string;
  /** status of the most recent submission */
  status: JobStatus;
  /** the most recent submission, for the detail page */
  jobId: string;
  /** how many times this URL was submitted */
  submissions: number;
  /** requests that reached Google: each successful publish, including re-sends after "crawled, not indexed" */
  googleSubmissions: number;
  /** Indexing API calls that failed (quota waits are not counted) */
  failedCalls: number;
  /** Search Console status checks made */
  checks: number;
  firstSubmittedAt: Date;
  lastSubmittedAt: Date;
  lastCheckedAt: Date | null;
  indexedAt: Date | null;
}

export interface UrlList {
  urls: UrlRow[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  /** number of URLs per current status, for the filter tabs (ignores the status filter itself) */
  counts: Record<string, number>;
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SORTS: Record<UrlSort, Record<string, 1 | -1>> = {
  recent: { lastSubmittedAt: -1 },
  submissions: { submissions: -1, lastSubmittedAt: -1 },
  url: { _id: 1 },
};

export async function listUrls(
  userId: mongoose.Types.ObjectId,
  opts: { page: number; limit: number; search?: string; status?: JobStatus[]; sort: UrlSort }
): Promise<UrlList> {
  const match: Record<string, unknown> = { userId };
  if (opts.search) match.originalUrl = { $regex: escapeRegex(opts.search), $options: 'i' };

  const afterStatus = opts.status?.length ? [{ $match: { status: { $in: opts.status } } }] : [];

  const [result] = await UrlJob.aggregate<{
    rows: Array<Record<string, unknown>>;
    total: Array<{ n: number }>;
    byStatus: Array<{ _id: string; n: number }>;
  }>(
    [
      { $match: match },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$originalUrl',
          domain: { $first: '$domain' },
          jobId: { $first: '$_id' },
          status: { $first: '$status' }, // newest first, so this is the current one
          lastSubmittedAt: { $first: '$createdAt' },
          firstSubmittedAt: { $last: '$createdAt' },
          submissions: { $sum: 1 },
          googleSubmissions: {
            $sum: { $cond: [{ $gt: ['$apiCalledAt', null] }, { $add: [1, '$retryCount'] }, 0] },
          },
          failedCalls: { $sum: '$publishAttempts' },
          checks: { $sum: { $size: { $ifNull: ['$indexCheckResults', []] } } },
          lastCheckedAt: { $max: '$lastCheckedAt' },
          indexedAt: { $max: '$indexedAt' },
        },
      },
      {
        $facet: {
          byStatus: [{ $group: { _id: '$status', n: { $sum: 1 } } }],
          total: [...afterStatus, { $count: 'n' }],
          rows: [
            ...afterStatus,
            { $sort: SORTS[opts.sort] },
            { $skip: (opts.page - 1) * opts.limit },
            { $limit: opts.limit },
          ],
        },
      },
    ],
    { allowDiskUse: true }
  );

  const total = result?.total[0]?.n ?? 0;
  const counts: Record<string, number> = {};
  for (const { _id, n } of result?.byStatus ?? []) counts[_id] = n;

  const urls = (result?.rows ?? []).map(
    (r): UrlRow => ({
      url: r._id as string,
      domain: r.domain as string,
      status: r.status as JobStatus,
      jobId: String(r.jobId),
      submissions: r.submissions as number,
      googleSubmissions: r.googleSubmissions as number,
      failedCalls: r.failedCalls as number,
      checks: r.checks as number,
      firstSubmittedAt: r.firstSubmittedAt as Date,
      lastSubmittedAt: r.lastSubmittedAt as Date,
      lastCheckedAt: (r.lastCheckedAt as Date | null) ?? null,
      indexedAt: (r.indexedAt as Date | null) ?? null,
    })
  );

  return {
    urls,
    pagination: { page: opts.page, limit: opts.limit, total, totalPages: Math.max(1, Math.ceil(total / opts.limit)) },
    counts,
  };
}
