import {
  startBackend, stopBackend, resetData, google, inspect, models, sitesReply, reply,
  createUser, createServiceAccount, connectGoogle, queueIdle,
} from './harness';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';
import app from '../../src/app';
import { env } from '../../src/config/env';
import { signToken } from '../../src/utils/jwt';
import { jobOrchestrator } from '../../src/services/jobOrchestratorService';
import { searchConsoleAccessService } from '../../src/services/searchConsoleAccessService';

const { User, UrlJob } = models;

const URL1 = 'https://customer.com/blog/post-1';

let base = '';
let server: http.Server;

const submit = (user: { _id: any }, url = URL1) => jobOrchestrator.submitUrl(url, user._id);

async function get(path: string, user: { _id: any; email: string }) {
  const res = await fetch(base + path, {
    headers: { authorization: `Bearer ${signToken({ userId: String(user._id), email: user.email })}` },
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function post(path: string, user: { _id: any; email: string }, body: unknown) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${signToken({ userId: String(user._id), email: user.email })}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

/** Nothing was reserved, queued, inspected or published. */
async function assertNothingSpent(user: { _id: any }) {
  const u = await User.findById(user._id);
  assert.deepEqual([u!.credits, u!.reservedCredits], [5, 0], 'no credit reserved');
  assert.equal(await UrlJob.countDocuments(), 0, 'no job created');
  assert.equal(google.inspectCalls.length, 0, 'no inspection');
  assert.equal(google.publishCalls.length, 0, 'no Indexing API quota spent');
}

describe('Search Console access gate — real MongoDB + Redis, fake Google', () => {
  before(async () => {
    await startBackend();
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await stopBackend();
  });
  beforeEach(resetData);

  it('no Google account and no role for our service account: refused before anything is spent', async () => {
    const user = await createUser();
    const sa = await createServiceAccount();
    google.onSites = () => sitesReply(); // our service account has no role anywhere

    const res = await submit(user);

    assert.equal(res.success, false);
    assert.equal(res.code, 'NO_SEARCH_CONSOLE');
    assert.equal(res.accessIssue, 'NOT_CONNECTED');
    assert.equal(res.serviceAccountEmail, sa.email);
    assert.match(res.message, /Connect your Google account/);
    assert.ok(res.message.includes(sa.email), 'tells the user which address to add');
    await assertNothingSpent(user);
  });

  it("the user's connected Google account owns the site: accepted, and inspected with that token", async () => {
    const user = await createUser();
    await createServiceAccount();
    google.onSites = () => sitesReply();
    await connectGoogle(user, { gscProperties: ['sc-domain:customer.com'], accessToken: 'user-token' });

    const res = await submit(user);

    assert.equal(res.success, true, res.message);
    assert.deepEqual(
      [google.inspectCalls[0].siteUrl, google.inspectCalls[0].token],
      ['sc-domain:customer.com', 'user-token']
    );
    await queueIdle();
  });

  it('a connected Google account that does not have this site: NO_PROPERTY', async () => {
    const user = await createUser();
    await createServiceAccount();
    google.onSites = () => sitesReply();
    await connectGoogle(user, { gscProperties: ['sc-domain:someone-else.com'] });

    const res = await submit(user);

    assert.equal(res.code, 'NO_SEARCH_CONSOLE');
    assert.equal(res.accessIssue, 'NO_PROPERTY');
    assert.match(res.message, /not in the Search Console of your connected Google account/);
    await assertNothingSpent(user);
  });

  it('our service account added as a Full user: accepted, inspected as the service account on the exact property', async () => {
    const user = await createUser();
    const sa = await createServiceAccount();
    google.onSites = ({ token }) =>
      token === `sa-token:${sa.email}` ? sitesReply(['https://customer.com/', 'siteFullUser']) : sitesReply();

    const res = await submit(user);

    assert.equal(res.success, true, res.message);
    assert.deepEqual(
      [google.inspectCalls[0].siteUrl, google.inspectCalls[0].token],
      ['https://customer.com/', `sa-token:${sa.email}`]
    );
    await queueIdle();
  });

  it('a role added moments ago is picked up on the next submit, without waiting for the cache', async () => {
    const user = await createUser();
    await createServiceAccount();
    let added = false;
    google.onSites = () => (added ? sitesReply(['sc-domain:customer.com', 'siteFullUser']) : sitesReply());

    // within the 10 s cooldown a repeat attempt reuses the last read
    assert.equal((await submit(user)).code, 'NO_SEARCH_CONSOLE');
    added = true;
    assert.equal((await submit(user)).code, 'NO_SEARCH_CONSOLE');
    assert.equal(google.sitesCalls.length, 1);

    // once the cooldown has passed, a refusal re-reads Search Console and finds the role
    searchConsoleAccessService.refreshCooldownMs = 0; // restored by the finally below
    try {
      const res = await submit(user);
      assert.equal(res.success, true, res.message);
    } finally {
      searchConsoleAccessService.refreshCooldownMs = 10 * 1000;
    }
    await queueIdle();
  });

  it('a restricted role is not enough', async () => {
    const user = await createUser();
    const sa = await createServiceAccount();
    google.onSites = ({ token }) =>
      token === `sa-token:${sa.email}` ? sitesReply(['sc-domain:customer.com', 'siteRestrictedUser']) : sitesReply();

    assert.equal((await submit(user)).code, 'NO_SEARCH_CONSOLE');
    await assertNothingSpent(user);
  });

  it("the platform's own site cannot be claimed through the service account", async () => {
    const user = await createUser();
    await createServiceAccount();
    // BASE_URL is https://indexer.test: our service account is an owner of that site
    google.onSites = () => sitesReply(['sc-domain:indexer.test']);

    const res = await submit(user, 'https://indexer.test/login');

    assert.equal(res.code, 'NO_SEARCH_CONSOLE');
    await assertNothingSpent(user);
  });

  it('Google being unreachable asks the user to retry instead of blaming them', async () => {
    const user = await createUser();
    await createServiceAccount();
    google.onSites = () => reply.network();

    const res = await submit(user);

    assert.equal(res.success, false);
    assert.equal(res.code, 'SEARCH_CONSOLE_CHECK_FAILED');
    assert.match(res.message, /try again/);
    await assertNothingSpent(user);
  });

  it('REQUIRE_SEARCH_CONSOLE=false switches the gate off', async () => {
    env.google.requireSearchConsole = false; // restored by resetData
    const user = await createUser();
    await createServiceAccount();
    google.onSites = () => sitesReply();

    const res = await submit(user);

    assert.equal(res.success, true, res.message);
    await queueIdle();
  });

  it('a URL that is already indexed is accepted with no credit, via the resolved access', async () => {
    const user = await createUser();
    await createServiceAccount();
    google.onSites = () => sitesReply();
    await connectGoogle(user, { gscProperties: ['sc-domain:customer.com'] });
    google.onInspect = () => inspect.indexed;

    const res = await submit(user);

    assert.equal(res.alreadyIndexed, true);
    const u = await User.findById(user._id);
    assert.deepEqual([u!.credits, u!.reservedCredits], [5, 0]);
    assert.equal(google.inspectCalls.length, 1, 'access was resolved once and reused for the pre-check');
  });

  describe('HTTP', () => {
    it('submit answers 400 with the code, the reason and our address', async () => {
      const user = await createUser();
      const sa = await createServiceAccount();
      google.onSites = () => sitesReply();

      const res = await post('/api/urls/submit', user, { url: URL1 });

      assert.equal(res.status, 400);
      assert.equal(res.json.code, 'NO_SEARCH_CONSOLE');
      assert.equal(res.json.accessIssue, 'NOT_CONNECTED');
      assert.equal(res.json.serviceAccountEmail, sa.email);
      await assertNothingSpent(user);
    });

    it('GET /api/gsc/access reports how the user is connected, and never leaks a token', async () => {
      const user = await createUser();
      const sa = await createServiceAccount();
      google.onSites = () => sitesReply();

      const none = await get(`/api/gsc/access?url=${encodeURIComponent(URL1)}`, user);
      assert.equal(none.status, 200);
      assert.deepEqual(
        [none.json.hasAccess, none.json.reason, none.json.serviceAccountEmail],
        [false, 'NOT_CONNECTED', sa.email]
      );

      await connectGoogle(user, { gscProperties: ['sc-domain:customer.com'], accessToken: 'secret-user-token' });
      const some = await get(`/api/gsc/access?url=${encodeURIComponent(URL1)}`, user);
      assert.deepEqual(
        [some.json.hasAccess, some.json.source, some.json.siteUrl],
        [true, 'OAUTH', 'sc-domain:customer.com']
      );
      assert.ok(!JSON.stringify(some.json).includes('secret-user-token'));
    });

    it('GET /api/gsc/access needs a login and a valid URL', async () => {
      const user = await createUser();
      assert.equal((await fetch(`${base}/api/gsc/access?url=${encodeURIComponent(URL1)}`)).status, 401);
      assert.equal((await get('/api/gsc/access?url=nonsense', user)).status, 400);
      assert.equal((await get('/api/gsc/access', user)).status, 400);
    });

    it('the Google accounts list includes the address to add in Search Console', async () => {
      const user = await createUser();
      const sa = await createServiceAccount();
      const res = await get('/api/oauth/google/accounts', user);
      assert.equal(res.json.serviceAccountEmail, sa.email);
    });
  });
});
