import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarize, toRow } from '../tools/board.mjs';
import { buildGraph } from '../tools/roster-graph.mjs';
import { createDashboard } from '../tools/dashboard.mjs';
import { allowedHosts, hostName } from '../tools/hosts.mjs';
import { raw } from './http-helper.mjs';


const T0 = Date.parse('2026-01-01T12:00:00Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const row = (e) => toRow(e);

test('the board: latest status, quiet threads, whom a thread waits on, hand-off flow', () => {
  const rows = [
    row({ at: at(0), role: 'backend-dev', kind: 'status', status: 'working', task: 'API' }),
    row({ at: at(1), role: 'backend-dev', kind: 'handoff', status: 'waiting', to: 'backend-tester', task: 'API' }),
    row({ at: at(2), role: 'web-dev', kind: 'status', status: 'working', task: 'Page' }),
    row({ at: at(3), role: 'code-reviewer', instance: '57', kind: 'status', status: 'review' }),
    row({ at: at(4), role: 'qa-web', kind: 'bug', to: 'web-dev', severity: '2' }),
  ];
  const b = summarize(rows, { now: new Date(T0 + 40 * 60_000), role: 'backend-dev' });
  const by = Object.fromEntries(b.current.map((c) => [`${c.role}#${c.instance ?? ''}`, c]));
  assert.equal(by['backend-dev#'].status, 'waiting');
  assert.equal(by['backend-dev#'].waiting_on, 'backend-tester');
  assert.equal(by['backend-dev#'].stale, true);
  assert.equal(by['web-dev#'].stale, true);
  assert.equal(by['code-reviewer#57'].stale, true, 'review goes quiet after its limit too');
  assert.equal(by['qa-web#'], undefined, 'a message without a status sets no status');
  assert.deepEqual(b.flow.map((f) => `${f.role}>${f.to_role}`).sort(), ['backend-dev>backend-tester', 'qa-web>web-dev']);
  assert.equal(b.role.length, 2);
  assert.equal(b.recent[0].role, 'qa-web', 'newest first');
});

test('stale limits per status: a project can flag working sooner and waiting later', () => {
  const rows = [
    row({ at: at(0), role: 'backend-dev', kind: 'status', status: 'working', task: 'API' }),
    row({ at: at(0), role: 'web-dev', kind: 'status', status: 'waiting', task: 'CI' }),
    row({ at: at(0), role: 'cto', kind: 'status', status: 'done' }),
  ];
  const b = summarize(rows, { now: new Date(T0 + 20 * 60_000), staleMinutes: { working: 15, waiting: 120 } });
  const by = Object.fromEntries(b.current.map((c) => [c.role, c]));
  assert.equal(by['backend-dev'].stale, true, 'working, silent 20 min, limit 15');
  assert.equal(by['web-dev'].stale, false, 'waiting, silent 20 min, limit 120');
  assert.equal(by.cto.stale, false, 'done never goes quiet');
});

test('reports are validated like the hosted board', () => {
  assert.throws(() => toRow({ role: 'x', kind: 'status' }), /needs a status/);
  assert.throws(() => toRow({ role: 'x', kind: 'handoff' }), /needs a 'to' role/);
  assert.throws(() => toRow({ role: 'x', kind: 'shout', status: 'idle' }), /kind must be/);
  assert.equal(toRow({ role: 'Backend Dev', status: 'idle', pr: '#12' }).role, 'backend-dev');
  assert.equal(toRow({ role: 'a', status: 'idle', pr: '#12' }).pr, 12);
});

test('the roster graph: every kit role is placed under a manager and hands off to known roles', () => {
  const g = buildGraph('team');
  const slugs = new Set(g.roles.map((r) => r.slug));
  assert.equal(g.roles.length, 48);
  assert.deepEqual(g.ownerReports, ['chief-of-staff']);
  for (const r of g.roles) assert.ok(r.reportsTo === 'owner' || slugs.has(r.reportsTo), r.slug);
  for (const e of g.edges) assert.ok(slugs.has(e.to) || e.to === 'owner', `${e.from}>${e.to}`);
  assert.ok(g.edges.length > 100);
  assert.ok(g.unresolved.length < 12, JSON.stringify(g.unresolved));
  assert.ok(g.groups.length >= 5);
});

test('the page code lays out the kit roster without a browser', () => {
  // app.js is a classic browser script; run it the way a page would, with a CommonJS-style module to export into.
  const module = { exports: {} };
  runInNewContext(readFileSync('tools/dashboard/app.js', 'utf8'), { module, URLSearchParams, Date, Math, JSON });
  const api = module.exports;
  const T = api.team(buildGraph('team'));
  assert.equal(T.org.nodes.length, 49);
  assert.equal(T.flow.nodes.length, 49);
  const B = api.boardOf(T, [{ role: 'cto', status: 'working', age_s: 10, stale: false }]);
  assert.equal(B.lightOf(T.bySlug.get('cto')), 'working');
  assert.equal(api.rollup(T, B, T.bySlug.get('chief-of-staff')).light, 'working');

  // The page applies the roster's staleMinutes itself, whatever the board's own stale flag says.
  const T15 = api.team({ ...buildGraph('team'), staleMinutes: { working: 15, waiting: 120 } });
  const B15 = api.boardOf(T15, [
    { role: 'cto', status: 'working', age_s: 16 * 60, stale: false, task: 'Audit' },
    { role: 'web-dev', status: 'waiting', age_s: 40 * 60, stale: true, task: 'CI' },
  ]);
  assert.equal(B15.lightOf(T15.bySlug.get('cto')), 'quiet');
  assert.equal(B15.lightOf(T15.bySlug.get('web-dev')), 'waiting');
  assert.equal(B.lightOf(T.bySlug.get('cto')), 'working', 'default limit is 30 minutes');
  assert.equal(api.isQuiet({ status: 'working', age_s: 31 * 60 }), true);
  assert.equal(api.isQuiet({ status: 'done', age_s: 9999 * 60 }), false);

  // D46: a role with reports and no hook events is marked "Self-reported" on its card.
  assert.equal(api.isSelfReported({ status: 'working', self_reported: true }), true);
  assert.equal(api.isSelfReported({ status: 'working', self_reported: false }), false);
  assert.equal(api.isSelfReported(undefined), false);
  assert.match(api.card({ title: 'Web dev' }, 'working', 'Add a footer', false, 'web-dev', true), /Self-reported/);
  assert.doesNotMatch(api.card({ title: 'Web dev' }, 'working', 'Add a footer', false, 'web-dev', false), /Self-reported/);
});

test('the board marks a thread self-reported until a hook event arrives from it (D46)', () => {
  const at = (m) => new Date(Date.UTC(2026, 10, 6, 5, m)).toISOString();
  const rows = [
    { role: 'web-dev', kind: 'status', status: 'working', task: 'Add a footer', at: at(0), source: 'report.mjs' },
    { role: 'qa-web', kind: 'status', status: 'working', task: 'Check', at: at(0), source: 'team-status.sh' },
    { role: 'qa-web', kind: 'heartbeat', at: at(1), source: 'hook' },
  ];
  const { current } = summarize(rows, { now: new Date(at(2)) });
  const by = Object.fromEntries(current.map((c) => [c.role, c]));
  assert.equal(by['web-dev'].self_reported, true);
  assert.equal(by['qa-web'].self_reported, false);
});

test('the server takes reports, keeps one copy of each, and serves the board', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atd-'));
  const { server, log } = createDashboard({ root: process.cwd(), teamDir: 'team', home, token: 'secret', hosted: '' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (body, token = 'secret') => fetch(`${base}/api/report`, { method: 'POST', headers: { 'x-team-token': token }, body: JSON.stringify(body) });
    assert.equal((await post({ role: 'cto', status: 'working' }, 'wrong')).status, 403);
    assert.equal((await post({ role: 'cto', kind: 'handoff' })).status, 400);
    const ok = await post({ id: 'one', role: 'cto', status: 'working', task: 'Plan' });
    assert.equal(ok.status, 200);
    await post({ id: 'one', role: 'cto', status: 'working', task: 'Plan' });
    assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1);
    const board = await (await fetch(`${base}/api/board?role=cto`)).json();
    assert.equal(board.current[0].task, 'Plan');
    assert.equal(board.role.length, 1);
    const roster = await (await fetch(`${base}/api/roster`)).json();
    assert.equal(roster.roles.length, 48);
    assert.equal(roster.briefsPath, 'team/roles');
    const page = await fetch(`${base}/`);
    assert.match(await page.text(), /data-agent-team-dashboard/);
    assert.equal((await fetch(`${base}/..%2f..%2fpackage.json`)).status, 404);
  } finally {
    server.close();
  }
});

