import { UrlJob, JobStatus } from '../models/UrlJob';
import { WrapperPage } from '../models/WrapperPage';
import { LIVE_TEMPLATE_IDS, WrapperKind, isWrapperTemplateId, kindOfTemplate } from '../utils/wrapperTemplates';

const HOUR = 60 * 60 * 1000;
const MIN_SAMPLE = 30;

export interface KindStats {
  wrappers: number;
  /** Wrappers Googlebot fetched at least once */
  crawled: number;
  crawlRate: number | null;
  medianHoursToCrawl: number | null;
}

export interface WrapperStats {
  windowDays: number;
  byKind: Record<WrapperKind, KindStats>;
  byTemplate: Array<{ template: string; kind: WrapperKind; wrappers: number; crawled: number; crawlRate: number | null }>;
  jobs: {
    indexed: number;
    failed: number;
    /** Indexed jobs by how many retries they needed (key = retry count) */
    indexedByRetryCount: Record<string, number>;
    failedByRetryCount: Record<string, number>;
    hoursToIndex: { median: number | null; p90: number | null };
  };
  /**
   * The smallest MAX_RETRY_COUNT that would still have covered 95% of the jobs that got indexed.
   * Null until there are enough indexed jobs to say anything.
   */
  suggestedMaxRetryCount: number | null;
  note: string;
}

const round = (n: number, digits = 1): number => Math.round(n * 10 ** digits) / 10 ** digits;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

const rate = (part: number, whole: number): number | null => (whole === 0 ? null : round(part / whole, 3));

/**
 * Numbers for tuning retries and the wrapper mix, from what really happened:
 * how often Googlebot fetches each kind of wrapper, how long it takes, and after how many retries
 * jobs actually got indexed.
 */
export async function getWrapperStats(windowDays = 14): Promise<WrapperStats> {
  const since = new Date(Date.now() - windowDays * 24 * HOUR);

  const wrappers = await WrapperPage.find({ createdAt: { $gte: since } })
    .select('template createdAt crawledAt')
    .lean();

  const kinds: Record<WrapperKind, { total: number; hours: number[] }> = {
    job: { total: 0, hours: [] },
    livestream: { total: 0, hours: [] },
  };
  const templates = new Map<string, { kind: WrapperKind; wrappers: number; crawled: number }>();

  for (const w of wrappers) {
    const kind: WrapperKind = isWrapperTemplateId(w.template) ? kindOfTemplate(w.template) : 'job';
    kinds[kind].total++;
    const entry = templates.get(w.template) ?? { kind, wrappers: 0, crawled: 0 };
    entry.wrappers++;
    if (w.crawledAt) {
      entry.crawled++;
      kinds[kind].hours.push((w.crawledAt.getTime() - w.createdAt.getTime()) / HOUR);
    }
    templates.set(w.template, entry);
  }

  const kindStats = (kind: WrapperKind): KindStats => {
    const hours = [...kinds[kind].hours].sort((a, b) => a - b);
    const median = percentile(hours, 0.5);
    return {
      wrappers: kinds[kind].total,
      crawled: hours.length,
      crawlRate: rate(hours.length, kinds[kind].total),
      medianHoursToCrawl: median === null ? null : round(median),
    };
  };

  const finished = await UrlJob.find({
    createdAt: { $gte: since },
    status: { $in: [JobStatus.INDEXED, JobStatus.FAILED] },
  })
    .select('status retryCount createdAt indexedAt')
    .lean();

  const indexedByRetry: Record<string, number> = {};
  const failedByRetry: Record<string, number> = {};
  const hoursToIndex: number[] = [];
  for (const job of finished) {
    const key = String(job.retryCount ?? 0);
    if (job.status === JobStatus.INDEXED) {
      indexedByRetry[key] = (indexedByRetry[key] ?? 0) + 1;
      if (job.indexedAt) hoursToIndex.push((job.indexedAt.getTime() - job.createdAt.getTime()) / HOUR);
    } else {
      failedByRetry[key] = (failedByRetry[key] ?? 0) + 1;
    }
  }
  hoursToIndex.sort((a, b) => a - b);
  const indexedTotal = Object.values(indexedByRetry).reduce((a, b) => a + b, 0);
  const failedTotal = Object.values(failedByRetry).reduce((a, b) => a + b, 0);

  let suggested: number | null = null;
  if (indexedTotal >= MIN_SAMPLE) {
    let covered = 0;
    for (let retries = 0; retries <= 10; retries++) {
      covered += indexedByRetry[String(retries)] ?? 0;
      if (covered / indexedTotal >= 0.95) {
        suggested = retries;
        break;
      }
    }
  }

  const median = percentile(hoursToIndex, 0.5);
  const p90 = percentile(hoursToIndex, 0.9);
  return {
    windowDays,
    byKind: { job: kindStats('job'), livestream: kindStats('livestream') },
    byTemplate: [...templates.entries()]
      .map(([template, t]) => ({ template, kind: t.kind, wrappers: t.wrappers, crawled: t.crawled, crawlRate: rate(t.crawled, t.wrappers) }))
      .sort((a, b) => (b.crawlRate ?? -1) - (a.crawlRate ?? -1) || b.wrappers - a.wrappers),
    jobs: {
      indexed: indexedTotal,
      failed: failedTotal,
      indexedByRetryCount: indexedByRetry,
      failedByRetryCount: failedByRetry,
      hoursToIndex: { median: median === null ? null : round(median), p90: p90 === null ? null : round(p90) },
    },
    suggestedMaxRetryCount: suggested,
    note:
      indexedTotal < MIN_SAMPLE
        ? `Only ${indexedTotal} indexed job(s) in the last ${windowDays} days (need ${MIN_SAMPLE}): too few to suggest a retry count. Livestream templates: ${LIVE_TEMPLATE_IDS.length}.`
        : 'suggestedMaxRetryCount covers 95% of the jobs that got indexed in this window.',
  };
}
