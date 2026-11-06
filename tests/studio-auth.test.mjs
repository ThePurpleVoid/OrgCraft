// The hosted Studio's sign-in helpers (apps/studio/public/auth.js): where a sign-in may return to, and the links the
// sign-in page builds. docs/specs/m4-sign-in.md section 2: a return starts with exactly one '/'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED, REFUSED } from './fixtures/return-paths.mjs';
import { b64urlToBytes, bytesToB64url, githubStart, safeReturn, signInUrl } from '../apps/studio/public/auth.js';

test('a return path is a path on this host, or /', () => {
  for (const ok of ALLOWED) assert.equal(safeReturn(ok), ok, ok);
  for (const bad of REFUSED) assert.equal(safeReturn(bad), '/', JSON.stringify(bad));
});

test('the sign-in links: an interaction id of safe characters only, and the web client with a checked return', () => {
  assert.equal(githubStart('abc_DEF-123'), '/oauth/interaction/abc_DEF-123/github');
  for (const bad of ['', '../x', 'a/b', 'a?b', 'x'.repeat(129), null, '<script>']) assert.equal(githubStart(bad), null, String(bad));
  assert.equal(signInUrl('/#chat'), '/oauth/authorize?client_id=agent-team-web&return=%2F%23chat');
  assert.equal(signInUrl('//evil'), '/oauth/authorize?client_id=agent-team-web&return=%2F');
});

test('base64url round-trips every byte', () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(b64urlToBytes(bytesToB64url(all)), all);
  assert.doesNotMatch(bytesToB64url(all), /[+/=]/);
});
