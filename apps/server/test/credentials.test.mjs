// L20 vault and credentials: the list, Add a credential, Test connection and Remove, and the release of a value only
// to a live session's sidecar for a name its frozen roster binds, on a team the credential is granted to. No route
// returns a value, no audit row holds one, and a session (an agent) cannot reach the credentials routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, fakeRunner, plane, registerRunner } from './helpers.mjs';

const VALUE = 'xoxb-test-value-never-shown';
const team = () => ({
  version: 'abc123', summary: 'A small shop',
  roles: [
    { slug: 'chief-of-staff', reportsTo: 'owner', areas: [], brief: 'Front door.' },
    { slug: 'support', reportsTo: 'chief-of-staff', areas: [] },
  ],
  resources: [
    { id: 'slack', type: 'slack', secrets: ['SLACK_BOT_TOKEN'], tools: { command: 'slack-mcp', args: ['--stdio'] },
      permissions: { read: ['slack.read*'], write: ['slack.post'] }, effects: { 'slack.post': 'send' }, egress: ['slack.com'], tier: 'verified' },
    { id: 'pay', type: 'stripe', secrets: ['STRIPE_KEY'], tools: { command: 'stripe-mcp' } },
  ],
  bindings: [{ role: 'chief-of-staff', resource: 'slack', permission: 'read' }, { role: 'support', resource: 'pay', permission: 'write' }],
});

/** A fake Slack: auth.test answers ok only for the stored value. */
function fakeSlack() {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    return new Response(JSON.stringify(init.headers.authorization === `Bearer ${VALUE}` ? { ok: true, team: 'Shop' } : { ok: false, error: 'invalid_auth' }), { status: 200 });
  };
  return { calls, fetch };
}

const noValue = (x) => assert.ok(!JSON.stringify(x).includes(VALUE), 'no value in ' + JSON.stringify(x).slice(0, 200));

test('Add a credential needs an admin and a step-up scoped to its name; nothing returns the value; Test connection answers once a minute', async () => {
  const slack = fakeSlack();
  await plane(async ({ call, su, db }) => {
    await call('POST', '/teams', { id: 'shop' });
    // A sink's secret of the same name (the Slack notifications token) is never replaced or deleted by a credential.
    assert.equal((await call('PUT', '/secrets/SLACK_BOT_TOKEN', { value: 'sink-token' }, await su())).status, 200);
    const body = { name: 'SLACK_BOT_TOKEN', label: 'Shop Slack', service: 'slack', value: VALUE, teams: ['shop'] };
    const none = await call('POST', '/credentials', body);
    assert.equal(none.status, 401, 'no step-up');
    const wrong = await call('POST', '/credentials', body, await su('credential:OTHER'));
    assert.equal(wrong.status, 401, 'a step-up for another name is not spent here');
    const bad = await call('POST', '/credentials', { ...body, name: 'slack token' }, await su('credential:SLACK_BOT_TOKEN'));
    assert.equal(bad.status, 400);
    const added = await call('POST', '/credentials', body, await su('credential:SLACK_BOT_TOKEN'));
    assert.equal(added.status, 201, JSON.stringify(added.body));
    noValue(added.body);
    assert.match(added.body.id, /^cred_/);
    const dupe = await call('POST', '/credentials', body, await su('credential:SLACK_BOT_TOKEN'));
    assert.equal(dupe.status, 409);

    const list = await call('GET', '/credentials');
    assert.equal(list.status, 200);
    noValue(list.body);
    const [c] = list.body.credentials;
    assert.deepEqual([c.name, c.label, c.service, c.teams, c.health], ['SLACK_BOT_TOKEN', 'Shop Slack', 'slack', ['shop'], null]);
    assert.ok(list.body.services.includes('slack'));

    const t1 = await call('POST', `/credentials/${c.id}/test`);
    assert.equal(t1.status, 200);
    assert.deepEqual([t1.body.ok, t1.body.detail], [true, 'signed in to Shop']);
    noValue(t1.body);
    const t2 = await call('POST', `/credentials/${c.id}/test`);
    assert.equal(t2.body.again, true, 'a repeat inside the minute is the last answer');
    assert.equal(slack.calls.length, 1, 'one probe');
    assert.equal(slack.calls[0].url, 'https://slack.com/api/auth.test');
    assert.equal((await call('GET', '/credentials')).body.credentials[0].health.ok, true);

    const audit = await db.system("select * from audit where action in ('credential', 'step-up')");
    assert.ok(audit.some((r) => r.detail?.op === 'add') && audit.some((r) => r.detail?.op === 'test'));
    noValue(audit);
    const events = await db.system('select * from events');
    noValue(events);
    const [sealed] = await db.system("select sealed from credentials where name = 'SLACK_BOT_TOKEN'");
    assert.match(sealed.sealed, /^v1\./);
    noValue(sealed);
    assert.equal((await db.system("select sealed from secrets where name = 'SLACK_BOT_TOKEN'")).length, 1, 'the sink secret is still its own row');

    const rm = await call('DELETE', `/credentials/${c.id}`);
    assert.equal(rm.status, 401, 'removing needs a step-up');
    assert.equal((await call('DELETE', `/credentials/${c.id}`, undefined, await su('credential:SLACK_BOT_TOKEN'))).status, 200);
    assert.deepEqual((await call('GET', '/credentials')).body.credentials, []);
    assert.equal((await db.system("select sealed from credentials where name = 'SLACK_BOT_TOKEN'"))[0].sealed, null, 'the sealed value is gone');
    const { readSecret } = await import('../store.mjs');
    const { key } = await import('./helpers.mjs');
    assert.equal(await readSecret(db, key, 'acme', 'SLACK_BOT_TOKEN'), 'sink-token', 'the sink\'s token is untouched');
  }, { vaultOptions: { fetch: slack.fetch } });
});

