import test from 'node:test';
import assert from 'node:assert/strict';
import { signOAuthState, verifyOAuthState, signToken, verifyToken } from '../src/utils/jwt';
import { googleOAuthService } from '../src/services/googleOAuthService';

test('a login state and a connect state survive the round trip', () => {
  assert.deepEqual(verifyOAuthState(signOAuthState({ flow: 'login' })), { flow: 'login' });
  assert.deepEqual(verifyOAuthState(signOAuthState({ flow: 'connect', userId: 'u1' })), {
    flow: 'connect',
    userId: 'u1',
  });
});

test('the old unsigned formats are refused, so a state can no longer be forged', () => {
  for (const forged of ['login', 'connect:507f1f77bcf86cd799439011', '', 'not-a-token', 'a.b.c']) {
    assert.equal(verifyOAuthState(forged), null, forged);
  }
});

test('a tampered state is refused', () => {
  const [header, payload, signature] = signOAuthState({ flow: 'connect', userId: 'victim' }).split('.');
  const swapped = Buffer.from(JSON.stringify({ flow: 'connect', userId: 'attacker' })).toString('base64url');
  assert.equal(verifyOAuthState(`${header}.${swapped}.${signature}`), null);
  assert.equal(verifyOAuthState(`${header}.${payload}.${signature.slice(0, -2)}xx`), null);
});

test('an expired state is refused', () => {
  assert.equal(verifyOAuthState(signOAuthState({ flow: 'login' }, -1)), null);
});

test('a state token can never be used as a login token, nor the other way round', () => {
  const state = signOAuthState({ flow: 'connect', userId: 'u1' });
  assert.throws(() => verifyToken(state), 'state must not pass as a bearer token');
  assert.equal(verifyOAuthState(signToken({ userId: 'u1', email: 'a@b.test' })), null);
});

test('the consent URLs carry a state that identifies the right user', () => {
  const connect = new URL(googleOAuthService.generateConnectUrl('507f1f77bcf86cd799439011'));
  assert.deepEqual(verifyOAuthState(connect.searchParams.get('state')!), {
    flow: 'connect',
    userId: '507f1f77bcf86cd799439011',
  });
  const login = new URL(googleOAuthService.generateLoginUrl());
  assert.deepEqual(verifyOAuthState(login.searchParams.get('state')!), { flow: 'login' });
});

test('a callback with a forged state is refused before Google is contacted', async () => {
  const result = await googleOAuthService.handleCallback('any-code', 'connect:507f1f77bcf86cd799439011');
  assert.equal(result.success, false);
  assert.match(result.message, /invalid or has expired/);
});
