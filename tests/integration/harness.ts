import { testDatabase } from './env'; // must stay first: configures process.env
import axios, { AxiosError, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { JWT, OAuth2Client } from 'google-auth-library';
import cron from 'node-cron';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { env } from '../../src/config/env';
import { connectDatabase, disconnectDatabase } from '../../src/config/database';
import { allQueues, indexingQueue } from '../../src/config/queue';
import { startIndexingWorker } from '../../src/jobs/indexingWorker';
import { INDEXING_SCOPE } from '../../src/services/googleOAuthService';
import { sitemapService } from '../../src/services/sitemapService';
import { generateApiKey } from '../../src/utils/helpers';
import { logger } from '../../src/utils/logger';
import { User } from '../../src/models/User';
import { UrlJob } from '../../src/models/UrlJob';
import { GoogleToken } from '../../src/models/GoogleToken';
import { ServiceAccount, IServiceAccount } from '../../src/models/ServiceAccount';
import { WrapperPage } from '../../src/models/WrapperPage';
import { DomainActivity } from '../../src/models/DomainActivity';
import { ApiUsage } from '../../src/models/ApiUsage';
import { UserSite } from '../../src/models/UserSite';

export { testDatabase };
export const WEBMASTERS_READONLY = 'https://www.googleapis.com/auth/webmasters.readonly';

// ═══════════════════════════════════════════════════════════════════════
// Fake Google. Only the network edge is faked — every service, queue, cron,
// model and query under test is the real thing. Any request that is not one
// of the Google endpoints below is blocked and recorded, so a test run can
// never reach the real internet.
// ═══════════════════════════════════════════════════════════════════════

export interface FakeReply {
  status: number;
  body?: unknown;
  /** simulate a dropped connection / timeout (no HTTP response at all) */
  networkError?: boolean;
}
export interface PublishCall { url: string; type: string; token: string }
export interface InspectCall { inspectionUrl: string; siteUrl: string; token: string }
export interface SitemapCall { siteUrl: string; feed: string; token: string }
type Handler<C> = (call: C, n: number) => FakeReply | Promise<FakeReply>;

export const reply = {
  ok: (body: unknown = {}): FakeReply => ({ status: 200, body }),
  status: (status: number, message = 'error'): FakeReply => ({
    status,
    body: { error: { message } },
  }),
  network: (): FakeReply => ({ status: 0, networkError: true }),
};

const inspection = (verdict: string, coverageState: string): FakeReply =>
  reply.ok({ inspectionResult: { indexStatusResult: { verdict, coverageState } } });

export const inspect = {
  indexed: inspection('PASS', 'Submitted and indexed'),
  unknown: inspection('NEUTRAL', 'URL is unknown to Google'),
  crawledNotIndexed: inspection('NEUTRAL', 'Crawled - currently not indexed'),
};

export const google = {
  publishCalls: [] as PublishCall[],
  inspectCalls: [] as InspectCall[],
  sitemapCalls: [] as SitemapCall[],
  indexNowCalls: [] as unknown[],
  /** requests to anything that is not a known Google endpoint — must stay empty */
  blockedCalls: [] as string[],
  refreshCalls: 0,
  onPublish: (() => reply.ok({ urlNotificationMetadata: {} })) as Handler<PublishCall>,
  onInspect: (() => inspect.unknown) as Handler<InspectCall>,
  reset(): void {
    this.publishCalls = [];
    this.inspectCalls = [];
    this.sitemapCalls = [];
    this.indexNowCalls = [];
    this.blockedCalls = [];
    this.refreshCalls = 0;
    this.onPublish = () => reply.ok({ urlNotificationMetadata: {} });
    this.onInspect = () => inspect.unknown;
  },
};

const PUBLISH_URL = 'https://indexing.googleapis.com/v3/urlNotifications:publish';
const INSPECT_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
const SITEMAP_URL = /^https:\/\/www\.googleapis\.com\/webmasters\/v3\/sites\/([^/]+)\/sitemaps\/([^/]+)$/;
const INDEXNOW_URL = 'https://api.indexnow.org/indexnow';
const SITES_URL = 'https://www.googleapis.com/webmasters/v3/sites';

function toResponse(config: InternalAxiosRequestConfig, r: FakeReply): AxiosResponse {
  if (r.networkError) throw new AxiosError('connect ETIMEDOUT', 'ETIMEDOUT', config);
  const response: AxiosResponse = {
    data: r.body ?? {},
    status: r.status,
    statusText: String(r.status),
    headers: {},
    config,
    request: {},
  };
  if (r.status >= 200 && r.status < 300) return response;
  throw new AxiosError(
    `Request failed with status code ${r.status}`,
    r.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
    config,
    {},
    response
  );
}

async function fakeAdapter(config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
  const url = String(config.url);
  const method = String(config.method ?? 'get').toUpperCase();
  const auth = String(config.headers?.get?.('Authorization') ?? config.headers?.Authorization ?? '');
  const token = auth.replace(/^Bearer /, '');
  const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;

  if (method === 'POST' && url === PUBLISH_URL) {
    const call = { url: body.url, type: body.type, token };
    google.publishCalls.push(call);
    return toResponse(config, await google.onPublish(call, google.publishCalls.length));
  }
  if (method === 'POST' && url === INSPECT_URL) {
    const call = { inspectionUrl: body.inspectionUrl, siteUrl: body.siteUrl, token };
    google.inspectCalls.push(call);
    return toResponse(config, await google.onInspect(call, google.inspectCalls.length));
  }
  const sitemap = method === 'PUT' ? SITEMAP_URL.exec(url) : null;
  if (sitemap) {
    google.sitemapCalls.push({
      siteUrl: decodeURIComponent(sitemap[1]),
      feed: decodeURIComponent(sitemap[2]),
      token,
    });
    return toResponse(config, reply.ok());
  }
  if (method === 'POST' && url === INDEXNOW_URL) {
    google.indexNowCalls.push(body);
    return toResponse(config, reply.ok());
  }
  if (method === 'GET' && url === SITES_URL) {
    return toResponse(
      config,
      reply.ok({ siteEntry: [{ siteUrl: 'sc-domain:customer.com', permissionLevel: 'siteOwner' }] })
    );
  }

  google.blockedCalls.push(`${method} ${url}`);
  throw new AxiosError(`Blocked unexpected network call: ${method} ${url}`, 'ERR_NETWORK', config);
}

let faked = false;
function installFakeGoogle(): void {
  if (faked) return;
  faked = true;
  axios.defaults.adapter = fakeAdapter;
  // Service-account JWT signing + OAuth refresh talk to oauth2.googleapis.com; fake both.
  (JWT.prototype as unknown as { getAccessToken: unknown }).getAccessToken = async function (this: JWT) {
    return { token: `sa-token:${this.email}`, res: null };
  };
  (OAuth2Client.prototype as unknown as { refreshAccessToken: unknown }).refreshAccessToken = async () => {
    google.refreshCalls++;
    return {
      credentials: { access_token: 'refreshed-token', expiry_date: Date.now() + 3600 * 1000 },
      res: null,
    };
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Lifecycle
// ═══════════════════════════════════════════════════════════════════════

const baselineEnv = structuredClone(env);

/** Hard stop: never empty or drop a database we did not create/confirm. */
function assertWipeAllowed(): void {
  const name = mongoose.connection.name;
  if (name !== testDatabase.name) {
    throw new Error(`Refusing to wipe "${name}": the harness is configured for "${testDatabase.name}".`);
  }
  if (testDatabase.disposable && !name.startsWith('indexmenow_it_')) {
    throw new Error(`Refusing to wipe "${name}": not a disposable test database.`);
  }
}

export async function wipeCollections(): Promise<void> {
  assertWipeAllowed();
  for (const model of Object.values(mongoose.models)) await model.deleteMany({});
}

export async function startBackend(): Promise<void> {
  logger.silent = process.env.TEST_LOG !== '1';
  installFakeGoogle();
  await connectDatabase();
  assertWipeAllowed();
  // make sure unique/partial/TTL indexes exist before any test relies on them
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  await indexingQueue.isReady();
  await wipeCollections();
  startIndexingWorker();
}

export async function resetData(): Promise<void> {
  assertWipeAllowed();
  await indexingQueue.pause();
  await indexingQueue.obliterate({ force: true });
  await indexingQueue.resume();
  await wipeCollections();
  google.reset();
  for (const section of Object.keys(baselineEnv) as (keyof typeof baselineEnv)[]) {
    Object.assign(env[section], baselineEnv[section]);
  }
  (sitemapService as unknown as { lastSubmittedAt: number }).lastSubmittedAt = 0;
}

/**
 * Remove the throwaway database. dropDatabase needs a privilege that hosted users (e.g. an
 * Atlas "readWrite" user) often lack; dropping every collection removes an empty database just
 * the same, so fall back to that instead of leaving test data behind.
 */
async function dropDisposableDatabase(): Promise<void> {
  assertWipeAllowed();
  try {
    await mongoose.connection.dropDatabase();
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code !== 8000 && code !== 13) throw error; // AtlasError / Unauthorized
    const db = mongoose.connection.db!;
    for (const { name } of await db.listCollections().toArray()) await db.dropCollection(name);
  }
}

export async function stopBackend(): Promise<void> {
  for (const task of cron.getTasks().values()) task.stop();
  await indexingQueue.pause().catch(() => undefined);
  await indexingQueue.obliterate({ force: true }).catch(() => undefined);
  await Promise.all(allQueues.map((q) => q.close()));
  if (mongoose.connection.readyState === 1) {
    if (testDatabase.disposable) {
      await dropDisposableDatabase();
    } else {
      await wipeCollections();
    }
  }
  await disconnectDatabase();
}

export function stopCron(): void {
  for (const task of cron.getTasks().values()) task.stop();
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const rand = (): string => crypto.randomBytes(4).toString('hex');

export async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 20000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${label}`);
    await sleep(100);
  }
}

/** Wait until the queue has nothing waiting, delayed or running. */
export async function queueIdle(): Promise<void> {
  await waitFor(async () => {
    const c = await indexingQueue.getJobCounts();
    return c.waiting + c.active + c.delayed === 0 ? true : null;
  }, 'queue to drain');
}

export const jobStatus = async (id: mongoose.Types.ObjectId | string) =>
  (await UrlJob.findById(id))?.status;

export const waitForStatus = (id: mongoose.Types.ObjectId | string, status: string, timeoutMs?: number) =>
  waitFor(async () => {
    const job = await UrlJob.findById(id);
    return job?.status === status ? job : null;
  }, `job ${id} to reach ${status}`, timeoutMs);

export async function createUser(over: { credits?: number; email?: string } = {}) {
  return User.create({
    firstName: 'Test',
    lastName: 'User',
    email: over.email ?? `user-${rand()}@test.dev`,
    password: null,
    apiKey: generateApiKey(),
    credits: over.credits ?? 5,
  });
}

export async function createServiceAccount(over: Partial<IServiceAccount> = {}) {
  return ServiceAccount.create({
    email: `sa-${rand()}@proj-${rand()}.iam.gserviceaccount.com`,
    privateKey: 'not-a-real-key',
    projectId: `proj-${rand()}`,
    ...over,
  });
}

export async function connectGoogle(
  user: { _id: mongoose.Types.ObjectId },
  over: { scopes?: string[]; gscProperties?: string[]; expiresAt?: Date; accessToken?: string } = {}
) {
  return GoogleToken.create({
    userId: user._id,
    googleAccountId: `g-${rand()}`,
    googleEmail: `g-${rand()}@gmail.com`,
    accessToken: over.accessToken ?? 'user-token',
    refreshToken: 'refresh-token',
    expiresAt: over.expiresAt ?? new Date(Date.now() + 3600 * 1000),
    scopes: over.scopes ?? [INDEXING_SCOPE, WEBMASTERS_READONLY],
    gscProperties: over.gscProperties ?? ['sc-domain:customer.com'],
  });
}

export const past = (ms = 1000): Date => new Date(Date.now() - ms);

export const models = { User, UrlJob, GoogleToken, ServiceAccount, WrapperPage, DomainActivity, ApiUsage, UserSite };