test('the credentials routes are an admin\'s: an editor and a session (an agent) are refused', async () => {
  await plane(async ({ call, base, su }) => {
    await call('POST', '/teams', { id: 'shop' });
    assert.equal((await call('PUT', '/teams/shop/budget', { perDay: 1000, sessions: 3 }, await su())).status, 200);
    const r = await registerRunner(call);
    const runner = await fakeRunner(base, r.key, { runner: r.id });
    assert.equal((await call('POST', '/teams/shop/runs', { team: team() })).status, 201);
    await call('POST', '/teams/shop/chat', { text: 'hi' });
    const s = (await runner.next((f) => f.op === 'session.start')).body;
    for (const [m, p] of [['GET', '/credentials'], ['POST', '/credentials'], ['POST', '/credentials/cred_abcdefgh/test'], ['DELETE', '/credentials/cred_abcdefgh']]) {
      const res = await call(m, p, m === 'POST' ? {} : undefined, { authorization: `Bearer ${s.token}` });
      assert.ok([401, 403].includes(res.status), `${m} ${p} with a session token: ${res.status}`);
    }
    runner.close();
  }, { tickMs: 0 });
});

test('secret.get releases a value only for a name the session\'s frozen roster binds, on a granted team, while it is live; every release is audited without the value', async () => {
  await plane(async ({ call, base, su, db }) => {
    await call('POST', '/teams', { id: 'shop' });
    assert.equal((await call('PUT', '/teams/shop/budget', { perDay: 1000, sessions: 3 }, await su())).status, 200);
    const add = async (name, teams, value = VALUE) => (await call('POST', '/credentials', { name, service: name === 'STRIPE_KEY' ? 'stripe' : 'slack', value, teams }, await su(`credential:${name}`))).body;
    const slackCred = await add('SLACK_BOT_TOKEN', ['shop']);
    await add('STRIPE_KEY', [], 'sk-other');
    await add('UNBOUND_KEY', ['shop'], 'unbound');
    const r = await registerRunner(call);
    const runner = await fakeRunner(base, r.key, { runner: r.id });
    assert.equal((await call('POST', '/teams/shop/runs', { team: team() })).status, 201);
    await call('POST', '/teams/shop/chat', { text: 'hi' });
    const s = (await runner.next((f) => f.op === 'session.start' && f.body.role === 'chief-of-staff')).body;
    assert.deepEqual(s.secrets, ['SLACK_BOT_TOKEN'], 'names only');
    assert.deepEqual(Object.keys(s.tools.mcp), ['slack']);
    assert.deepEqual(s.tools.mcp.slack.tools, ['slack.read*'], 'a read binding gets only the read tools');
    assert.equal(s.tools.mcp.slack.command, 'slack-mcp');
    noValue(s);

    const ok = await runner.request('secret.get', { session: s.session, name: 'SLACK_BOT_TOKEN' });
    assert.equal(ok.op, 'ack');
    assert.deepEqual(ok.body, { name: 'SLACK_BOT_TOKEN', value: VALUE });
    // Every refusal is the same nack.
    for (const name of ['UNBOUND_KEY', 'STRIPE_KEY', 'NOPE', 'bad name']) {
      const no = await runner.request('secret.get', { session: s.session, name });
      assert.equal(no.op, 'nack', name);
      assert.match(no.body.problem, /not released/);
    }
    assert.equal((await runner.request('secret.get', { session: 'ses_nope', name: 'SLACK_BOT_TOKEN' })).op, 'nack');
    // Another runner of the workspace cannot ask for this session's values.
    const r2 = await registerRunner(call, 'r2');
    const other = await fakeRunner(base, r2.key, { runner: r2.id });
    assert.equal((await other.request('secret.get', { session: s.session, name: 'SLACK_BOT_TOKEN' })).op, 'nack');

    const rel = await db.system("select decision, rule, target, detail from audit where action = 'secret.release' order by at");
    assert.equal(rel.filter((x) => x.decision === 'allowed').length, 1);
    assert.deepEqual(rel.filter((x) => x.decision === 'refused').map((x) => x.rule).sort(),
      ['no-session', 'not-bound', 'not-bound', 'not-bound', 'not-this-runner'], 'a malformed name is refused before any lookup');
    noValue(rel);
    const list = (await call('GET', '/credentials')).body.credentials.find((c) => c.name === 'SLACK_BOT_TOKEN');
    assert.ok(list.lastUsedAt);
    assert.deepEqual(list.usedBy.map((u) => [u.team, u.role]), [['shop', 'chief-of-staff']]);

    // A removed credential is not released any more.
    assert.equal((await call('DELETE', `/credentials/${slackCred.id}`, undefined, await su('credential:SLACK_BOT_TOKEN'))).status, 200);
    assert.equal((await runner.request('secret.get', { session: s.session, name: 'SLACK_BOT_TOKEN' })).op, 'nack');
    runner.close(); other.close();
  }, { tickMs: 0 });
});

