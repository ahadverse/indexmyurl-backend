import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import mongoose from 'mongoose';
import { env } from '../src/config/env';
import { UrlJob } from '../src/models/UrlJob';
import { googleIndexingService } from '../src/services/googleIndexingService';
import {
  credentialResolver,
  PublishResolution,
  ResolvedCredential,
} from '../src/services/credentialResolver';
import { serviceAccountPool } from '../src/services/serviceAccountPool';
import { googleOAuthService } from '../src/services/googleOAuthService';
import { apiUsageService } from '../src/services/apiUsageService';

const jobId = new mongoose.Types.ObjectId();

const saCredential = {
  accessToken: 'sa-token',
  source: 'SERVICE_ACCOUNT',
  serviceAccount: { _id: { toString: () => 'sa-1' } },
} as unknown as ResolvedCredential;

const oauthCredential = {
  accessToken: 'user-token',
  source: 'OAUTH',
  tokenDoc: { _id: new mongoose.Types.ObjectId() },
} as unknown as ResolvedCredential;

const googleError = (status: number, message = 'boom') =>
  Object.assign(new Error(message), {
    response: { status, data: { error: { message } } },
  });

/** Wires up fakes; returns call recorders. No network, no database. */
function arrange(opts: {
  resolutions: PublishResolution[];
  post: (token: string) => unknown | Promise<unknown>;
}) {
  mock.method(UrlJob, 'findById', async () => ({
    userId: new mongoose.Types.ObjectId(),
    domain: 'example.com',
  }));
  mock.method(UrlJob, 'findByIdAndUpdate', async () => null);

  let resolveCalls = 0;
  mock.method(credentialResolver, 'resolveForPublish', async () => {
    const next = opts.resolutions[resolveCalls++];
    return next ?? { credential: null, reason: 'NO_CREDENTIAL' };
  });

  const postedWith: string[] = [];
  mock.method(axios, 'post', async (_url: string, _body: unknown, config: any) => {
    const token = String(config.headers.Authorization).replace('Bearer ', '');
    postedWith.push(token);
    return { data: await opts.post(token) };
  });

  const sa = {
    reportSuccess: mock.method(serviceAccountPool, 'reportSuccess', async () => {}),
    reportError: mock.method(serviceAccountPool, 'reportError', async () => {}),
    markQuotaExhausted: mock.method(serviceAccountPool, 'markQuotaExhausted', async () => {}),
  };
  const oauthBudget = {
    markExhausted: mock.method(apiUsageService, 'markExhausted', async () => {}),
  };

  return { sa, oauthBudget, postedWith, resolveCalls: () => resolveCalls };
}

const publish = () => googleIndexingService.notifyUrl(jobId, 'https://platform.test/job/abc');

afterEach(() => mock.restoreAll());

test('success with the platform service account', async () => {
  const t = arrange({
    resolutions: [{ credential: saCredential }],
    post: () => ({ urlNotificationMetadata: {} }),
  });
  const result = await publish();
  assert.equal(result.outcome, 'SUCCESS');
  assert.deepEqual(t.postedWith, ['sa-token']);
  assert.equal(t.sa.reportSuccess.mock.callCount(), 1);
});

test('SA out of quota (429): marks it exhausted, NOT unhealthy, and falls back to the user token', async () => {
  const t = arrange({
    resolutions: [{ credential: saCredential }, { credential: oauthCredential }],
    post: (token) => {
      if (token === 'sa-token') throw googleError(429, 'Quota exceeded');
      return {};
    },
  });
  const result = await publish();
  assert.equal(result.outcome, 'SUCCESS');
  assert.deepEqual(t.postedWith, ['sa-token', 'user-token']);
  assert.equal(t.sa.markQuotaExhausted.mock.callCount(), 1);
  assert.equal(t.sa.reportError.mock.callCount(), 0, '429 must not count toward SA auto-deactivation');
});

test('SA rejected (403): counted once as an SA error, then falls back to the user token', async () => {
  const t = arrange({
    resolutions: [{ credential: saCredential }, { credential: oauthCredential }],
    post: (token) => {
      if (token === 'sa-token') throw googleError(403, 'Permission denied');
      return {};
    },
  });
  const result = await publish();
  assert.equal(result.outcome, 'SUCCESS');
  assert.equal(t.sa.reportError.mock.callCount(), 1);
});

test('429 on every credential reports QUOTA_EXHAUSTED and marks the OAuth budget spent', async () => {
  const t = arrange({
    resolutions: [{ credential: saCredential }, { credential: oauthCredential }],
    post: () => {
      throw googleError(429, 'Quota exceeded');
    },
  });
  const result = await publish();
  assert.equal(result.outcome, 'QUOTA_EXHAUSTED');
  assert.equal(t.oauthBudget.markExhausted.mock.callCount(), 1);
});

