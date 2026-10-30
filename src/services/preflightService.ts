import http from 'http';
import https from 'https';
import dns from 'dns';
import net from 'net';
import zlib from 'zlib';
import { Readable } from 'stream';
import { env } from '../config/env';
import { Semaphore } from '../utils/semaphore';
import { bareHost, isPublicIp } from '../utils/ipGuard';
import { extractHtmlSignals, robotsValueBlocksIndexing } from './htmlSignals';
import { isPathAllowed, parseRobotsTxt, ParsedRobots } from './robotsTxt';

/**
 * Pre-flight scan: fetch a URL the way a crawler would and report what would stop
 * Google from indexing it (404, noindex, robots.txt, redirects, canonical elsewhere, ...)
 * BEFORE it costs a credit or Indexing API quota.
 *
 * Speed: one GET per URL (plus redirect hops) that stops reading after the first 256 KB,
 * keep-alive connections, a cached DNS lookup and robots.txt per host, and parallel
 * workers (bounded per request, per host and process-wide).
 *
 * Safety: the URLs are user-supplied, so every connection goes through a DNS lookup that
 * refuses private/loopback/link-local addresses (blocks SSRF and DNS rebinding), redirects
 * are followed manually and re-checked on every hop, only ports 80/443 are allowed, and
 * response size and time are capped.
 */

export type Severity = 'blocker' | 'warning' | 'info';
export type Verdict = 'ok' | 'warn' | 'blocked';

export interface PreflightIssue {
  code: string;
  severity: Severity;
  message: string;
}

export interface PreflightResult {
  /** the URL as submitted */
  url: string;
  verdict: Verdict;
  /** HTTP status of the final response, null if none was received */
  status: number | null;
  finalUrl: string | null;
  redirects: number;
  title: string | null;
  canonicalUrl: string | null;
  wordCount: number | null;
  contentType: string | null;
  /** schema.org types found in JSON-LD (e.g. JobPosting) */
  structuredData: string[];
  ms: number;
  issues: PreflightIssue[];
}

const blocker = (code: string, message: string): PreflightIssue => ({ code, severity: 'blocker', message });
const warning = (code: string, message: string): PreflightIssue => ({ code, severity: 'warning', message });
const info = (code: string, message: string): PreflightIssue => ({ code, severity: 'info', message });

function verdictOf(issues: PreflightIssue[]): Verdict {
  if (issues.some((i) => i.severity === 'blocker')) return 'blocked';
  if (issues.some((i) => i.severity === 'warning')) return 'warn';
  return 'ok';
}

/** Canonical comparison key: lower-case host, default port and #fragment dropped, no trailing slash. */
export function urlKey(raw: string): string | null {
  try {
    const u = new URL(raw);
    const path = u.pathname.length > 1 && u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname;
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return null;
  }
}

/** Indices of `urls` ordered round-robin by host, so a long run of one host cannot starve the rest. */
export function interleaveByHost(urls: string[]): number[] {
  const buckets = new Map<string, number[]>();
  urls.forEach((u, i) => {
    const host = hostKey(u);
    const list = buckets.get(host);
    if (list) list.push(i);
    else buckets.set(host, [i]);
  });
  const lists = [...buckets.values()];
  const order: number[] = [];
  for (let round = 0; order.length < urls.length; round++) {
    for (const list of lists) if (round < list.length) order.push(list[round]);
  }
  return order;
}

function hostKey(raw: string): string {
  try {
    return new URL(raw).host || 'invalid';
  } catch {
    return 'invalid';
  }
}

// ─── Safe DNS ──────────────────────────────────────────────────────────

const DNS_TTL_MS = 60_000;
const dnsCache = new Map<string, { at: number; addresses: dns.LookupAddress[] }>();
const dnsInflight = new Map<string, Promise<dns.LookupAddress[]>>();

async function resolveHost(hostname: string): Promise<dns.LookupAddress[]> {
  const hit = dnsCache.get(hostname);
  if (hit && Date.now() - hit.at < DNS_TTL_MS) return hit.addresses;
  let pending = dnsInflight.get(hostname);
  if (!pending) {
    pending = dns.promises.lookup(hostname, { all: true, verbatim: true }).finally(() => dnsInflight.delete(hostname));
    dnsInflight.set(hostname, pending);
  }
  const addresses = await pending;
  if (dnsCache.size >= 2000) dnsCache.delete(dnsCache.keys().next().value as string);
  dnsCache.set(hostname, { at: Date.now(), addresses });
  return addresses;
}

