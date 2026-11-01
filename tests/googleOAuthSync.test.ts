import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { GoogleToken } from '../src/models/GoogleToken';
import { UserSite } from '../src/models/UserSite';
import { googleOAuthService } from '../src/services/googleOAuthService';

afterEach(() => mock.restoreAll());

const userId = new mongoose.Types.ObjectId();
const future = () => new Date(Date.now() + 3600 * 1000);

function tokenDoc(name: string) {
  return {
    _id: new mongoose.Types.ObjectId(),
    userId,
    googleEmail: `${name}@gmail.test`,
    accessToken: `token-${name}`,
    expiresAt: future(),
    gscProperties: [`stored-${name}`],
  };
}

function arrange(tokens: ReturnType<typeof tokenDoc>[], fetch: (token: string) => string[] | null) {
  mock.method(GoogleToken, 'find', async () => tokens);
  mock.method(UserSite, 'findOneAndUpdate', async () => null);
  const updates: Array<{ id: unknown; set: Record<string, unknown> }> = [];
  mock.method(GoogleToken, 'findByIdAndUpdate', async (id: unknown, set: Record<string, unknown>) => {
    updates.push({ id, set });
    return null;
  });
  mock.method(googleOAuthService, 'fetchGSCProperties', async (token: string) => fetch(token));
  return updates;
}

test('sync gives every Google account its own properties, fetched with its own token', async () => {
  const a = tokenDoc('a');
  const b = tokenDoc('b');
  const updates = arrange([a, b], (token) =>
    token === 'token-a' ? ['sc-domain:a.com'] : ['sc-domain:b.com']
  );

  await googleOAuthService.syncProperties(userId);

  assert.deepEqual(
    updates.map((u) => [u.id, u.set.gscProperties]),
    [
      [a._id, ['sc-domain:a.com']],
      [b._id, ['sc-domain:b.com']],
    ],
    'the second account must not be overwritten with the first one’s (or the newest) properties'
  );
});

test('when Google cannot be asked, the stored properties are kept', async () => {
  const a = tokenDoc('a');
  const b = tokenDoc('b');
  const updates = arrange([a, b], (token) => (token === 'token-a' ? null : ['sc-domain:b.com']));

  await googleOAuthService.syncProperties(userId);

  assert.deepEqual(updates.map((u) => u.id), [b._id], 'a failed fetch must not write an empty list');
});

test('an account whose token cannot be refreshed is skipped, not fatal', async () => {
  const a = tokenDoc('a');
  const b = tokenDoc('b');
  const updates = arrange([a, b], () => ['sc-domain:x.com']);
  mock.method(googleOAuthService, 'accessTokenFor', async (doc: { _id: unknown }) =>
    doc._id === a._id ? null : 'fresh-b'
  );

  await googleOAuthService.syncProperties(userId);

  assert.deepEqual(updates.map((u) => u.id), [b._id]);
});