test('dimmed cards stay readable', () => {
  const css = readFileSync('tools/dashboard/app.css', 'utf8');
  const dims = [...css.matchAll(/\.tf-node\.dim \{ opacity: ([\d.]+) \}/g)].map((m) => Number(m[1]));
  assert.ok(dims.length >= 2);
  for (const o of dims) assert.ok(o >= 0.6, `dimmed opacity ${o} is too faint to read`);
});

test('host names: ports, brackets and case are ignored; a wildcard bind adds this machine, an allowlist adds more', () => {
  assert.equal(hostName('LocalHost:4747'), 'localhost');
  assert.equal(hostName('[::1]:4747'), '::1');
  assert.equal(hostName('127.0.0.1'), '127.0.0.1');
  assert.equal(hostName('evil.example.:80'), 'evil.example');
  assert.equal(hostName(''), '');
  const loop = allowedHosts('127.0.0.1');
  assert.deepEqual([...loop].sort(), ['127.0.0.1', '::1', 'localhost']);
  assert.ok(!allowedHosts('127.0.0.1', '').has('evil.example'));
  const lan = allowedHosts('192.168.1.20', 'board.example.com, Other.Example:8080');
  for (const h of ['192.168.1.20', 'localhost', 'board.example.com', 'other.example']) assert.ok(lan.has(h), h);
  assert.ok(allowedHosts('0.0.0.0').has('127.0.0.1'));
  assert.ok(!allowedHosts('0.0.0.0').has('0.0.0.0') && !allowedHosts('::').has('::'), 'the wildcard is not a name');
});

test('DNS rebinding: the dashboard answers only its own host names, on every route', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atd-'));
  const { server } = createDashboard({ root: process.cwd(), teamDir: 'team', home, token: '', hosted: '', hosts: 'board.example.com' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const report = JSON.stringify({ id: 'rb', role: 'cto', status: 'working' });
  try {
    for (const [path, method, body] of [['/', 'GET'], ['/app.js', 'GET'], ['/api/board', 'GET'], ['/api/roster', 'GET'], ['/api/stream', 'GET'], ['/api/report', 'POST', report]]) {
      for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1.evil.example', '']) {
        // No Host at all: Node's HTTP server answers 400 before the route runs.
        assert.equal((await raw(port, path, { host, method, body })).status, host ? 403 : 400, `${method} ${path} Host: ${host}`);
      }
      for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, 'localhost', `[::1]:${port}`, 'board.example.com']) {
        assert.equal((await raw(port, path, { host, method, body })).status, 200, `${method} ${path} Host: ${host}`);
      }
    }
  } finally {
    server.close();
  }
});
