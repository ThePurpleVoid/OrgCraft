// M3 (issue #28), first part: Idempotency-Key on every write, runner registration with one-time codes, and the
// person's view across teams (/me/summary, /me/stream). Each new table is checked for tenant isolation against the
// database directly, as in the M2 tests, on PGlite and (CI) on a real Postgres as a non-superuser owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../store.mjs';
import { ADMIN, envelope, plane, sse } from './helpers.mjs';

const auth = { authorization: `Bearer ${ADMIN}` };

test('a write repeated with the same Idempotency-Key acts once and gets the first answer back', async () => {
  await plane(async ({ call, db }) => {
    const k = { ...auth, 'idempotency-key': 'k-1' };
    const first = await call('POST', '/teams', { id: 'shop', name: 'Shop' }, k);
    assert.equal(first.status, 201);
    assert.equal(first.headers.get('idempotent-replayed'), null);
    const again = await call('POST', '/teams', { id: 'shop', name: 'Shop' }, k);
    assert.equal(again.status, 201, 'the retry is answered as the first request was, not with "already exists"');
    assert.equal(again.headers.get('idempotent-replayed'), 'true');
    assert.deepEqual(again.body, first.body);
    assert.equal((await call('GET', '/teams')).body.teams.length, 1, 'and nothing was done twice');

    assert.equal((await call('POST', '/teams', { id: 'other' }, k)).status, 422, 'a key cannot be reused for a different body');
    assert.equal((await call('POST', '/teams/shop/report-tokens', undefined, k)).status, 422, 'or a different path');

    // Errors a client caused are answers too: they replay, and nothing runs in between.
    const dup = { ...auth, 'idempotency-key': 'k-2' };
    assert.equal((await call('POST', '/teams', { id: 'shop' }, dup)).status, 409);
    assert.equal((await call('POST', '/teams', { id: 'shop' }, dup)).headers.get('idempotent-replayed'), 'true');

    // Two different keys are two requests: a minted token is minted twice.
    const t1 = await call('POST', '/teams/shop/report-tokens', undefined, { ...auth, 'idempotency-key': 'tok-a' });
    const t1again = await call('POST', '/teams/shop/report-tokens', undefined, { ...auth, 'idempotency-key': 'tok-a' });
    const t2 = await call('POST', '/teams/shop/report-tokens', undefined, { ...auth, 'idempotency-key': 'tok-b' });
    assert.equal(t1again.status, 409, 'a token is shown once: its replay says it was made, without the token');
    assert.equal(t1again.body.id, t1.body.id);
    assert.equal(t1again.body.token, undefined);
    assert.notEqual(t2.body.id, t1.body.id);
    const [{ n }] = await db.system('select count(*)::int as n from report_tokens');
    assert.equal(n, 2);
    const kept = (await db.system('select response::text as r from idempotency_keys')).map((x) => x.r).join('\n');
    assert.ok(!kept.includes(t1.body.token.split('.')[1]) && !kept.includes(t2.body.token.split('.')[1]), 'no token is kept in the idempotency table');

    // A key still being worked on is a 409, and an old key is forgotten after the window.
    await db.system("insert into idempotency_keys(tenant, principal, key, method, path, request_hash) values ('acme', 'admin', 'busy', 'POST', '/v1/teams', 'x')");
    assert.equal((await call('POST', '/teams', { id: 'x1' }, { ...auth, 'idempotency-key': 'busy' })).status, 409);
    await db.system("update idempotency_keys set created_at = now() - interval '61 seconds' where key = 'busy'");
    assert.equal((await call('POST', '/teams', { id: 'x1' }, { ...auth, 'idempotency-key': 'busy' })).status, 201, 'a claim never settled is abandoned after a minute');
    await db.system("update idempotency_keys set created_at = now() - interval '25 hours' where key = 'busy'");
    assert.equal((await call('POST', '/teams', { id: 'x1b' }, { ...auth, 'idempotency-key': 'busy' })).status, 201, 'and any key is forgotten after the window');

    assert.equal((await call('POST', '/teams', { id: 'x2' }, { ...auth, 'idempotency-key': 'x'.repeat(256) })).status, 400);
    // Reads ignore the header.
    assert.equal((await call('GET', '/teams', undefined, { ...auth, 'idempotency-key': 'k-1' })).status, 200);
  });
});