test('a credential on a team it is not granted to is not released, and the vault releases to the gateway in process', async () => {
  await plane(async ({ call, base, su, server, db }) => {
    await call('POST', '/teams', { id: 'shop' });
    assert.equal((await call('PUT', '/teams/shop/budget', { perDay: 1000, sessions: 3 }, await su())).status, 200);
    await call('POST', '/credentials', { name: 'SLACK_BOT_TOKEN', service: 'slack', value: VALUE, teams: [] }, await su('credential:SLACK_BOT_TOKEN'));
    const r = await registerRunner(call);
    const runner = await fakeRunner(base, r.key, { runner: r.id });
    assert.equal((await call('POST', '/teams/shop/runs', { team: team() })).status, 201);
    await call('POST', '/teams/shop/chat', { text: 'hi' });
    const s = (await runner.next((f) => f.op === 'session.start')).body;
    assert.equal((await runner.request('secret.get', { session: s.session, name: 'SLACK_BOT_TOKEN' })).op, 'nack');
    assert.equal(await server.vault.release({ tenant: 'acme', session: s.session, name: 'SLACK_BOT_TOKEN', purpose: 'gateway' }), null);
    const [refused] = await db.system("select rule from audit where action = 'secret.release' and decision = 'refused' order by at desc limit 1");
    assert.equal(refused.rule, 'not-granted');
    runner.close();
  }, { tickMs: 0 });
});
