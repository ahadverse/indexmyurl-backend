import test from 'node:test';
import assert from 'node:assert/strict';
import { matchProperty } from '../src/utils/gscProperty';

test('a domain property covers the bare domain, www and every subdomain, over http and https', () => {
  const props = ['sc-domain:example.com'];
  for (const url of [
    'https://example.com/',
    'http://example.com/a',
    'https://www.example.com/a/b?x=1',
    'https://blog.shop.example.com/post',
  ]) {
    assert.equal(matchProperty(props, url), 'sc-domain:example.com', url);
  }
});

test('a domain is never matched by substring', () => {
  assert.equal(matchProperty(['sc-domain:example.com'], 'https://notexample.com/'), null);
  assert.equal(matchProperty(['sc-domain:example.com'], 'https://example.com.evil.test/'), null);
  assert.equal(matchProperty(['https://notexample.com/'], 'https://example.com/'), null);
  assert.equal(matchProperty(['sc-domain:'], 'https://example.com/'), null);
});

test('a URL-prefix property is protocol- and host-exact', () => {
  assert.equal(matchProperty(['https://example.com/'], 'https://example.com/a'), 'https://example.com/');
  assert.equal(matchProperty(['https://example.com/'], 'http://example.com/a'), null);
  assert.equal(matchProperty(['https://example.com/'], 'https://www.example.com/a'), null);
  assert.equal(matchProperty(['https://www.example.com/'], 'https://www.example.com/a'), 'https://www.example.com/');
});

test('a URL-prefix property with a path only covers that path', () => {
  const props = ['https://example.com/blog/'];
  assert.equal(matchProperty(props, 'https://example.com/blog/post'), 'https://example.com/blog/');
  assert.equal(matchProperty(props, 'https://example.com/shop/item'), null);
  assert.equal(matchProperty(props, 'https://example.com/blogger'), null);
});

test('host case does not matter', () => {
  assert.equal(matchProperty(['sc-domain:Example.COM'], 'https://EXAMPLE.com/a'), 'sc-domain:Example.COM');
  assert.equal(matchProperty(['https://example.com/'], 'https://EXAMPLE.com/a'), 'https://example.com/');
});

test('a domain property wins over URL-prefix ones, and the longest prefix wins among those', () => {
  assert.equal(
    matchProperty(['https://example.com/', 'sc-domain:example.com'], 'https://example.com/a'),
    'sc-domain:example.com'
  );
  assert.equal(
    matchProperty(['https://example.com/', 'https://example.com/blog/'], 'https://example.com/blog/x'),
    'https://example.com/blog/'
  );
  assert.equal(
    matchProperty(['sc-domain:com', 'sc-domain:shop.example.com'], 'https://a.shop.example.com/'),
    'sc-domain:shop.example.com'
  );
});

test('garbage in gives no match instead of an error', () => {
  assert.equal(matchProperty([], 'https://example.com/'), null);
  assert.equal(matchProperty(['not a url', ''], 'https://example.com/'), null);
  assert.equal(matchProperty(['sc-domain:example.com'], 'not a url'), null);
});
