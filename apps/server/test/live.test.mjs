// Live overrides (local PR L18, CTO review-2 R2): Stop everything, pausing or switching off one teammate, and lifting
// them are control-plane state. No code host, Git or publish is involved: this plane has no Studio and no GitHub at
// all. Stopping is one tap; lifting needs a step-up scoped to the one change; a host can stop but never lift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeRunner, plane, registerRunner } from './helpers.mjs';
import { memberOf } from '../live.mjs';

const roster = (roles = ['chief-of-staff', 'web-dev']) => ({
  version: 'abc123', repo: { url: 'https://github.com/example/shop.git', ref: 'main' },
  roles: roles.map((slug, i) => ({ slug, reportsTo: i === 0 ? 'owner' : 'chief-of-staff', areas: [], ...(i === 0 ? { brief: 'You are the front door.' } : {}) })),
});
const tool = (call, s, name, input) => call('POST', `/sessions/${s.session}/tools/${name}`, input, { authorization: `Bearer ${s.token}` });
const handoff = { to: 'web-dev', task: 'Cart', changed: 'nothing yet', verify: 'open /cart', doneWhen: 'it loads', branch: 'main' };

async function setup({ call, base, su }) {
  await call('POST', '/teams', { id: 'shop' });
  assert.equal((await call('PUT', '/teams/shop/budget', { perDay: 1000, sessions: 3 }, await su())).status, 200);
  const r = await registerRunner(call);
  const runner = await fakeRunner(base, r.key, { runner: r.id, reply: (f) => (f.op === 'session.checkpoint' ? { commit: 'c0ffee1', memory: '# notes' } : {}) });
  const run = await call('POST', '/teams/shop/runs', { team: roster() });
  assert.equal(run.status, 201);
  await call('POST', '/teams/shop/chat', { text: 'go' });
  const front = (await runner.next((f) => f.op === 'session.start' && f.body.role === 'chief-of-staff')).body;
  return { runner, front, run: run.body };
}

test('memberOf reads a teammate id and refuses anything else', () => {
  assert.deepEqual(memberOf('web-dev'), { role: 'web-dev', instance: null });
  assert.deepEqual(memberOf('support-agent#2'), { role: 'support-agent', instance: '2' });
  for (const bad of ['', 'Web Dev', 'a#b#c', 'x#', '../etc']) assert.throws(() => memberOf(bad), /a teammate is its id/);
});

test('Stop everything: one tap pauses the run and blocks starts and resumes; lifting needs a step-up for exactly it', async () => {
  await plane(async (p) => {
    const { run } = await setup(p);
    const stop = await p.call('POST', '/teams/shop/live/stop-everything', { reason: 'something looks wrong' });
    assert.equal(stop.status, 200, JSON.stringify(stop.body));
    assert.deepEqual([stop.body.kind, stop.body.runs, stop.body.reason], ['halt', [run.id], 'something looks wrong']);
    assert.match(stop.body.liveChange, /^Live change by .+: Stop everything is on/);
    assert.equal((await p.call('GET', '/teams/shop/runs')).body.runs[0].state, 'paused');
    // Twice is the same change, not a second one.
    const again = await p.call('POST', '/teams/shop/live/stop-everything', {});
    assert.equal(again.body.id, stop.body.id);
    assert.deepEqual((await p.call('GET', '/teams/shop/live')).body.live.map((o) => o.id), [stop.body.id]);
    // Nothing starts or carries on while it is on, step-up or not.
    const resume = await p.call('POST', `/runs/${run.id}/resume`, undefined, await p.su(`resume:${run.id}`));
    assert.deepEqual([resume.status, resume.body.type], [409, 'halted']);
    assert.equal((await p.call('POST', `/runs/${run.id}/stop`)).status, 200, 'stopping is never blocked');
    const start = await p.call('POST', '/teams/shop/runs', { team: roster() });
    assert.deepEqual([start.status, start.body.type], [409, 'halted']);
    // Lifting: no step-up, or one for something else, is refused and names the scope; the wrong token stays unspent.
    const bare = await p.call('DELETE', `/teams/shop/live/${stop.body.id}`);
    assert.deepEqual([bare.status, bare.body.scope], [401, `lift:${stop.body.id}`]);
    const other = await p.su('resume:run_x');
    assert.equal((await p.call('DELETE', `/teams/shop/live/${stop.body.id}`, undefined, other)).status, 401);
    const lifted = await p.call('DELETE', `/teams/shop/live/${stop.body.id}`, undefined, await p.su(`lift:${stop.body.id}`));
    assert.equal(lifted.status, 200, JSON.stringify(lifted.body));
    assert.deepEqual([lifted.body.lifted, lifted.body.resumed], [true, []], 'the run it paused was stopped meanwhile, so nothing resumes');
    assert.deepEqual((await p.call('GET', '/teams/shop/live')).body.live, []);
    assert.equal((await p.call('POST', '/teams/shop/runs', { team: roster() })).status, 201);
    const evs = (await p.call('GET', '/teams/shop/events?type=live.changed')).body.events.map((e) => e.data.op);
    assert.deepEqual(evs, ['set', 'set', 'lifted']);
    const audit = await p.db.system("select decision, detail from audit where action = 'live' order by seq");
    assert.deepEqual(audit.map((a) => a.detail.op), ['set', 'set', 'lifted']);
    assert.equal(audit.at(-1).detail.stepUp, true);
  });
});

