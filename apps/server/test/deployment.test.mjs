// L29: where OrgCraft runs (O19.1, O37.1), the runner card with health and the N-2 window (O19.2, R13), and outage
// mode (O37.8 Now): when the code host or the model provider can't be reached, nothing is lost and nothing goes out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, fakeRunner, plane, registerRunner } from './helpers.mjs';
import { SERVER_VERSION, UPGRADE_GRACE_DAYS, cleanHealth, createReachability, upgradeBy, versionWindow } from '../deployment.mjs';

test('the version window: current, up to two minors behind, then upgrade-required; a newer runner is ahead', () => {
  const s = (v, c = '0.22.3') => versionWindow(v, c).status;
  assert.deepEqual(['0.22.0', '0.21.9', '0.20.0', '0.19.5', '1.0.0', 'v0.22.1', 'test', null].map((v) => s(v)),
    ['current', 'supported', 'supported', 'upgrade-required', 'ahead', 'current', 'unknown', 'unknown']);
  assert.equal(versionWindow('0.19.0', '0.22.0').behind, 3);
  assert.equal(s('1.4.0', '2.0.0'), 'upgrade-required', 'an older major is outside the window');
  assert.equal(s(SERVER_VERSION, SERVER_VERSION), 'current');
});

test('the upgrade date is set once when a runner falls behind, kept, and cleared when it is back in the window', () => {
  const now = new Date('2026-11-09T00:00:00Z');
  const by = upgradeBy(versionWindow('0.1.0', '0.9.0'), null, now);
  assert.equal(by, new Date(now.getTime() + UPGRADE_GRACE_DAYS * 86_400_000).toISOString());
  assert.equal(upgradeBy(versionWindow('0.1.0', '0.9.0'), by, new Date('2026-12-01T00:00:00Z')), by, 'a later hello keeps the first date');
  assert.equal(upgradeBy(versionWindow('0.8.0', '0.9.0'), by, now), null);
});

test('a runner\'s health report keeps only the model state, a valid time and short text', () => {
  assert.deepEqual(cleanHealth({ model: { state: 'unreachable', since: '2026-11-09T01:02:03Z', provider: 'Anthropic', error: 'x'.repeat(500), extra: 1 }, disk: 'full' }),
    { model: { state: 'unreachable', since: '2026-11-09T01:02:03.000Z', provider: 'Anthropic', error: 'x'.repeat(200) } });
  assert.deepEqual(cleanHealth({ model: { state: 'on fire' } }), {});
  assert.deepEqual(cleanHealth('nope'), {});
  assert.equal(cleanHealth({ model: { state: 'ok', since: 'yesterday' } }).model.since, null);
});

test('reachability: two failures in a row make it unreachable, one answer makes it ok, a 4xx still means it is up', async () => {
  const r = createReachability();
  let answer = () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
  const f = r.wrap('code-host', async () => answer());
  assert.equal(r.state('code-host'), 'unknown');
  await assert.rejects(f('x'));
  assert.equal(r.state('code-host'), 'unknown', 'one blip is not an outage');
  answer = () => ({ status: 503 });
  await f('x');
  assert.equal(r.get('code-host').state, 'unreachable');
  assert.equal(r.get('code-host').lastError, 'HTTP 503');
  answer = () => ({ status: 404 });
  await f('x');
  assert.deepEqual([r.get('code-host').state, r.get('code-host').lastError], ['ok', null]);
});

