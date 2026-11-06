import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkServer } from '../link.mjs';

test('the control plane URL: https anywhere, plain http only to this machine or Docker Desktop\'s host', () => {
  assert.equal(checkServer('https://cp.example.com/'), 'https://cp.example.com');
  assert.equal(checkServer('https://cp.example.com:8443/base/'), 'https://cp.example.com:8443/base');
  for (const ok of ['http://localhost:4849', 'http://127.0.0.1:4849', 'http://[::1]:4849', 'http://host.docker.internal:4849']) {
    assert.equal(checkServer(ok), ok, ok);
  }
  for (const [bad, why] of [
    ['http://cp.example.com', /refusing plain http to cp\.example\.com/],
    ['http://192.168.1.20:4849', /refusing plain http/],
    ['http://localhost.example.com', /refusing plain http/],
    ['http://127.0.0.2:4849', /refusing plain http/],
    ['ws://localhost:4849', /must be https/],
    ['ftp://cp.example.com', /must be https/],
    ['https://user:pw@cp.example.com', /user or password/],
    ['cp.example.com', /not a URL/],
  ]) assert.throws(() => checkServer(bad), why, bad);
});