test('lifting Stop everything resumes the runs it paused', async () => {
  await plane(async (p) => {
    const { run, runner } = await setup(p);
    const stop = (await p.call('POST', '/teams/shop/live/stop-everything', {})).body;
    await runner.next((f) => f.op === 'session.stop');
    const lifted = await p.call('DELETE', `/teams/shop/live/${stop.id}`, undefined, await p.su(`lift:${stop.id}`));
    assert.deepEqual(lifted.body.resumed, [run.id]);
    assert.equal((await p.call('GET', '/teams/shop/runs')).body.runs[0].state, 'running');
  });
});

test('Stop everything for the whole workspace reaches every team', async () => {
  await plane(async (p) => {
    await setup(p);
    await p.call('POST', '/teams', { id: 'blog' });
    const all = await p.call('POST', '/live/stop-everything', {});
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.live.map((o) => o.team).sort(), ['blog', 'shop']);
    assert.equal((await p.call('GET', '/teams/shop/runs')).body.runs[0].state, 'paused');
    assert.equal((await p.call('GET', '/teams/blog/live')).body.live[0].kind, 'halt');
  });
});

test('a teammate switched off: its session stops now, its work is held, and lifting it lets the work go', async () => {
  await plane(async (p) => {
    const { runner, front } = await setup(p);
    assert.equal((await tool(p.call, front, 'handoff', handoff)).status, 200);
    const web = (await runner.next((f) => f.op === 'session.start' && f.body.role === 'web-dev')).body;
    const off = await p.call('PUT', '/teams/shop/live/members/web-dev', { state: 'off', reason: 'it keeps retrying the deploy' });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.deepEqual([off.body.kind, off.body.member, off.body.state], ['member', 'web-dev', 'off']);
    const stop = await runner.next((f) => f.op === 'session.stop' && f.body.session === web.session);
    assert.deepEqual([stop.body.mode, stop.body.reason], ['now', 'member-off']);
    // The run carries on for everyone else; web-dev's new work waits, held.
    assert.equal((await p.call('GET', '/teams/shop/runs')).body.runs[0].state, 'running');
    const starts = () => runner.frames.filter((f) => f.op === 'session.start' && f.body.role === 'web-dev').length;
    const before = starts();
    assert.equal((await tool(p.call, front, 'handoff', { ...handoff, task: 'Checkout' })).status, 200);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(starts(), before, 'no session for a teammate that is off');
    const [held] = await p.db.system("select state from deliveries where role = 'web-dev' order by created_at desc limit 1");
    assert.equal(held.state, 'held');
    // Bad states and ids are refused; "on" is not a state you set, it is a lift.
    assert.equal((await p.call('PUT', '/teams/shop/live/members/web-dev', { state: 'on' })).status, 400);
    assert.equal((await p.call('PUT', '/teams/shop/live/members/Web%20Dev', { state: 'off' })).status, 400);
    const lifted = await p.call('DELETE', `/teams/shop/live/${off.body.id}`, undefined, await p.su(`lift:${off.body.id}`));
    assert.equal(lifted.status, 200, JSON.stringify(lifted.body));
    await runner.next((f) => f.op === 'session.start' && f.body.role === 'web-dev' && runner.frames.filter((x) => x.op === 'session.start' && x.body.role === 'web-dev').length > before);
  });
});