test('report intake is unchanged: the kit\'s scripts keep their own retry-safe ids and need no key', async () => {
  await plane(async ({ call }) => {
    await call('POST', '/teams', { id: 'kit' });
    const { token } = (await call('POST', '/teams/kit/report-tokens')).body;
    const r = { id: 'r1', role: 'web-dev', kind: 'status', status: 'working' };
    assert.deepEqual((await call('POST', '/teams/kit/reports', r, { 'x-team-token': token })).body, { ok: true, id: 'r1' });
    assert.deepEqual((await call('POST', '/teams/kit/reports', r, { 'x-team-token': token, 'idempotency-key': 'z' })).body, { ok: true, id: 'r1' });
    assert.equal((await call('GET', '/teams/kit/events')).body.events.length, 1);
  });
});

test('a runner registers once with a one-time code and gets a key only it holds', async () => {
  await plane(async ({ call, db, su }) => {
    assert.equal((await call('POST', '/runners/codes', {}, {})).status, 401, 'only a signed-in person mints codes');
    const noStepUp = await call('POST', '/runners/codes', { name: 'laptop' });
    assert.equal(noStepUp.body.type, 'step-up-required', 'adding hands needs step-up (issue #28 D4)');
    const minted = await call('POST', '/runners/codes', { name: 'laptop' }, await su());
    assert.equal(minted.status, 201);
    assert.match(minted.body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.ok(Date.parse(minted.body.expires) > Date.now());

    const reg = { code: minted.body.code.toLowerCase().replaceAll('-', ' '), name: 'Dana\'s laptop', version: '0.9.0', capabilities: { sandboxes: ['process'], runtimes: ['agent-sdk'], maxSessions: 4 } };
    const k = { 'idempotency-key': 'reg-1' };
    const got = await call('POST', '/runners', reg, k);
    assert.equal(got.status, 201, 'the code is forgiving about case and separators');
    assert.match(got.body.key, /^rnr_[\w-]+\.[\w-]+$/);
    assert.deepEqual(await store.authRunner(db, got.body.key), { tenant: 'acme', id: got.body.id });
    assert.equal(await store.authRunner(db, `${got.body.id}.wrong`), null);

    const retry = await call('POST', '/runners', reg, k);
    assert.equal(retry.status, 409, 'a retry learns the runner was registered, but the key is shown only once');
    assert.equal(retry.body.id, got.body.id);
    assert.equal(retry.body.key, undefined);
    const codeAgain = await call('POST', '/runners/codes', { name: 'x' }, { ...(await su()), 'idempotency-key': 'code-1' });
    assert.equal((await call('POST', '/runners/codes', { name: 'x' }, { ...auth, 'idempotency-key': 'code-1' })).body.code, undefined);
    const kept = (await db.system('select response::text as r from idempotency_keys')).map((x) => x.r).join('\n');
    assert.ok(!kept.includes(got.body.key.split('.')[1]), 'the runner key is not kept in the idempotency table');
    assert.ok(!kept.includes(codeAgain.body.code), 'nor the code');
    assert.equal((await call('POST', '/runners', reg)).status, 401, 'but the code itself works once');
    assert.equal((await call('POST', '/runners', { ...reg, code: 'AAAA-AAAA-AAAA' })).status, 401);
    assert.equal((await call('POST', '/runners', { code: minted.body.code })).status, 400, 'a runner needs a name');

    const listed = (await call('GET', '/runners')).body.runners;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, 'Dana\'s laptop');
    assert.deepEqual(listed[0].capabilities.runtimes, ['agent-sdk']);
    assert.ok(!JSON.stringify(listed).includes(got.body.key.split('.')[1]), 'the key is never listed');
    assert.ok(!('hash' in listed[0]));

    const late = (await call('POST', '/runners/codes', undefined, await su())).body.code;
    await db.system("update runner_codes set expires_at = now() - interval '1 second' where runner is null");
    assert.equal((await call('POST', '/runners', { code: late, name: 'late' })).status, 401, 'codes expire');
    const fresh = (await call('POST', '/runners/codes', undefined, await su())).body.code;
    assert.equal((await call('POST', '/runners', { code: fresh, name: '' })).status, 400, 'a runner needs a name');
    assert.equal((await call('POST', '/runners', { code: fresh, name: 'ok', capabilities: [] })).status, 400);

    assert.equal((await call('DELETE', `/runners/${got.body.id}`)).status, 200);
    assert.equal(await store.authRunner(db, got.body.key), null, 'a revoked runner\'s key stops working');
    assert.equal((await call('DELETE', `/runners/${got.body.id}`)).status, 404);
  });
});