test('5xx is RETRYABLE and does not try another credential', async () => {
  const t = arrange({
    resolutions: [{ credential: saCredential }, { credential: oauthCredential }],
    post: () => {
      throw googleError(503, 'Backend error');
    },
  });
  const result = await publish();
  assert.equal(result.outcome, 'RETRYABLE');
  assert.deepEqual(t.postedWith, ['sa-token']);
  assert.equal(t.sa.reportError.mock.callCount(), 0);
});

test('network error (no HTTP response) is RETRYABLE', async () => {
  arrange({
    resolutions: [{ credential: saCredential }],
    post: () => {
      throw new Error('connect ETIMEDOUT');
    },
  });
  assert.equal((await publish()).outcome, 'RETRYABLE');
});

test('400 is PERMANENT', async () => {
  arrange({
    resolutions: [{ credential: saCredential }],
    post: () => {
      throw googleError(400, 'Invalid URL');
    },
  });
  assert.equal((await publish()).outcome, 'PERMANENT');
});

test('no credential at all is RETRYABLE; spent quota is QUOTA_EXHAUSTED', async () => {
  arrange({ resolutions: [{ credential: null, reason: 'NO_CREDENTIAL' }], post: () => ({}) });
  assert.equal((await publish()).outcome, 'RETRYABLE');
  mock.restoreAll();

  arrange({ resolutions: [{ credential: null, reason: 'QUOTA_EXHAUSTED' }], post: () => ({}) });
  assert.equal((await publish()).outcome, 'QUOTA_EXHAUSTED');
});

// ─── Credential order per PUBLISH_CREDENTIAL_MODE ─────────────────────

function arrangeResolver(opts: { saAvailable: boolean; userToken: boolean; oauthBudget: boolean }) {
  mock.method(serviceAccountPool, 'getAvailable', async () =>
    opts.saAvailable ? ({ _id: 'sa-1', email: 'sa@test' } as any) : null
  );
  mock.method(serviceAccountPool, 'getAccessToken', async () => 'sa-token');
  mock.method(serviceAccountPool, 'isQuotaExhausted', async () => false);
  const getValidToken = mock.method(googleOAuthService, 'getValidToken', async () =>
    opts.userToken ? ({ accessToken: 'user-token', tokenDoc: {} } as any) : null
  );
  mock.method(apiUsageService, 'tryConsume', async () => opts.oauthBudget);
  return { getValidToken };
}

const sourceOf = (r: PublishResolution) => (r.credential ? r.credential.source : r.reason);
const userId = new mongoose.Types.ObjectId();

test('mode platform_first: SA wins, user token is the fallback', async () => {
  env.google.publishCredentialMode = 'platform_first';
  arrangeResolver({ saAvailable: true, userToken: true, oauthBudget: true });
  assert.equal(sourceOf(await credentialResolver.resolveForPublish(userId, 'example.com')), 'SERVICE_ACCOUNT');

  mock.restoreAll();
  arrangeResolver({ saAvailable: false, userToken: true, oauthBudget: true });
  assert.equal(sourceOf(await credentialResolver.resolveForPublish(userId, 'example.com')), 'OAUTH');
});

test('mode platform: the user token is never used to publish', async () => {
  env.google.publishCredentialMode = 'platform';
  const t = arrangeResolver({ saAvailable: false, userToken: true, oauthBudget: true });
  assert.equal(sourceOf(await credentialResolver.resolveForPublish(userId, 'example.com')), 'NO_CREDENTIAL');
  assert.equal(t.getValidToken.mock.callCount(), 0);
  env.google.publishCredentialMode = 'platform_first';
});

test('mode user_first: user token wins, SA is the fallback', async () => {
  env.google.publishCredentialMode = 'user_first';
  arrangeResolver({ saAvailable: true, userToken: true, oauthBudget: true });
  assert.equal(sourceOf(await credentialResolver.resolveForPublish(userId, 'example.com')), 'OAUTH');
  env.google.publishCredentialMode = 'platform_first';
});

test('OAuth publish is only attempted with a token that has the Indexing scope', async () => {
  env.google.publishCredentialMode = 'platform_first';
  const t = arrangeResolver({ saAvailable: false, userToken: true, oauthBudget: true });
  await credentialResolver.resolveForPublish(userId, 'example.com');
  const scopes = t.getValidToken.mock.calls.map((c) => c.arguments[2]);
  assert.ok(scopes.length > 0 && scopes.every((s) => s === 'https://www.googleapis.com/auth/indexing'));
});

test('spent OAuth budget is reported as QUOTA_EXHAUSTED, not NO_CREDENTIAL', async () => {
  env.google.publishCredentialMode = 'platform_first';
  arrangeResolver({ saAvailable: false, userToken: true, oauthBudget: false });
  assert.equal(
    sourceOf(await credentialResolver.resolveForPublish(userId, 'example.com')),
    'QUOTA_EXHAUSTED'
  );
});
