// The control plane on an in-memory PGlite: report intake in the kit's shape, tenant isolation, the stream, the
// board, sinks that hand reports back to a team's own board, and the vault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, split } from '../db.mjs';
import { masterKey, seal, unseal } from '../vault.mjs';
import * as store from '../store.mjs';
import { drain } from '../sinks.mjs';
import { createControlPlane } from '../server.mjs';
import { toRow } from '../../../tools/board.mjs';

const KIT = new URL('../../../', import.meta.url).pathname;
const key = masterKey(randomBytes(32).toString('base64'));
const ADMIN = 'adm_test';

/** In-memory PGlite, or a real Postgres when TEST_DATABASE_URL is set (its public schema is wiped per test). */
async function fresh() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return openDb();
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('drop schema public cascade; create schema public');
  await c.end();
  return openDb({ url });
}

async function plane(fn) {
  const db = await fresh();
  await store.ensureTenant(db, 'acme');
  let woke = 0;
  const server = createControlPlane({ db, key, tenant: 'acme', adminToken: ADMIN, sinks: { wake: () => woke++ } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const call = async (method, path, body, headers = { authorization: `Bearer ${ADMIN}` }) => {
    const res = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try { await fn({ db, call, base, woke: () => woke }); } finally { server.closeAllConnections(); server.close(); await db.close(); }
}

test('splits migrations without breaking dollar-quoted bodies', () => {
  const s = split("-- c\ncreate table a(x int);\ndo $$ begin\n  execute format($p$x;$p$);\nend $$;\nselect 1;");
  assert.equal(s.length, 3);
  assert.match(s[1], /^do \$\$[\s\S]*end \$\$;$/);
});

test('takes the kit\'s reports byte for byte with a report token, and serves the board', async () => {
  await plane(async ({ call, woke }) => {
    assert.equal((await call('POST', '/teams', { id: 'shop', name: 'Shop' })).status, 201);
    assert.equal((await call('POST', '/teams', { id: 'shop' })).status, 409);
    assert.equal((await call('GET', '/teams', undefined, {})).status, 401);
    const tok = await call('POST', '/teams/shop/report-tokens');
    assert.equal(tok.status, 201);
    assert.match(tok.body.url, /\/v1\/teams\/shop\/reports$/);
    const report = (b, token = tok.body.token) => call('POST', '/teams/shop/reports', b, { 'x-team-token': token });

    assert.equal((await report({ role: 'backend-dev', kind: 'status', status: 'working' }, 'rt_x.nope')).status, 401);
    assert.equal((await report({ role: 'backend-dev', kind: 'status' })).status, 400, 'a status report needs a status');
    const sent = { role: 'backend-dev', kind: 'status', status: 'working', task: 'Invoices API', issue: 42, source: 'team-status.sh', id: 'r1', at: '2026-11-06T10:00:00.000Z' };
    const ok = await report(sent);
    assert.deepEqual(ok.body, { ok: true, id: 'r1' });
    assert.deepEqual((await report(sent)).body, { ok: true, id: 'r1' }, 'a retry is accepted and stored once');
    await report({ role: 'backend-dev', kind: 'handoff', status: 'waiting', to: 'backend-tester', pr: 57, id: 'r2', at: '2026-11-06T10:05:00.000Z' });
    assert.ok(woke() >= 2, 'appends wake the sink worker');

    const log = (await call('GET', '/teams/shop/events')).body;
    assert.equal(log.events.length, 2);
    assert.equal(log.events[0].event.type, 'report.status');
    assert.equal(log.events[1].event.type, 'message.handoff');
    assert.equal(log.events[0].event.source, '/tenants/acme/teams/shop');
    assert.equal((await call('GET', '/teams/shop/events?type=message.')).body.events.length, 1);

    const board = (await call('GET', '/teams/shop/board')).body;
    assert.equal(board.current.length, 1);
    assert.equal(board.current[0].status, 'waiting');
    assert.equal(board.current[0].waiting_on, 'backend-tester');
    assert.deepEqual(board.flow.map((f) => `${f.role}>${f.to_role}`), ['backend-dev>backend-tester']);

    // A token belongs to one team: it cannot write another team's board.
    await call('POST', '/teams', { id: 'other' });
    assert.equal((await call('POST', '/teams/other/reports', sent, { 'x-team-token': tok.body.token })).status, 401);
    // Revoked tokens stop working.
    assert.equal((await call('DELETE', `/teams/shop/report-tokens/${tok.body.id}`)).status, 200);
    assert.equal((await report({ ...sent, id: 'r3' })).status, 401);
  });
});

test('limits each role to 30 reports a minute', async () => {
  await plane(async ({ call }) => {
    await call('POST', '/teams', { id: 'busy' });
    const { token } = (await call('POST', '/teams/busy/report-tokens')).body;
    const codes = [];
    for (let i = 0; i < 31; i++) codes.push((await call('POST', '/teams/busy/reports', { role: 'web-dev', kind: 'heartbeat' }, { 'x-team-token': token })).status);
    assert.deepEqual([...new Set(codes.slice(0, 30))], [200]);
    assert.equal(codes[30], 429);
    assert.equal((await call('POST', '/teams/busy/reports', { role: 'qa-web', kind: 'heartbeat' }, { 'x-team-token': token })).status, 200, 'other roles are not held up');
  });
});

test('the kit\'s own team-status.sh reports to it unchanged', async () => {
  await plane(async ({ call }) => {
    await call('POST', '/teams', { id: 'kit' });
    const { token, url } = (await call('POST', '/teams/kit/report-tokens')).body;
    const home = mkdtempSync(join(tmpdir(), 'at-home-'));
    const root = mkdtempSync(join(tmpdir(), 'at-root-'));
    const env = { ...process.env, AGENT_TEAM_HOME: home, AGENT_TEAM_ROOT: root, TEAM_REPORT_URL: url, TEAM_REPORT_TOKEN: token };
    // Spawned, not run synchronously: the server answering it lives on this thread.
    const go = (...a) => new Promise((res, rej) => {
      const p = spawn('bash', [join(KIT, 'scripts/team-status.sh'), ...a], { env });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (code) => (code === 0 && !err ? res() : rej(new Error(err || `exit ${code}`))));
    });
    await go('qa-web', 'bug', '-', '--to', 'web-dev', '--severity', '2', '--evidence', 'a.png,b.txt', '--detail', 'Save does nothing');
    await go('code-reviewer#57', 'status', 'done');
    const events = (await call('GET', '/teams/kit/events')).body.events.map((e) => e.event);
    assert.deepEqual(events.map((e) => e.type), ['message.bug', 'report.status']);
    assert.deepEqual(events[0].data.evidence, ['a.png', 'b.txt']);
    assert.equal(events[0].actor.via, 'script');
    assert.equal(events[1].actor.instance, '57');
  });
});

test('tenants cannot see or write each other\'s teams, even by asking the database directly', async () => {
  await plane(async ({ db, call }) => {
    await call('POST', '/teams', { id: 'secret-team' });
    const { token } = (await call('POST', '/teams/secret-team/report-tokens')).body;
    await call('POST', '/teams/secret-team/reports', { role: 'cto', kind: 'note', detail: 'plans' }, { 'x-team-token': token });
    await store.ensureTenant(db, 'rival');
    assert.deepEqual(await db.tenant('rival', ({ q }) => q('select * from events')), []);
    assert.deepEqual(await db.tenant('rival', ({ q }) => q('select * from teams')), []);
    assert.deepEqual(await db.tenant('rival', ({ q }) => q('select * from report_tokens')), []);
    await assert.rejects(db.tenant('rival', ({ q }) => q("insert into events(tenant, team, id, type, version, time, actor_kind, actor_id, envelope) values ('acme', 'secret-team', 'x', 'report.note', 1, now(), 'role', 'cto', '{}')")), /row-level security/);
    await assert.rejects(store.getTeam(db, 'rival', 'secret-team'), /no such team/);
    await assert.rejects(store.createTeam(db, 'rival', { id: 'secret-team' }), /taken/);
    // Events that claim another tenant are refused before they reach the database.
    const e = { specversion: '1.0', id: 'e1', type: 'report.note', version: 1, source: '/tenants/rival/teams/secret-team', tenant: 'rival', time: new Date().toISOString(), actor: { kind: 'role', id: 'cto' }, data: {} };
    const r = await call('POST', '/teams/secret-team/events', { events: [e] });
    assert.equal(r.status, 400);
  });
});

test('streams events live and resumes from Last-Event-ID', async () => {
  await plane(async ({ call, base }) => {
    await call('POST', '/teams', { id: 'live' });
    const { token } = (await call('POST', '/teams/live/report-tokens')).body;
    const report = (id) => call('POST', '/teams/live/reports', { id, role: 'web-dev', kind: 'status', status: 'working', task: id }, { 'x-team-token': token });
    await report('a');

    const read = async (headers, want) => {
      const ctl = new AbortController();
      const res = await fetch(`${base}/teams/live/events/stream`, { headers: { authorization: `Bearer ${ADMIN}`, ...headers }, signal: ctl.signal });
      assert.equal(res.headers.get('content-type'), 'text/event-stream');
      const reader = res.body.getReader();
      const got = [];
      let buf = '';
      const dec = new TextDecoder();
      return {
        async until(n) {
          while (got.length < n) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i); buf = buf.slice(i + 2);
              const id = /^id: (\d+)$/m.exec(block)?.[1];
              const data = /^data: (.*)$/m.exec(block)?.[1];
              if (id && data) got.push({ seq: Number(id), event: JSON.parse(data) });
            }
          }
          return got;
        },
        close: () => ctl.abort(),
        want,
      };
    };
    const s = await read({});
    assert.deepEqual((await s.until(1)).map((g) => g.event.id), ['a'], 'catches up from the log first');
    await report('b');
    const got = await s.until(2);
    assert.deepEqual(got.map((g) => g.event.id), ['a', 'b'], 'then delivers live');
    s.close();

    await report('c');
    const again = await read({ 'last-event-id': String(got[1].seq) });
    assert.deepEqual((await again.until(1)).map((g) => g.event.id), ['c'], 'resumes after the last id it saw');
    again.close();
  });
});