test('GET /v1/deployment: the local tile, version and window, no runner yet, and any member may read it', async () => {
  // The mode is set, never read from the machine: CI runs these tests on Postgres (TEST_DATABASE_URL), where the
  // fallback for a server with no AGENT_TEAM_MODE is self-hosted.
  await plane(async ({ call }) => {
    const d = await call('GET', '/deployment');
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(d.body.mode, 'local');
    assert.equal(d.body.version, SERVER_VERSION);
    assert.deepEqual(d.body.window, { current: SERVER_VERSION, supported: 2 });
    assert.deepEqual(d.body.runners, { total: 0, connected: 0, upgradeRequired: 0 });
    assert.deepEqual(d.body.dependencies.map((x) => [x.id, x.state]), [['code-host', 'unknown'], ['model', 'unknown']]);
    assert.deepEqual(d.body.outage, { active: false, down: [], publish: 'ok', work: 'queued' }, 'with no runner, work waits in the queue');
    assert.equal((await call('GET', '/deployment', undefined, {})).status, 401);
  }, { mode: 'local' });
});

test('GET /v1/deployment: self-hosted when set, and an unknown mode falls back by database (PGlite local, Postgres self-hosted)', async () => {
  await plane(async ({ call }) => assert.equal((await call('GET', '/deployment')).body.mode, 'self-hosted'), { mode: 'self-hosted' });
  await plane(async ({ call, db }) => assert.equal((await call('GET', '/deployment')).body.mode, db.kind === 'pglite' ? 'local' : 'self-hosted'), { mode: 'self-hosted-typo' });
});

test('a runner whose model provider is unreachable gets no new work: the wake waits unspent, and starts once it is back', async () => {
  await plane(async ({ call, base, su, db }) => {
    await call('POST', '/teams', { id: 'shop' });
    assert.equal((await call('PUT', '/teams/shop/budget', { perDay: 1000, sessions: 3 }, await su())).status, 200);
    const r = await registerRunner(call);
    const down = { model: { state: 'unreachable', since: '2026-11-09T10:00:00Z', provider: 'Anthropic', error: 'ECONNREFUSED' } };
    const runner = await fakeRunner(base, r.key, { runner: r.id, health: down, version: SERVER_VERSION });
    const run = await call('POST', '/teams/shop/runs', { team: { version: 'v1', roles: [{ slug: 'chief-of-staff', reportsTo: 'owner', areas: [] }] } });
    assert.equal(run.status, 201, JSON.stringify(run.body));

    const d = (await call('GET', '/deployment')).body;
    assert.deepEqual(d.outage, { active: true, down: ['model'], publish: 'ok', work: 'queued' });
    assert.deepEqual([d.dependencies[1].state, d.dependencies[1].name, d.dependencies[1].since], ['unreachable', 'Anthropic', '2026-11-09T10:00:00.000Z']);
    const card = (await call('GET', '/runners')).body.runners[0];
    assert.deepEqual([card.state, card.window.status, card.model.state], ['connected', 'current', 'unreachable']);

    await call('POST', '/teams/shop/chat', { text: 'Ship the cart', clientId: 'c1' });
    await new Promise((x) => setTimeout(x, 400));
    assert.equal(runner.frames.filter((f) => f.op === 'session.start').length, 0, 'nothing goes out');
    const [dl] = await db.system('select state, attempts from deliveries');
    assert.deepEqual([dl.state, dl.attempts], ['pending', 0], 'nothing is lost, and waiting spends no attempt');

    // Back: the runner says so, and the next pass sends the wake.
    const ok = await runner.request('runner.health', { model: { state: 'ok', since: '2026-11-09T10:05:00Z', provider: 'Anthropic' } });
    assert.equal(ok.op, 'ack');
    assert.equal((await call('GET', '/deployment')).body.outage.active, false);
    await db.system("update deliveries set next_at = now()");
    await call('POST', '/teams/shop/chat', { text: 'still there?', clientId: 'c2' });
    const f = await runner.next((x) => x.op === 'session.start', 5000);
    assert.equal(f.body.role, 'chief-of-staff');
    const [row] = await db.tenant('acme', ({ q }) => q('select health from runners where id = $1', [r.id]));
    assert.equal(row.health.model.state, 'ok', 'kept on the row, for any instance to read');
  }, { tickMs: 0 });
});