test('/me/summary shows each team at a glance, with asOf and an ETag', async () => {
  const at = new Date();
  await plane(async ({ call, base }) => {
    await call('POST', '/teams', { id: 'alpha', name: 'Alpha' });
    await call('POST', '/teams', { id: 'beta' });
    const { token } = (await call('POST', '/teams/alpha/report-tokens')).body;
    const report = (b) => call('POST', '/teams/alpha/reports', b, { 'x-team-token': token });
    await report({ role: 'web-dev', kind: 'status', status: 'working', task: 'Login' });
    await report({ role: 'qa-web', kind: 'status', status: 'waiting' });
    await report({ role: 'cto', kind: 'status', status: 'blocked' });
    await report({ role: 'designer', kind: 'status', status: 'done' });
    const today = (id, cost, extra) => envelope('acme', 'alpha', id, 'usage.recorded', { inputTokens: 10, outputTokens: 5, cost, currency: 'USD' }, extra);
    await call('POST', '/teams/alpha/events', { events: [today('u1', 120), today('u2', 30), today('u0', 999, { time: new Date(at.getTime() - 2 * 86_400_000).toISOString() }), today('u3', 'lots')] });

    const res = await fetch(`${base}/me/summary`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.asOf, 'u3', 'asOf names the newest event the summary includes');
    const [alpha, beta] = body.teams;
    assert.equal(alpha.team, 'alpha');
    assert.equal(alpha.name, 'Alpha');
    assert.deepEqual(alpha.roles, { working: 1, waiting: 1, blocked: 1, idle: 1 });
    assert.deepEqual(alpha.cost, { today: 150, capPerDay: null, currency: 'USD' }, 'today only, in minor units, and a cost that is not a number is ignored');
    assert.equal(alpha.inbox, 0);
    assert.equal(alpha.run, null);
    assert.deepEqual(beta.roles, { working: 0, waiting: 0, blocked: 0, idle: 0 });
    assert.deepEqual(beta.cost, { today: 0, capPerDay: null, currency: null });

    const etag = res.headers.get('etag');
    assert.equal((await fetch(`${base}/me/summary`, { headers: { ...auth, 'if-none-match': etag } })).status, 304);
    await report({ role: 'web-dev', kind: 'status', status: 'review' });
    assert.equal((await fetch(`${base}/me/summary`, { headers: { ...auth, 'if-none-match': etag } })).status, 200, 'a new event changes the ETag');
    assert.equal((await call('GET', '/me/summary', undefined, {})).status, 401);
  }, { now: () => at });
});

test('/me/stream carries every team of mine live, never another tenant\'s, and resumes by event id', async () => {
  await plane(async ({ call, base, db }) => {
    await call('POST', '/teams', { id: 'one' });
    await call('POST', '/teams', { id: 'two' });
    await store.ensureTenant(db, 'rival');
    await store.createTeam(db, 'rival', { id: 'theirs' });
    const theirs = await store.mintReportToken(db, 'rival', 'theirs');
    const tok = { one: (await call('POST', '/teams/one/report-tokens')).body.token, two: (await call('POST', '/teams/two/report-tokens')).body.token, theirs: theirs.token };
    const report = (team, id) => call('POST', `/teams/${team}/reports`, { id, role: 'web-dev', kind: 'note', detail: id }, { 'x-team-token': tok[team] });
    await report('one', 'a');
    await report('theirs', 'secret-1');

    const s = await sse(`${base}/me/stream`, auth);
    assert.equal(s.res.headers.get('content-type'), 'text/event-stream');
    assert.deepEqual((await s.until(1)).map((g) => g.id), ['a'], 'catches up from my log first');
    await report('theirs', 'secret-2');
    await report('two', 'b');
    const got = await s.until(2);
    assert.deepEqual(got.map((g) => `${g.event.team}/${g.id}`), ['one/a', 'two/b'], 'then live, across teams, and only mine');
    s.close();

    await report('one', 'c');
    const again = await sse(`${base}/me/stream`, { ...auth, 'last-event-id': 'b' });
    assert.deepEqual((await again.until(1)).map((g) => g.id), ['c'], 'resumes after the last id it saw');
    again.close();
    const typed = await sse(`${base}/me/stream?after=a&type=report.`, auth);
    assert.deepEqual((await typed.until(2)).map((g) => g.id), ['b', 'c']);
    typed.close();
    assert.equal((await fetch(`${base}/me/stream`, { headers: { ...auth, 'last-event-id': 'secret-1' } })).status, 400, 'another tenant\'s ids are unknown here');
  });
});

