// The event envelope and its exact mapping to and from the kit's board reports (docs/contracts/events.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toRow } from '../tools/board.mjs';
import { checkEvent, fromKitRow, toKitRow } from '../packages/events/index.mjs';

const reports = [
  { role: 'web-dev', kind: 'status', status: 'working', task: 'Login page', issue: 12, branch: 'web/12-login', commit: 'abc1234' },
  { role: 'web-dev', kind: 'handoff', status: 'waiting', to: 'qa-web', task: 'Login page', pr: 14, evidence: 'https://preview.example/login' },
  { role: 'qa-web', kind: 'signoff', to: 'release-manager', pr: 14, evidence: ['shots/login-phone.png', 'shots/login-desktop.png'], detail: 'All states pass' },
  { role: 'qa-web', kind: 'bug', to: 'web-dev', severity: 2, pr: 14, detail: 'Focus ring missing' },
  { role: 'code-reviewer', instance: 'pr-14', kind: 'status', status: 'review', pr: 14 },
  { role: 'backend-dev', kind: 'heartbeat', source: 'hook', session: 'ses-1' },
  { role: 'cto', kind: 'note', detail: 'Freeze until Friday', platform: 'web' },
  { role: 'android-dev', kind: 'blocked', status: 'blocked', to: 'chief-of-staff', task: 'Play listing', detail: 'Needs the owner' },
];

test('every kit report maps to an envelope and back with nothing lost', () => {
  for (const r of reports) {
    const row = toRow({ ...r, at: '2026-11-06T01:00:00.000Z', id: `id-${r.role}-${r.kind}` });
    const event = fromKitRow(row, { tenant: 'acme', team: 'my-app' });
    assert.deepEqual(checkEvent(event), [], JSON.stringify(event));
    assert.equal(event.type, ['handoff', 'bug', 'signoff', 'blocked'].includes(r.kind) ? `message.${r.kind}` : `report.${r.kind}`);
    assert.equal(event.actor.id, r.role);
    assert.deepEqual(toKitRow(event), row);
  }
});

test('hook reports are marked as arriving by hook; scripts by script', () => {
  const hook = fromKitRow(toRow({ role: 'web-dev', kind: 'heartbeat', source: 'hook' }), { tenant: 't', team: 'x' });
  const script = fromKitRow(toRow({ role: 'web-dev', kind: 'status', status: 'idle' }), { tenant: 't', team: 'x' });
  assert.equal(hook.actor.via, 'hook');
  assert.equal(script.actor.via, 'script');
});

test('envelopes that break the contract are refused with reasons', () => {
  assert.ok(checkEvent({}).length >= 5);
  const good = fromKitRow(toRow({ role: 'cto', kind: 'note', detail: 'x' }), { tenant: 't', team: 'x' });
  assert.match(checkEvent({ ...good, type: 'Bad Type' })[0], /type/);
  assert.match(checkEvent({ ...good, data: { detail: 'x'.repeat(70000) } })[0], /64 KiB/);
  assert.equal(toKitRow({ ...good, type: 'run.started' }), null);
});

test('the contract files parse', () => {
  for (const f of ['docs/contracts/schema/event.v1.json', 'docs/contracts/schema/connector.v1.json']) JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
  const api = readFileSync(new URL('../docs/contracts/api-v1.yaml', import.meta.url), 'utf8');
  assert.match(api, /^openapi: 3\.1\.0/m);
  assert.match(api, /\/teams\/\{team\}\/reports:/, 'the kit report endpoint is part of v1');
});