/**
 * Used as the sockets' DNS lookup, so the address that is validated is the address that is
 * connected to (a hostname cannot pass a check and then resolve elsewhere).
 */
const safeLookup = ((
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void
): void => {
  resolveHost(hostname).then(
    (addresses) => {
      if (!env.preflight.allowPrivateNetworks && addresses.some((a) => !isPublicIp(a.address))) {
        callback(Object.assign(new Error(`${hostname} resolves to a non-public address`), { code: 'EUNSAFE' }));
        return;
      }
      const list =
        options.family === 4 || options.family === 6 ? addresses.filter((a) => a.family === options.family) : addresses;
      if (list.length === 0) {
        callback(Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }));
        return;
      }
      if (options.all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    },
    (err: NodeJS.ErrnoException) => callback(err)
  );
}) as unknown as net.LookupFunction;

function targetProblem(url: URL): { code: string; message: string } | null {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { code: 'INVALID_URL', message: 'Only http:// and https:// URLs can be scanned.' };
  }
  if (url.username || url.password) {
    return { code: 'INVALID_URL', message: 'URLs containing a username or password are not supported.' };
  }
  if (env.preflight.allowPrivateNetworks) return null;
  if (url.port !== '' && url.port !== '80' && url.port !== '443') {
    return { code: 'UNSAFE_TARGET', message: 'Only the standard web ports (80 and 443) are supported.' };
  }
  const host = bareHost(url.hostname);
  if (net.isIP(host) && !isPublicIp(host)) {
    return { code: 'UNSAFE_TARGET', message: 'This is a private or reserved address and cannot be scanned.' };
  }
  return null;
}

// ─── HTTP ──────────────────────────────────────────────────────────────

interface Hop {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** more data was available than maxBytes */
  truncated: boolean;
}

const EMPTY = Buffer.alloc(0);
const isRedirect = (status: number): boolean => [301, 302, 303, 307, 308].includes(status);
const TEXTUAL = /text\/|html|xml|json/;

type RobotsEntry = { kind: 'rules'; parsed: ParsedRobots } | { kind: 'allow-all' } | { kind: 'unreachable' };

const ROBOTS_TTL_MS = 5 * 60 * 1000;
const ROBOTS_UNREACHABLE_TTL_MS = 60 * 1000;
const RESULT_CACHE_MAX = 5000;

