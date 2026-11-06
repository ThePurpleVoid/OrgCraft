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

test('security notices read as sentences, and only unseen ones show (S5)', async () => {
  const { noticeText, unseenNotices, dismissNotices, noticesBanner } = await import('../apps/studio/public/auth.js');
  const at = '2026-11-06T05:42:00.000Z';
  assert.match(noticeText({ action: 'passkey.added', at, name: "Dana's MacBook" }), /^A passkey "Dana's MacBook" was added on /);
  assert.match(noticeText({ action: 'member.role-changed', at, tenant: 'acme', role: 'approver' }), /^Your role in acme changed to approver on /);
  assert.match(noticeText({ action: 'member.removed', at, tenant: 'acme' }), /^You were removed from acme on /);
  assert.match(noticeText({ action: 'step-up.locked', at }), /locked/);
  const mem = new Map(); const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const me = { notices: [{ action: 'passkey.removed', at: '2026-11-06T06:00:00.000Z', name: '<b>x</b>' }, { action: 'passkey.added', at }] };
  assert.equal(unseenNotices(me, storage).length, 2);
  assert.doesNotMatch(noticesBanner(me, storage), /<b>x/, 'names are escaped');
  dismissNotices(me, storage);
  assert.equal(noticesBanner(me, storage), '');
  me.notices.unshift({ action: 'sessions.ended', at: '2026-11-07T00:00:00.000Z' });
  assert.equal(unseenNotices(me, storage).length, 1);
});
