import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import compression from 'compression';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { env } from '../src/config/env';
import { preflightController } from '../src/controllers/preflightController';
import { preflightService } from '../src/services/preflightService';
import { startLocalSite, LocalSite } from './helpers/localSite';
import { readSseEvents, SseEvent } from './helpers/sse';

/**
 * The real controller behind the same middleware that matters for streaming (compression),
 * so this proves progress events reach the client as they happen, not all at the end.
 */

let site: LocalSite;
let api: Server;
let apiOrigin: string;
const baseline = { ...env.preflight };

before(async () => {
  site = await startLocalSite();
  Object.assign(env.preflight, { allowPrivateNetworks: true, timeoutMs: 3000 });

  const app = express();
  app.use(compression());
  app.use(express.json());
  app.post('/preflight', (req, res) => preflightController.scan(req, res));
  api = await new Promise<Server>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  apiOrigin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

after(async () => {
  Object.assign(env.preflight, baseline);
  preflightService.destroy();
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await site.close();
});

/** POST and read the SSE stream, stamping each event with its arrival time. */
async function stream(
  body: unknown,
  until?: (events: SseEvent[]) => boolean
): Promise<{ status: number; type: string | null; events: SseEvent[]; json?: any }> {
  const t0 = Date.now();
  const res = await fetch(`${apiOrigin}/preflight`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' },
    body: JSON.stringify(body),
  });
  const type = res.headers.get('content-type');
  if (!type?.startsWith('text/event-stream')) return { status: res.status, type, events: [], json: await res.json() };
  return { status: res.status, type, events: await readSseEvents(res, t0, until) };
}

test('progress is streamed: start first, each result as it finishes, done last', async () => {
  const urls = [`${site.origin}/ok`, `${site.origin}/slower`, `${site.origin}/404`];
  const { status, type, events } = await stream({ urls });

  assert.equal(status, 200);
  assert.match(type!, /^text\/event-stream/);
  assert.deepEqual(events.map((e) => e.type), ['start', 'result', 'result', 'result', 'done']);

  const start = events[0];
  assert.equal(start.total, 3);
  assert.deepEqual(start.urls, urls);

  const results = events.filter((e) => e.type === 'result');
  assert.deepEqual(results.map((e) => e.done), [1, 2, 3]);
  // the quick URLs are reported long before the slow one (600 ms) finishes
  const slow = results.find((e) => e.result.url.endsWith('/slower'))!;
  const quick = results.filter((e) => !e.result.url.endsWith('/slower'));
  assert.ok(quick.every((e) => e.at < 400), `quick results arrived at ${quick.map((e) => e.at)} ms`);
  assert.ok(slow.at >= 550, `slow result arrived at ${slow.at} ms`);
  assert.equal(slow.index, 1);

  const done = events.at(-1)!;
  assert.deepEqual({ ok: done.ok, warn: done.warn, blocked: done.blocked, total: done.total }, { ok: 2, warn: 0, blocked: 1, total: 3 });
  assert.ok(done.elapsedMs >= 550);
});

test('duplicate spellings of one URL are scanned once and counted', async () => {
  const { events } = await stream({ urls: [`${site.origin}/ok`, ` ${site.origin}/ok/ `, `${site.origin}/ok#top`, `${site.origin}/ok?x=1`] });
  assert.equal(events[0].total, 2);
  assert.equal(events[0].duplicates, 2);
  assert.equal(events.filter((e) => e.type === 'result').length, 2);
});

test('bad requests get a normal JSON 400, not a stream', async () => {
  for (const body of [{}, { urls: [] }, { urls: 'https://x.com' }, { urls: [1, 2] }, { urls: ['  ', ''] }, { urls: [`https://x.com/${'a'.repeat(2100)}`] }]) {
    const r = await stream(body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal(r.json.success, false);
    assert.ok(r.json.message);
  }
});

test('more URLs than the limit is a 400', async () => {
  env.preflight.maxUrlsPerScan = 5;
  const r = await stream({ urls: Array.from({ length: 6 }, (_, i) => `${site.origin}/ok?n=${i}`) });
  env.preflight.maxUrlsPerScan = baseline.maxUrlsPerScan;
  assert.equal(r.status, 400);
  assert.match(r.json.message, /At most 5/);
});

test('a client that disconnects stops the scan', async () => {
  env.preflight.perHostConcurrency = 1;
  const before = site.hits.get('/delay') ?? 0;
  const urls = Array.from({ length: 40 }, (_, i) => `${site.origin}/delay?n=${i}`);
  await stream({ urls }, (events) => events.some((e) => e.type === 'result'));
  await new Promise((r) => setTimeout(r, 500));
  env.preflight.perHostConcurrency = baseline.perHostConcurrency;
  const requested = (site.hits.get('/delay') ?? 0) - before;
  assert.ok(requested < 15, `only ${requested} of 40 URLs were requested after the client left`);
});

test('a mix of everything streams a verdict per URL', async () => {
  const paths = ['/ok', '/noindex-header', '/redirect', '/g-private/secret', '/jobposting'];
  const { events } = await stream({ urls: paths.map((p) => `${site.origin}${p}`) });
  const byPath = new Map(events.filter((e) => e.type === 'result').map((e) => [new URL(e.result.url).pathname, e.result]));
  assert.equal(byPath.get('/ok').verdict, 'ok');
  assert.equal(byPath.get('/noindex-header').verdict, 'blocked');
  assert.equal(byPath.get('/redirect').verdict, 'warn');
  assert.equal(byPath.get('/g-private/secret').verdict, 'blocked');
  assert.deepEqual(byPath.get('/jobposting').structuredData, ['JobPosting']);
});