test('the new tables keep tenants apart, even when asked directly', async () => {
  await plane(async ({ call, db, su }) => {
    await call('POST', '/teams', { id: 'mine' }, { ...auth, 'idempotency-key': 'k' });
    const { code } = (await call('POST', '/runners/codes', undefined, await su())).body;
    await call('POST', '/runners/codes', undefined, await su());
    await call('POST', '/runners', { code, name: 'r' });
    await store.ensureTenant(db, 'rival');
    for (const table of ['idempotency_keys', 'runner_codes', 'runners']) {
      assert.deepEqual(await db.tenant('rival', ({ q }) => q(`select * from ${table}`)), [], `${table} is invisible to another tenant`);
      assert.ok((await db.tenant('acme', ({ q }) => q(`select * from ${table}`))).length > 0, `${table} is visible to its own tenant`);
    }
    assert.deepEqual(await db.tenant('rival', ({ q }) => q("update runners set revoked_at = now() returning id")), [], 'nor can it revoke another tenant\'s runner');
    await assert.rejects(db.tenant('rival', ({ q }) => q("insert into idempotency_keys(tenant, principal, key, method, path, request_hash) values ('acme', 'admin', 'x', 'POST', '/', 'h')")), /row-level security/);
    await assert.rejects(db.tenant('rival', ({ q }) => q("insert into runners(id, tenant, name, hash) values ('rnr_x', 'acme', 'x', 'h')")), /row-level security/);
    await assert.rejects(db.tenant('rival', ({ q }) => q("insert into runner_codes(hash, tenant, created_by, expires_at) values ('h', 'acme', 'x', now())")), /row-level security/);
  });
});

test('a stream sees events another instance appended, and the handler mounts on any HTTP server', async () => {
  const { createServer } = await import('node:http');
  const { createHandler } = await import('../server.mjs');
  const { fresh, key } = await import('./helpers.mjs');
  const db = await fresh();
  await store.ensureTenant(db, 'acme');
  const server = createServer(createHandler({ db, key, tenant: 'acme', adminToken: ADMIN, pollMs: 100 }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    await store.createTeam(db, 'acme', { id: 'far' });
    const team = await sse(`${base}/teams/far/events/stream`, auth);
    const mine = await sse(`${base}/me/stream`, auth);
    await new Promise((r) => setTimeout(r, 150));
    // Written straight to the database, as another instance would: this instance's hub never hears of it.
    await store.append(db, 'acme', 'far', [envelope('acme', 'far', 'elsewhere', 'report.note', { detail: 'hi' })]);
    assert.deepEqual((await team.until(1)).map((g) => g.id), ['elsewhere']);
    assert.deepEqual((await mine.until(1)).map((g) => g.id), ['elsewhere']);
    team.close(); mine.close();
  } finally { server.closeAllConnections(); server.close(); await db.close(); }
});

test('streams miss nothing when two instances append at once', async () => {
  const { createServer } = await import('node:http');
  const { createHandler } = await import('../server.mjs');
  const { fresh, key } = await import('./helpers.mjs');
  const db = await fresh();
  await store.ensureTenant(db, 'acme');
  const servers = [], bases = [];
  for (let i = 0; i < 2; i++) {
    const s = createServer(createHandler({ db, key, tenant: 'acme', adminToken: ADMIN, pollMs: 100 }));
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    servers.push(s);
    bases.push(`http://127.0.0.1:${s.address().port}/v1`);
  }
  try {
    await store.createTeam(db, 'acme', { id: 'busy' });
    const team = await sse(`${bases[0]}/teams/busy/events/stream`, auth);
    const mine = await sse(`${bases[0]}/me/stream`, auth);
    const ids = Array.from({ length: 60 }, (_, i) => `c${i}`);
    await Promise.all(ids.map((id, i) => fetch(`${bases[i % 2]}/teams/busy/events`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ events: [envelope('acme', 'busy', id, 'report.note', { detail: id })] }),
    })));
    for (const s of [team, mine]) {
      const got = await s.until(60);
      assert.deepEqual(got.map((g) => g.id).sort(), [...ids].sort(), 'every event arrives once');
      s.close();
    }
  } finally { for (const s of servers) { s.closeAllConnections(); s.close(); } await db.close(); }
});