test('a teammate paused: its session checkpoints first and stops at a safe point', async () => {
  await plane(async (p) => {
    const { runner, front } = await setup(p);
    await tool(p.call, front, 'handoff', handoff);
    const web = (await runner.next((f) => f.op === 'session.start' && f.body.role === 'web-dev')).body;
    const paused = await p.call('PUT', '/teams/shop/live/members/web-dev', { state: 'paused' });
    assert.equal(paused.body.state, 'paused');
    await runner.next((f) => f.op === 'session.checkpoint' && f.body.session === web.session);
    const stop = await runner.next((f) => f.op === 'session.stop' && f.body.session === web.session);
    assert.deepEqual([stop.body.mode, stop.body.reason], ['finish-step', 'member-paused']);
    // Paused to off is a change of how it is stopped: the same live change, no step-up.
    const off = await p.call('PUT', '/teams/shop/live/members/web-dev', { state: 'off' });
    assert.deepEqual([off.body.id, off.body.state], [paused.body.id, 'off']);
    // The front door was never touched.
    assert.equal(runner.frames.filter((f) => f.op === 'session.stop' && f.body.session === front.session).length, 0);
  });
});

test('a publish reconciles: a new run whose team no longer has a switched-off teammate clears that live change', async () => {
  await plane(async (p) => {
    const { run } = await setup(p);
    const off = (await p.call('PUT', '/teams/shop/live/members/web-dev', { state: 'off' })).body;
    const paused = (await p.call('PUT', '/teams/shop/live/members/chief-of-staff', { state: 'paused' })).body;
    await p.call('POST', `/runs/${run.id}/stop`);
    assert.equal((await p.call('POST', '/teams/shop/runs', { team: roster(['chief-of-staff']) })).status, 201);
    const live = (await p.call('GET', '/teams/shop/live')).body.live;
    assert.deepEqual(live.map((o) => o.id), [paused.id], 'only the change the files do not say stays');
    const [row] = await p.db.system('select cleared_how from live_overrides where id = $1', [off.id]);
    assert.equal(row.cleared_how, 'published');
  });
});

test('roles: a viewer reads, an editor stops or lifts; a host may stop but never lift', async () => {
  await plane(async (p) => {
    await p.call('POST', '/teams', { id: 'shop' });
    assert.equal((await p.call('GET', '/teams/shop/live')).status, 200);
    // The admin token can do all of it; the role table (members.test) pins viewer for GET and editor for the rest.
    const { minRole } = await import('../roles.mjs');
    assert.deepEqual(['GET', 'POST', 'PUT', 'DELETE'].map((m, i) => minRole(m, ['/teams/shop/live', '/teams/shop/live/stop-everything', '/teams/shop/live/members/web-dev', '/teams/shop/live/live_abc'][i])), ['viewer', 'editor', 'editor', 'editor']);
    const { hostMay } = await import('../roles.mjs');
    assert.equal(hostMay('PUT', '/teams/shop/live/members/web-dev'), true, 'a host may stop a teammate');
    assert.equal(hostMay('POST', '/teams/shop/live/stop-everything'), true);
    assert.equal(hostMay('DELETE', '/teams/shop/live/live_abc'), false, 'a host may never lift one');
  });
});