test('a kit-report sink hands reports to a team\'s own board, with its token from the vault, and retries', async () => {
  const received = [];
  let fail = 1;
  const board = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (fail-- > 0) { res.writeHead(503); res.end('{"error":"down"}'); return; }
      received.push({ token: req.headers['x-team-token'], body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
    });
  });
  await new Promise((r) => board.listen(0, '127.0.0.1', r));
  const target = `http://127.0.0.1:${board.address().port}/functions/v1/team-report`;
  try {
    await plane(async ({ db, call }) => {
      await call('POST', '/teams', { id: 'mirror' });
      assert.equal((await call('PUT', '/secrets/OWN_BOARD_TOKEN', { value: 'their-token' })).status, 200);
      assert.deepEqual((await call('GET', '/secrets')).body.secrets.map((s) => s.name), ['OWN_BOARD_TOKEN'], 'names only, never values');
      assert.equal((await call('POST', '/teams/mirror/sinks', { url: 'http://example.com/x' })).status, 400, 'plain http only to this machine');
      const sink = (await call('POST', '/teams/mirror/sinks', { url: target, header: 'x-team-token', secret: 'OWN_BOARD_TOKEN' })).body;
      assert.equal(sink.format, 'kit-report');

      const { token } = (await call('POST', '/teams/mirror/report-tokens')).body;
      const sent = { id: 'm1', at: '2026-11-06T09:00:00.000Z', role: 'qa-web', kind: 'bug', to: 'web-dev', severity: 2, evidence: ['a.png'], detail: 'Save does nothing', source: 'hook', session: 's1' };
      await call('POST', '/teams/mirror/reports', sent, { 'x-team-token': token });

      assert.equal(await drain(db, key), 0, 'the first try fails');
      let [s] = await store.listSinks(db, 'acme', 'mirror');
      assert.equal(s.failures, 1);
      assert.match(s.last_error, /503/);
      await db.system("update sinks set next_at = now() where id = $1", [s.id]);
      assert.equal(await drain(db, key), 1);
      [s] = await store.listSinks(db, 'acme', 'mirror');
      assert.equal(s.failures, 0);
      assert.equal(received.length, 1);
      assert.equal(received[0].token, 'their-token');
      assert.deepEqual(received[0].body, toRow(sent), 'exactly the row the team\'s own board would have stored');
      assert.equal(await drain(db, key), 0, 'nothing is sent twice');
    });
  } finally { board.close(); }
});

test('the vault binds each secret to its tenant and name', () => {
  const sealed = seal(key, 'acme', 'A', 'value');
  assert.equal(unseal(key, 'acme', 'A', sealed), 'value');
  assert.throws(() => unseal(key, 'rival', 'A', sealed));
  assert.throws(() => unseal(key, 'acme', 'B', sealed));
  assert.throws(() => masterKey('short'));
});