export class PreflightService {
  private readonly httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 256,
    maxFreeSockets: 32,
    lookup: safeLookup,
  } as http.AgentOptions);
  private readonly httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 256,
    maxFreeSockets: 32,
    lookup: safeLookup,
  } as https.AgentOptions);

  private readonly globalLimit = new Semaphore(env.preflight.globalConcurrency);
  private readonly hostLimits = new Map<string, Semaphore>();
  private readonly robotsCache = new Map<string, { at: number; ttl: number; entry: Promise<RobotsEntry> }>();
  private readonly resultCache = new Map<string, { at: number; result: PreflightResult }>();

  // ─── Public API ──────────────────────────────────────────────────────

  /**
   * Scan many URLs in parallel. `onResult` fires as each one finishes (in completion order,
   * with the URL's index in `urls`). Resolves with all results in input order. Aborting
   * `signal` stops scheduling new work and cancels the ones in flight.
   */
  async scan(
    urls: string[],
    opts: {
      signal?: AbortSignal;
      onResult?: (index: number, result: PreflightResult, done: number) => void;
    } = {}
  ): Promise<PreflightResult[]> {
    const results = new Array<PreflightResult>(urls.length);
    const order = interleaveByHost(urls);
    let cursor = 0;
    let done = 0;

    const worker = async (): Promise<void> => {
      while (!opts.signal?.aborted) {
        const slot = cursor++;
        if (slot >= order.length) return;
        const index = order[slot];
        const result = await this.runGuarded(urls[index], opts.signal);
        if (opts.signal?.aborted) return;
        results[index] = result;
        done++;
        opts.onResult?.(index, result, done);
      }
    };

    const workers = Math.max(1, Math.min(env.preflight.concurrency, urls.length));
    await Promise.all(Array.from({ length: workers }, worker));
    return results;
  }

  /**
   * Fetch a small resource (e.g. a sitemap) with the same protections as a scan: public
   * addresses only, redirects re-checked on every hop, size and time capped. Rejects with an
   * error carrying a `code` (UNSAFE_TARGET, ENOTFOUND, TOO_MANY_REDIRECTS, ...) when it cannot.
   */
  async fetchResource(
    raw: string,
    opts: { maxBytes: number; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<{ status: number; finalUrl: string; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean }> {
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), opts.timeoutMs ?? env.preflight.timeoutMs);
    const onAbort = (): void => budget.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let current = new URL(raw);
      for (let hops = 0; ; hops++) {
        const problem = targetProblem(current);
        if (problem) throw Object.assign(new Error(problem.message), { code: problem.code });
        const hop = await this.fetchHop(current, budget.signal, { maxBytes: opts.maxBytes, readBody: true, anyType: true });
        const location = hop.headers.location;
        if (isRedirect(hop.status) && location) {
          if (hops >= env.preflight.maxRedirects) {
            throw Object.assign(new Error('Too many redirects'), { code: 'TOO_MANY_REDIRECTS' });
          }
          current = new URL(location, current);
          continue;
        }
        return { status: hop.status, finalUrl: current.href, headers: hop.headers, body: hop.body, truncated: hop.truncated };
      }
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Close the keep-alive connections (graceful shutdown, tests). */
  destroy(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  /** A fresh-enough earlier result for this URL, or a new scan. Used to gate submissions. */
  async checkForSubmit(url: string): Promise<PreflightResult> {
    const cached = this.cached(url);
    return cached ?? this.runGuarded(url);
  }

  // ─── Scheduling ──────────────────────────────────────────────────────

  private hostLimit(host: string): Semaphore {
    let limit = this.hostLimits.get(host);
    if (!limit) {
      limit = new Semaphore(env.preflight.perHostConcurrency);
      this.hostLimits.set(host, limit);
    }
    return limit;
  }

  private async runGuarded(raw: string, signal?: AbortSignal): Promise<PreflightResult> {
    const host = hostKey(raw);
    const hostLimit = this.hostLimit(host);
    const releaseHost = await hostLimit.acquire(); // host first, so waiting here holds no global slot
    try {
      const releaseGlobal = await this.globalLimit.acquire();
      try {
        const result = await this.checkOne(raw, signal);
        if (!signal?.aborted) this.remember(raw, result);
        return result;
      } finally {
        releaseGlobal();
      }
    } finally {
      releaseHost();
      if (hostLimit.idle) this.hostLimits.delete(host);
    }
  }

  // ─── Result cache ────────────────────────────────────────────────────

  private cached(raw: string): PreflightResult | null {
    const key = urlKey(raw);
    const hit = key ? this.resultCache.get(key) : undefined;
    return hit && Date.now() - hit.at < env.preflight.cacheTtlMs ? hit.result : null;
  }

  private remember(raw: string, result: PreflightResult): void {
    const key = urlKey(raw);
    if (!key) return;
    if (this.resultCache.size >= RESULT_CACHE_MAX) this.resultCache.delete(this.resultCache.keys().next().value as string);
    this.resultCache.set(key, { at: Date.now(), result });
  }

  // ─── One URL ─────────────────────────────────────────────────────────

  async checkOne(raw: string, scanSignal?: AbortSignal): Promise<PreflightResult> {
    const started = Date.now();
    const issues: PreflightIssue[] = [];
    const out = {
      status: null as number | null,
      finalUrl: null as string | null,
      redirects: 0,
      title: null as string | null,
      canonicalUrl: null as string | null,
      wordCount: null as number | null,
      contentType: null as string | null,
      structuredData: [] as string[],
    };
    const finish = (): PreflightResult => ({
      url: raw,
      verdict: verdictOf(issues),
      ...out,
      ms: Date.now() - started,
      issues,
    });

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      issues.push(blocker('INVALID_URL', 'This is not a valid URL.'));
      return finish();
    }
    const problem = targetProblem(url);
    if (problem) {
      issues.push(blocker(problem.code, problem.message));
      return finish();
    }

    // one time budget for the whole URL, redirects included
    const budget = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      budget.abort();
    }, env.preflight.timeoutMs);
    const onScanAbort = (): void => budget.abort();
    scanSignal?.addEventListener('abort', onScanAbort, { once: true });

    try {
      const visited = new Set<string>();
      let current = url;
      let hop: Hop;
      let robotsUnreachable = false;

      for (;;) {
        visited.add(current.href);
        const robots = await this.robotsAllows(current);
        robotsUnreachable ||= robots.unreachable;
        if (!robots.allowed) {
          out.finalUrl = current.href;
          issues.push(
            blocker(
              'ROBOTS_BLOCKED',
              `robots.txt blocks Googlebot from ${current.pathname}${current.search}, so Google cannot crawl it.`
            )
          );
          return finish();
        }

        hop = await this.fetchHop(current, budget.signal, { maxBytes: env.preflight.maxBodyBytes, readBody: true });
        const location = hop.headers.location;
        if (!isRedirect(hop.status) || !location) break;

        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          issues.push(blocker('INVALID_URL', 'The redirect points to an invalid URL.'));
          return finish();
        }
        out.redirects++;
        const nextProblem = targetProblem(next);
        if (nextProblem) {
          issues.push(blocker('UNSAFE_TARGET', `The URL redirects somewhere that cannot be scanned. ${nextProblem.message}`));
          return finish();
        }
        if (out.redirects > env.preflight.maxRedirects || visited.has(next.href)) {
          issues.push(blocker('TOO_MANY_REDIRECTS', 'The URL redirects in a loop or through too many hops.'));
          return finish();
        }
        current = next;
      }

      out.status = hop.status;
      out.finalUrl = current.href;
      if (out.redirects > 0) {
        issues.push(
          warning(
            'REDIRECTED',
            `Redirects (${out.redirects}×) to ${current.href}. Google indexes the destination, so submit that URL instead.`
          )
        );
      }
      if (robotsUnreachable) {
        issues.push(info('ROBOTS_UNREACHABLE', 'robots.txt could not be fetched, so crawl rules were not checked.'));
      }
      this.analyse(hop, current, issues, out);
      if (Date.now() - started > 4000) {
        issues.push(info('SLOW_RESPONSE', 'The server was slow to answer; very slow pages can be crawled less often.'));
      }
      return finish();
    } catch (err) {
      issues.push(this.errorIssue(err as NodeJS.ErrnoException, timedOut));
      return finish();
    } finally {
      clearTimeout(timer);
      scanSignal?.removeEventListener('abort', onScanAbort);
    }
  }

  /** Issues for the final response of a URL. */
  private analyse(
    hop: Hop,
    current: URL,
    issues: PreflightIssue[],
    out: { title: string | null; canonicalUrl: string | null; wordCount: number | null; contentType: string | null; structuredData: string[] }
  ): void {
    const status = hop.status;
    if (status === 404 || status === 410) {
      issues.push(blocker('HTTP_NOT_FOUND', `The page returns HTTP ${status} (not found), so Google will not index it.`));
      return;
    }
    if (status === 401) {
      issues.push(blocker('HTTP_UNAUTHORIZED', 'The page requires a login (HTTP 401), so Google cannot crawl it.'));
      return;
    }
    if (status >= 500) {
      issues.push(warning('SERVER_ERROR', `The server answered HTTP ${status}. Google will not index a page that errors; fix it first.`));
      return;
    }
    if (status < 200 || status >= 300) {
      issues.push(
        warning(
          'SCANNER_REFUSED',
          `The server answered HTTP ${status} to our scanner, so the page could not be verified. Google may still be able to crawl it.`
        )
      );
      return;
    }

    const headerValues = ([] as string[]).concat(hop.headers['x-robots-tag'] ?? []);
    if (headerValues.some((v) => robotsValueBlocksIndexing(v))) {
      issues.push(blocker('NOINDEX_HEADER', 'The X-Robots-Tag response header says noindex, so Google will not index this page.'));
    }

    const type = String(hop.headers['content-type'] ?? '').toLowerCase();
    out.contentType = type.split(';')[0].trim() || null;
    const isHtml = type === '' || /html/.test(type);
    if (!isHtml) {
      // A sitemap is a list of pages, not a page: it is submitted in Search Console, and
      // sending it for indexing would only waste a credit.
      if (/<(urlset|sitemapindex)\b/i.test(hop.body.subarray(0, 4096).toString('utf8'))) {
        issues.push(
          blocker(
            'SITEMAP_NOT_A_PAGE',
            'This is a sitemap, not a page, so there is nothing to index here. Import its URLs to scan the pages it lists.'
          )
        );
        return;
      }
      issues.push(info('NON_HTML', `This is not an HTML page (${out.contentType}); only basic checks apply.`));
      return;
    }
    if (hop.body.length === 0) return;

    const signals = extractHtmlSignals(hop.body.toString('utf8'));
    out.title = signals.title;
    out.wordCount = signals.wordCount;
    out.structuredData = signals.jsonLdTypes;

    if (signals.metaNoindex) {
      issues.push(blocker('NOINDEX_META', 'A robots meta tag says noindex, so Google will not index this page.'));
    }
    if (signals.canonical) {
      try {
        const canonical = new URL(signals.canonical, current);
        out.canonicalUrl = canonical.href;
        if (urlKey(canonical.href) !== urlKey(current.href)) {
          issues.push(
            warning('CANONICAL_OTHER', `The page names ${canonical.href} as its canonical URL, so Google will usually index that URL instead.`)
          );
        }
      } catch {
        /* unusable canonical: ignore */
      }
    }
    if (!hop.truncated && signals.wordCount < 30) {
      issues.push(
        warning(
          'THIN_CONTENT',
          `Only ${signals.wordCount} words of text in the HTML. Pages with very little content are often left as "Crawled – currently not indexed" (a false alarm if the text is added by JavaScript).`
        )
      );
    }
    if (!signals.title) issues.push(info('NO_TITLE', 'The page has no <title>.'));

    const eligible = ['JobPosting', 'BroadcastEvent'].find((t) => signals.jsonLdTypes.includes(t));
    if (eligible) {
      issues.push(info('INDEXING_API_ELIGIBLE', `The page has genuine ${eligible} structured data, so it qualifies for Google's Indexing API.`));
    }
  }

  private errorIssue(err: NodeJS.ErrnoException, timedOut: boolean): PreflightIssue {
    const code = err.code ?? '';
    if (timedOut) {
      return warning('UNREACHABLE', `No complete answer within ${Math.round(env.preflight.timeoutMs / 1000)}s, so the page could not be verified.`);
    }
    if (code === 'ABORT_ERR' || err.name === 'AbortError') return warning('CANCELLED', 'The scan was cancelled.');
    if (code === 'EUNSAFE') {
      return blocker('UNSAFE_TARGET', 'The host resolves to a private or reserved address and cannot be scanned.');
    }
    if (code === 'ENOTFOUND') return blocker('DNS_NOT_FOUND', "The domain does not resolve (DNS lookup failed), so Google can't reach it.");
    if (/^(ERR_TLS|ERR_SSL|ERR_OSSL|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|HOSTNAME_MISMATCH)/.test(code)) {
      return warning('TLS_ERROR', `HTTPS problem: ${err.message}. Browsers and Google may refuse the page.`);
    }
    return warning('UNREACHABLE', `Could not fetch the page (${code || err.message}), so it could not be verified.`);
  }

  // ─── robots.txt ──────────────────────────────────────────────────────

  private async robotsAllows(url: URL): Promise<{ allowed: boolean; unreachable: boolean }> {
    const entry = await this.robotsFor(url.origin);
    if (entry.kind === 'rules') {
      return { allowed: isPathAllowed(entry.parsed, 'googlebot', url.pathname + url.search), unreachable: false };
    }
    return { allowed: true, unreachable: entry.kind === 'unreachable' };
  }

  private robotsFor(origin: string): Promise<RobotsEntry> {
    const now = Date.now();
    const hit = this.robotsCache.get(origin);
    if (hit && now - hit.at < hit.ttl) return hit.entry;

    const entry = this.loadRobots(origin);
    const record = { at: now, ttl: ROBOTS_TTL_MS, entry };
    if (this.robotsCache.size >= 1000) this.robotsCache.delete(this.robotsCache.keys().next().value as string);
    this.robotsCache.set(origin, record);
    void entry.then((e) => {
      if (e.kind === 'unreachable') record.ttl = ROBOTS_UNREACHABLE_TTL_MS;
    });
    return entry;
  }

  /** Like Google: 4xx = no rules, 5xx / unreachable = unknown, redirects followed (up to 5). */
  private async loadRobots(origin: string): Promise<RobotsEntry> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(5000, env.preflight.timeoutMs));
    try {
      let current = new URL('/robots.txt', origin);
      for (let hops = 0; hops <= 5; hops++) {
        if (targetProblem(current)) return { kind: 'unreachable' };
        const hop = await this.fetchHop(current, controller.signal, { maxBytes: 512 * 1024, readBody: true });
        if (isRedirect(hop.status)) {
          if (!hop.headers.location) return { kind: 'unreachable' };
          current = new URL(hop.headers.location, current);
          continue;
        }
        if (hop.status >= 200 && hop.status < 300) {
          return { kind: 'rules', parsed: parseRobotsTxt(hop.body.toString('utf8')) };
        }
        return hop.status >= 400 && hop.status < 500 ? { kind: 'allow-all' } : { kind: 'unreachable' };
      }
      return { kind: 'unreachable' };
    } catch {
      return { kind: 'unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── One HTTP request ────────────────────────────────────────────────

  private fetchHop(
    url: URL,
    signal: AbortSignal,
    opts: { maxBytes: number; readBody: boolean; anyType?: boolean }
  ): Promise<Hop> {
    return new Promise<Hop>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (!settled) {
          settled = true;
          fn();
        }
      };
      const isHttps = url.protocol === 'https:';

      const req = (isHttps ? https : http).request(
        url,
        {
          method: 'GET',
          agent: isHttps ? this.httpsAgent : this.httpAgent,
          signal,
          headers: {
            'User-Agent': `IndexMeNowBot/1.0 (+${env.server.baseUrl})`,
            Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'en',
          },
        },
        (res) => {
          res.on('error', () => undefined); // surfaced through req / the 'close' handler below
          const status = res.statusCode ?? 0;
          const type = String(res.headers['content-type'] ?? '').toLowerCase();
          const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase().trim();
          const decodable = encoding === '' || encoding === 'identity' || ['gzip', 'x-gzip', 'deflate', 'br'].includes(encoding);
          const wantBody =
            opts.readBody &&
            status >= 200 &&
            status < 300 &&
            decodable &&
            (opts.anyType || type === '' || TEXTUAL.test(type));

          if (!wantBody) {
            if (isRedirect(status)) res.resume();
            else res.destroy();
            settle(() => resolve({ status, headers: res.headers, body: EMPTY, truncated: false }));
            return;
          }

          let source: Readable = res;
          if (encoding === 'gzip' || encoding === 'x-gzip') source = res.pipe(zlib.createGunzip());
          else if (encoding === 'deflate') source = res.pipe(zlib.createInflate());
          else if (encoding === 'br') source = res.pipe(zlib.createBrotliDecompress());
          source.on('error', (err) => settle(() => reject(err)));

          const chunks: Buffer[] = [];
          let size = 0;
          source.on('data', (chunk: Buffer) => {
            if (settled) return;
            const room = opts.maxBytes - size;
            if (chunk.length > room) {
              chunks.push(chunk.subarray(0, room));
              size += room;
              settle(() => resolve({ status, headers: res.headers, body: Buffer.concat(chunks, size), truncated: true }));
              res.destroy(); // enough of the page; stop downloading the rest
              return;
            }
            chunks.push(chunk);
            size += chunk.length;
          });
          source.on('end', () =>
            settle(() => resolve({ status, headers: res.headers, body: Buffer.concat(chunks, size), truncated: false }))
          );
          // 'close' also fires once a complete response has been received, while a gzip/br
          // decoder may still be flushing its last chunk: only an incomplete one is an error.
          res.on('close', () => {
            if (res.complete) return;
            settle(() => reject(Object.assign(new Error('connection closed before the response finished'), { code: 'ECONNRESET' })));
          });
        }
      );
      req.on('error', (err) => settle(() => reject(err)));
      req.end();
    });
  }
}

export const preflightService = new PreflightService();
