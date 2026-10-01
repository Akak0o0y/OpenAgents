import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentSecurityPolicy } from '../src/content-security-policy.mjs';

const policy = url => contentSecurityPolicy({ port: 4001, url });
test('only active daemon desktop viewer permits same-origin embedding', () => {
  for (const host of ['127.0.0.1', 'localhost']) {
    assert.match(policy(`http://${host}:4001/api/desktop/alpha/viewer.html`), /frame-ancestors 'self'/);
  }
  for (const url of [
    'http://127.0.0.1:4001/',
    'http://127.0.0.1:4001/api/desktop/alpha/viewer.js',
    'http://127.0.0.1:4001/api/desktop/alpha/other/viewer.html',
    'http://127.0.0.1:4002/api/desktop/alpha/viewer.html',
    'https://example.com/api/desktop/alpha/viewer.html',
    'http://127.0.0.1.evil.example:4001/api/desktop/alpha/viewer.html',
    'http://user@127.0.0.1:4001/api/desktop/alpha/viewer.html',
    'not a URL',
  ]) assert.match(policy(url), /frame-ancestors 'none'/, url);
});
test('production scripts remain strict and dev proxy viewer also embeds', () => {
  assert.match(policy('http://127.0.0.1:4001/api/desktop/a/viewer.html'), /script-src 'self'$/);
  assert.match(contentSecurityPolicy({ port: 4001, isDev: true, devUrl: 'http://localhost:5173', url: 'http://localhost:5173/api/desktop/a/viewer.html' }), /frame-ancestors 'self'/);
});
