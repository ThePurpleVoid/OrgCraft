// L40 unit checks: the Studio compares published systems with the control plane's on everything that decides access,
// and the Publish sheet gives each kind of systems widening its own line.
//   node --test tests/studio-systems.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mod from 'node:module';
import { sameSystems } from '../apps/studio/server.mjs';

// The page imports /team-model.mjs, which the Studio serves from the team model package.
const MODEL = new URL('../packages/team-model/index.mjs', import.meta.url).href;
mod.registerHooks?.({ resolve: (spec, ctx, next) => (spec.endsWith('/team-model.mjs') || spec === './team-model.mjs' ? { url: MODEL, shortCircuit: true } : next(spec, ctx)) });
const { widensLine } = mod.registerHooks ? await import('../apps/studio/public/publish-sheet.js') : {};

const drive = { id: 'drive', type: 'mcp', name: 'Shared drive', config: { folder: 'x' }, secrets: ['B', 'A'] };
const here = { resources: [drive], bindings: [{ role: 'cos', resource: 'drive', permission: 'read' }] };
// The control plane's shape: no config, defaults filled in.
const there = (r = {}) => ({ version: 3, resources: [{ id: 'drive', type: 'mcp', name: 'Shared drive', secrets: ['A', 'B'], permissions: { read: [], write: [], deploy: [] }, effects: {}, egress: [], tier: 'custom', ...r }], bindings: [{ role: 'cos', resource: 'drive', permission: 'read' }] });

test('sameSystems: the defaults the control plane fills in and the order do not count', () => {
  assert.equal(sameSystems(here, there()), true);
  assert.equal(sameSystems(null, { resources: [], bindings: [] }), true);
});

test('sameSystems: permissions, effects, egress and tier all count', () => {
  assert.equal(sameSystems(here, there({ egress: ['files.example'] })), false);
  assert.equal(sameSystems(here, there({ tier: 'verified' })), false);
  assert.equal(sameSystems(here, there({ effects: { upload: 'write' } })), false);
  assert.equal(sameSystems(here, there({ permissions: { read: ['list_*'], write: [], deploy: [] } })), false);
  assert.equal(sameSystems(here, there({ secrets: ['A'] })), false);
  assert.equal(sameSystems({ ...here, bindings: [{ role: 'cos', resource: 'drive', permission: 'write' }] }, there()), false);
});

test('widensLine: one line per kind of systems widening', { skip: !widensLine && 'needs module.registerHooks (Node 22.15 or later)' }, () => {
  const name = (s) => ({ cos: 'Chief of staff' })[s] ?? s;
  const sys = (s) => ({ drive: 'Shared drive' })[s] ?? s;
  const line = (x) => widensLine({ kind: 'resource-widened', subject: 'cos', resource: 'drive', detail: 'drive …', ...x }, name, sys);
  assert.match(line({ egress: ['files.example'] }), /Shared drive can now connect to files\.example, used by Chief of staff/);
  assert.match(line({ tier: { from: 'verified', to: 'custom' } }), /Shared drive is no longer verified/);
  assert.match(line({ tools: [{ tool: 'upload', at: 'read', from: 'write' }] }), /use more tools: upload/);
  assert.match(line({ effects: [{ tool: 'upload', from: 'write', to: 'read' }] }), /upload no longer ask you first/);
  assert.match(line({ command: true }), /runs different software/);
  // More than one kind, or settings: the general line.
  assert.equal(line({ egress: ['a'], tier: { from: 'verified', to: 'custom' } }), line({ secrets: ['X'] }));
  assert.equal(line({ egress: ['a'], detail: 'drive changes its settings, can reach a' }), line({ secrets: ['X'] }));
  assert.match(widensLine({ kind: 'system-added', resource: 'drive', type: 'mcp' }, name, sys), /Shared drive/);
});
