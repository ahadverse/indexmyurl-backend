import './env.platform'; // PUBLISH_CREDENTIAL_MODE=platform — must come first
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../../src/config/env';
import { GOOGLE_SCOPES, googleOAuthService, INDEXING_SCOPE } from '../../src/services/googleOAuthService';

describe('mode "platform": users are never asked for the Indexing scope', () => {
  it('configured mode is platform', () => {
    assert.equal(env.google.publishCredentialMode, 'platform');
  });

  it('scope list is read-only Search Console + identity only', () => {
    assert.ok(!GOOGLE_SCOPES.includes(INDEXING_SCOPE));
    assert.deepEqual(GOOGLE_SCOPES, [
      'https://www.googleapis.com/auth/webmasters.readonly',
      'openid',
      'email',
      'profile',
    ]);
  });

  it('the consent URLs sent to users carry exactly those scopes', () => {
    for (const url of [googleOAuthService.generateLoginUrl(), googleOAuthService.generateConnectUrl('abc123')]) {
      const scope = new URL(url).searchParams.get('scope')!;
      assert.ok(!scope.includes('auth/indexing'), url);
      assert.deepEqual(scope.split(' '), GOOGLE_SCOPES);
    }
  });
});