test('an append that takes a lower seq but commits late is still streamed (seq is commit order)', async () => {
  await plane(async ({ call, base, db }) => {
    if (db.kind !== 'postgres') return; // PGlite has one connection, so transactions cannot overlap at all there
    await call('POST', '/teams', { id: 'slow' });
    const s = await sse(`${base}/teams/slow/events/stream`, auth);
    let open;
    const gate = new Promise((r) => (open = r));
    // A: takes its seq first, then holds its transaction open.
    await store.append(db, 'acme', 'slow', [envelope('acme', 'slow', 'first', 'report.note')]);
    const slowA = db.tenant('acme', async ({ q }) => {
      await q('select pg_advisory_xact_lock(4849, hashtext($1))', ['acme']);
      await q("insert into events(tenant, team, id, type, version, time, actor_kind, actor_id, envelope) values ('acme', 'slow', 'held', 'report.note', 1, now(), 'role', 'x', $1)",
        [JSON.stringify(envelope('acme', 'slow', 'held', 'report.note'))]);
      await gate;
    });
    await new Promise((r) => setTimeout(r, 100));
    // B: an ordinary append. It waits for A's lock, so it cannot commit a higher seq before A commits.
    const b = call('POST', '/teams/slow/events', { events: [envelope('acme', 'slow', 'second', 'report.note')] });
    await new Promise((r) => setTimeout(r, 200));
    open();
    await slowA;
    await b;
    assert.deepEqual((await s.until(3)).map((g) => g.id), ['first', 'held', 'second']);
    s.close();
  });
});

test('POST /teams/{team}/events takes only what an integration reports; every server- or runner-written type is refused (#135)', async () => {
  await plane(async ({ call }) => {
    await call('POST', '/teams', { id: 'shop' });
    const written = ['chat.message', 'approval.requested', 'approval.decided', 'decision.requested', 'decision.answered', 'card.updated',
      'ready.posted', 'ready.previewed', 'run.started', 'run.stopped', 'session.started', 'session.queued', 'session.tool',
      'proposal.opened', 'proposal.accepted', 'proposal.previewed', 'budget.warned', 'budget.exhausted', 'budget.updated',
      'meeting.opened', 'meeting.turn', 'meeting.replied', 'meeting.closed', 'meeting.minutes', 'team.transition',
      'connector.connected', 'notification.sent', 'report.', 'message.', 'custom.thing', ''];
    for (const type of written) {
      const r = await call('POST', '/teams/shop/events', { events: [envelope('acme', 'shop', `w-${type}`, type)] });
      assert.equal(r.status, 403, `${type}: ${JSON.stringify(r.body)}`);
    }
    // One bad type refuses the whole batch: nothing of it is stored.
    const mixed = await call('POST', '/teams/shop/events', { events: [envelope('acme', 'shop', 'ok-1', 'report.note', { detail: 'x' }), envelope('acme', 'shop', 'bad-1', 'chat.message', { from: 'owner', text: 'hi' })] });
    assert.equal(mixed.status, 403);
    assert.equal((await call('GET', '/teams/shop/events')).body.events.length, 0);
    for (const type of ['report.status', 'report.note', 'message.handoff', 'message.signoff', 'usage.recorded', 'team.published']) {
      const r = await call('POST', '/teams/shop/events', { events: [envelope('acme', 'shop', `ok-${type}`, type, {})] });
      assert.ok(r.status < 300, `${type}: ${JSON.stringify(r.body)}`);
    }
  });
});