test('a runner behind the window is still welcomed, told to upgrade by a date, and the card counts it', async () => {
  await plane(async ({ call, base, db }) => {
    const r = await registerRunner(call);
    const runner = await fakeRunner(base, r.key, { runner: r.id, version: '0.19.4' });
    const u = runner.welcome.body.upgrade;
    assert.deepEqual([u.required, u.behind, u.current, u.supported], [true, 3, '0.22.0', 2]);
    assert.ok(Date.parse(u.by) > Date.now() + (UPGRADE_GRACE_DAYS - 1) * 86_400_000);
    const card = (await call('GET', '/runners')).body.runners[0];
    assert.deepEqual([card.window.status, card.window.behind, card.window.upgradeBy], ['upgrade-required', 3, u.by]);
    assert.equal((await call('GET', '/deployment')).body.runners.upgradeRequired, 1);
    runner.close();
    // Reconnecting later keeps the first date; a runner back in the window has none.
    await new Promise((x) => setTimeout(x, 100));
    const again = await fakeRunner(base, r.key, { runner: r.id, version: '0.19.4' });
    assert.equal(again.welcome.body.upgrade.by, u.by);
    again.close();
    await new Promise((x) => setTimeout(x, 100));
    const fixed = await fakeRunner(base, r.key, { runner: r.id, version: '0.21.0' });
    assert.equal(fixed.welcome.body.upgrade, undefined);
    const [row] = await db.tenant('acme', ({ q }) => q('select health from runners where id = $1', [r.id]));
    assert.equal(row.health.upgradeBy, undefined);
    assert.equal((await call('GET', '/runners')).body.runners[0].window.status, 'supported');
  }, { serverVersion: '0.22.0' });
});

test('outage mode for the code host: Studio writes wait with the honest reason, and "Check again" probes at most every 30 s', async () => {
  let up = false;
  const seen = [];
  const fakeFetch = async (u) => { seen.push(String(u)); if (!up) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }); return new Response('{}', { status: 200 }); };
  const reachability = createReachability({ downAfter: 1 });
  await plane(async ({ call }) => {
    const first = await call('POST', '/deployment/check');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.checked, true);
    assert.deepEqual(first.body.outage, { active: true, down: ['code-host'], publish: 'waiting', work: 'queued' });
    assert.equal(first.body.dependencies[0].lastError, 'ECONNRESET');
    assert.match(seen[0], /\/rate_limit$/);
    const pub = await call('POST', '/teams/shop/studio/api/publish', { yaml: 'x' });
    assert.equal(pub.status, 503);
    assert.match(pub.body.error, /GitHub can't be reached\. Publishing waits until it's back\. Nothing already published is affected, and nothing is lost\./);
    up = true;
    const soon = await call('POST', '/deployment/check');
    assert.deepEqual([soon.body.checked, soon.body.outage.active, seen.length], [false, true, 1], 'too soon: no second probe');
    assert.ok(soon.body.retryIn > 0 && soon.body.retryIn <= 30);
    reachability.ok('code-host');
    assert.equal((await call('GET', '/deployment')).body.outage.publish, 'ok');
  }, { reachability, studio: { fetch: fakeFetch, api: 'https://gh.example' } });
});

test('the tick re-probes an unreachable code host on its own, so publishing comes back with no one pressing a button', async () => {
  const seen = [];
  const reachability = createReachability({ downAfter: 1 });
  reachability.fail('code-host', 'ECONNRESET');
  await plane(async ({ call }) => {
    assert.equal((await call('GET', '/deployment')).body.outage.publish, 'waiting');
    for (let i = 0; i < 100 && reachability.state('code-host') !== 'ok'; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(reachability.state('code-host'), 'ok');
    assert.match(seen[0], /^https:\/\/gh\.example\/rate_limit$/);
    assert.equal((await call('GET', '/deployment')).body.outage.publish, 'ok');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(seen.length, 1, 'no probing while it answers');
  }, { reachability, tickMs: 50, studio: { fetch: async (u) => { seen.push(String(u)); return new Response('{}', { status: 200 }); }, api: 'https://gh.example' } });
});
