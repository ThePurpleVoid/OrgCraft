// Meetings in the written-round format (meetings.mjs; plans/m3-meetings-seams.md and the architect's review, proofs
// 1 to 8): turns through the ordinary deliveries, replies and the close through the team tools, the cap from tagged
// usage, the turn deadline in the tick, and the run's pause, resume and stop. PGlite here, real Postgres in CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../store.mjs';
import { checkTool } from '../tools.mjs';
import { ADMIN, fakeRunner, plane, registerRunner } from './helpers.mjs';

const MEETINGS = [
  { id: 'standup', title: 'Daily standup', agenda: 'What you did, what is next, what blocks you.', attendees: ['web-dev', 'qa', 'designer', 'chief-of-staff'], capUsd: 1 },
  { id: 'busy-check', title: 'Quick check', agenda: 'Anything urgent?', attendees: ['web-dev', 'qa'], ifBusy: 'skip', capUsd: 1 },
  { id: 'design', title: 'Design review', agenda: 'The new page', facilitator: 'web-dev', attendees: ['qa', 'designer'], capUsd: 1 },
  { id: 'catch-up', title: 'Catch-up', agenda: 'Who worked?', attendees: [], rule: 'worked-since-last', capUsd: 1 },
  { id: 'plan', title: 'Checkout plan', agenda: 'Pay later or cards first?', attendees: ['web-dev', 'qa', 'designer'], format: 'discussion', rounds: 3, capUsd: 1 },
];
const roster = (meetings = MEETINGS) => ({
  version: 'abc123', repo: { url: 'https://github.com/example/shop.git', ref: 'main' },
  roles: [
    { slug: 'chief-of-staff', reportsTo: 'owner', areas: [] },
    { slug: 'web-dev', reportsTo: 'chief-of-staff', areas: ['apps/web/**'] },
    { slug: 'qa', reportsTo: 'chief-of-staff', areas: [] },
    { slug: 'designer', reportsTo: 'chief-of-staff', areas: [] },
  ],
  meetings,
});

async function setup(p, { perDay = 1000 } = {}) {
  await p.call('POST', '/teams', { id: 'shop' });
  assert.equal((await p.call('PUT', '/teams/shop/budget', { perDay, sessions: 10 }, await p.su())).status, 200);
  const r = await registerRunner(p.call);
  const runner = await fakeRunner(p.base, r.key, { runner: r.id, maxSessions: 10 });
  const run = await p.call('POST', '/teams/shop/runs', { team: roster() });
  assert.equal(run.status, 201, JSON.stringify(run.body));
  return { runner, run: run.body };
}
/** The session that got turn `n` of a meeting (session.start, or session.message to a live one), with its token. */
const sessions = new Map();
async function turnFor(runner, meeting, role, { closing = false } = {}) {
  const f = await runner.next((x) => {
    const w = x.op === 'session.start' ? x.body.wake : x.op === 'session.message' ? x.body.message : null;
    return w?.type === 'meeting.turn' && w.data.meeting === meeting && w.data.to === role && Boolean(w.data.closing) === closing;
  });
  const sid = f.body.session;
  for (const x of runner.frames) if (x.op === 'session.start') sessions.set(x.body.session, x.body.token);
  return { session: sid, token: sessions.get(sid), wake: f.op === 'session.start' ? f.body.wake : f.body.message };
}
/** A discussion turn: the session that got `role`'s turn in `round` (the closing turn with closing). */
async function turnIn(runner, meeting, role, round, { closing = false } = {}) {
  const f = await runner.next((x) => {
    const w = x.op === 'session.start' ? x.body.wake : x.op === 'session.message' ? x.body.message : null;
    return w?.type === 'meeting.turn' && w.data.meeting === meeting && w.data.to === role && Boolean(w.data.closing) === closing && (closing || w.data.round === round);
  });
  for (const x of runner.frames) if (x.op === 'session.start') sessions.set(x.body.session, x.body.token);
  return { session: f.body.session, token: sessions.get(f.body.session), wake: f.op === 'session.start' ? f.body.wake : f.body.message };
}
const tool = (call, s, name, input) => call('POST', `/sessions/${s.session}/tools/${name}`, input, { authorization: `Bearer ${s.token}` });
const events = async (call, type) => (await call('GET', `/teams/shop/events?type=${type}`)).body.events;
const envFor = (s, role, type, data, run) => ({ specversion: '1.0', id: `ev_${Math.random().toString(36).slice(2)}`, type, version: 1, source: '/tenants/acme/teams/shop', tenant: 'acme', team: 'shop', time: new Date().toISOString(), run, actor: { kind: 'role', id: role, session: s.session }, data });

test('proof 1: a round of three ends with the minutes in the chat and one report.note; out of turn is refused', async () => {
  await plane(async (p) => {
    const { runner, run } = await setup(p);
    const m = await p.call('POST', '/teams/shop/meetings', { meeting: 'standup' });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    assert.match(m.body.id, /^mtg_/);
    assert.deepEqual(m.body.attendees, ['web-dev', 'qa', 'designer'], 'in the order sent, the facilitator left out');
    assert.deepEqual([m.body.facilitator, m.body.cap, m.body.currency, m.body.state], ['chief-of-staff', 100, 'USD', 'open'], 'no facilitator means the front door; the cap in minor units');
    const opened = await events(p.call, 'meeting.opened');
    assert.equal(opened.length, 1);
    assert.equal(opened[0].subject, `meeting/${m.body.id}`);

    const web = await turnFor(runner, m.body.id, 'web-dev');
    assert.deepEqual([web.wake.data.turn, web.wake.data.of, web.wake.data.closing, web.wake.data.replies], [1, 3, false, []]);
    assert.equal(web.wake.data.agenda, 'What you did, what is next, what blocks you.');
    // The front door is busy with a chat meanwhile: its closing turn reaches the live session as session.message.
    assert.equal((await p.call('POST', '/teams/shop/chat', { text: 'How is the cart?' })).status, 201);
    assert.equal((await tool(p.call, web, 'meeting_reply', { meeting: m.body.id, text: 'Built the cart. Next: receipts. Nothing blocks me.' })).status, 200);
    const qa = await turnFor(runner, m.body.id, 'qa');
    assert.deepEqual(qa.wake.data.replies, [{ role: 'web-dev', text: 'Built the cart. Next: receipts. Nothing blocks me.' }], 'later attendees see the replies so far');
    const twice = await tool(p.call, web, 'meeting_reply', { meeting: m.body.id, text: 'again' });
    assert.equal(twice.status, 422);
    assert.match(twice.body.error ?? twice.body.detail ?? JSON.stringify(twice.body), /not your turn/);
    assert.equal((await tool(p.call, qa, 'meeting_reply', { meeting: m.body.id, text: 'Tested checkout.' })).status, 200);
    const des = await turnFor(runner, m.body.id, 'designer');
    // The facilitator cannot close before its closing turn.
    const early = await tool(p.call, { session: des.session, token: des.token }, 'meeting_close', { meeting: m.body.id, minutes: 'x' });
    assert.equal(early.status, 422);
    assert.equal((await tool(p.call, des, 'meeting_reply', { meeting: m.body.id, text: 'Drew the receipt.' })).status, 200);

    const close = await turnFor(runner, m.body.id, 'chief-of-staff', { closing: true });
    assert.equal(close.wake.data.replies.length, 3);
    assert.equal(close.wake.data.capped, false);
    const minutes = 'Cart built; checkout tested; receipt drawn. Next: receipts.';
    const r = await tool(p.call, close, 'meeting_close', { meeting: m.body.id, minutes, actionItems: [{ to: 'web-dev', task: 'Ship receipts', doneWhen: 'receipts are on the order page' }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const [closed] = await events(p.call, 'meeting.closed');
    assert.deepEqual([closed.data.outcome, closed.data.minutes, closed.data.replies], ['completed', minutes, 3]);
    const chat = (await p.call('GET', '/teams/shop/chat')).body.items.filter((e) => e.type === 'chat.message' && e.data.meeting === m.body.id);
    assert.equal(chat.length, 1, 'the minutes are in the chat once');
    assert.equal(chat[0].data.from, 'chief-of-staff');
    assert.match(chat[0].data.text, /Cart built/);
    const notes = (await events(p.call, 'report.note')).filter((e) => e.data.meeting === m.body.id);
    assert.equal(notes.length, 1, 'one report.note on the board');
    assert.match(notes[0].data.detail, /^Minutes: Daily standup .*\/t\/shop\/meetings\/mtg_/);
    const [mins] = await events(p.call, 'meeting.minutes');
    assert.deepEqual([mins.data.meeting, mins.data.meetingId, mins.data.actions, mins.data.decisions, mins.data.needsYou], ['Daily standup', m.body.id, [{ to: 'web-dev', task: 'Ship receipts' }], [], 0], 'the email sink\'s meeting.minutes (events.md)');
    const handoff = (await events(p.call, 'message.handoff')).find((e) => e.data.meeting === m.body.id);
    assert.deepEqual([handoff.data.to, handoff.actor.id, handoff.subject], ['web-dev', 'chief-of-staff', `meeting/${m.body.id}`]);
    assert.match(handoff.data.detail, /From Daily standup: Ship receipts\. Done when: receipts are on the order page/);
    const page = await p.call('GET', `/teams/shop/meetings/${m.body.id}`);
    assert.deepEqual([page.body.state, page.body.outcome, page.body.minutes, page.body.run], ['closed', 'completed', minutes, run.id]);
    assert.equal((await p.call('GET', '/teams/shop/meetings')).body.meetings.length, 1);
    // Closed: no more replies, no second close.
    assert.equal((await tool(p.call, close, 'meeting_close', { meeting: m.body.id, minutes })).status, 422);
  }, { publicUrl: 'https://plane.example', tickMs: 0 });
});

test('proof 2: a busy attendee with ifBusy skip is skipped (meeting.skipped) and the meeting still completes', async () => {
  await plane(async (p) => {
    const { runner, run } = await setup(p);
    // qa is in the middle of a turn of its own.
    await p.db.tenant('acme', ({ q }) => q("insert into sessions(id, tenant, team, run, role, state) values ('ses_busy', 'acme', 'shop', $1, 'qa', 'running')", [run.id]));
    const m = (await p.call('POST', '/teams/shop/meetings', { meeting: 'busy-check' })).body;
    const web = await turnFor(runner, m.id, 'web-dev');
    assert.equal((await tool(p.call, web, 'meeting_reply', { meeting: m.id, text: 'Nothing urgent.' })).status, 200);
    const [skipped] = await events(p.call, 'meeting.skipped');
    assert.deepEqual([skipped.data.role, skipped.data.reason], ['qa', 'busy']);
    const close = await turnFor(runner, m.id, 'chief-of-staff', { closing: true });
    assert.deepEqual(close.wake.data.skipped, [{ role: 'qa', reason: 'busy' }]);
    assert.equal((await tool(p.call, close, 'meeting_close', { meeting: m.id, minutes: 'Nothing urgent; qa was busy.' })).status, 200);
    assert.equal((await p.call('GET', `/teams/shop/meetings/${m.id}`)).body.outcome, 'completed');
  }, { tickMs: 0 });
});

test('proof 3: a turn past its deadline is skipped as missed, and the round moves on', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p);
    const m = (await p.call('POST', '/teams/shop/meetings', { meeting: 'standup' })).body;
    await turnFor(runner, m.id, 'web-dev');
    const [row] = await p.db.system('select turn_due from meetings where id = $1', [m.id]);
    assert.ok(new Date(row.turn_due) > new Date(), 'the deadline is in the future');
    // A paused run suspends the deadline.
    await p.db.system("update meetings set turn_due = now() - interval '1 minute' where id = $1", [m.id]);
    await p.db.system("update runs set state = 'paused' where team = 'shop'");
    await p.server.bus.tick();
    assert.equal((await events(p.call, 'meeting.skipped')).length, 0, 'nothing is missed while the run is paused');
    await p.db.system("update runs set state = 'running' where team = 'shop'");
    await p.server.bus.tick();
    const [skipped] = await events(p.call, 'meeting.skipped');
    assert.deepEqual([skipped.data.role, skipped.data.reason], ['web-dev', 'missed']);
    const qa = await turnFor(runner, m.id, 'qa');
    assert.equal(qa.wake.data.turn, 2);
  }, { tickMs: 0 });
});

test('proof 4 and 5: the cap reached mid-round skips the rest and closes capped; a wrong tag spends nothing of the meeting', async () => {
  await plane(async (p) => {
    const { runner, run } = await setup(p);
    const m = (await p.call('POST', '/teams/shop/meetings', { meeting: 'standup' })).body;
    const web = await turnFor(runner, m.id, 'web-dev');
    // Proof 5 first: usage tagged with this meeting from a session that was never given one of its turns.
    await p.call('POST', '/teams/shop/chat', { text: 'hello' });
    const front = await runner.next((f) => f.op === 'session.start' && f.body.role === 'chief-of-staff');
    const stray = envFor(front.body, 'chief-of-staff', 'usage.recorded', { inputTokens: 1, outputTokens: 1, cost: 500, currency: 'USD', meeting: m.id });
    assert.equal((await runner.request('events', { events: [stray] })).op, 'ack');
    assert.equal((await p.call('GET', `/teams/shop/meetings/${m.id}`)).body.spent, 0, 'not this meeting\'s spend');
    assert.equal((await p.call('GET', '/teams/shop/budget')).body.today.spent, 500, 'but the day still counts it');

    assert.equal((await tool(p.call, web, 'meeting_reply', { meeting: m.id, text: 'Done.' })).status, 200);
    await turnFor(runner, m.id, 'qa');
    // web-dev's turn cost the whole cap.
    const used = envFor(web, 'web-dev', 'usage.recorded', { inputTokens: 1, outputTokens: 1, cost: 100, currency: 'USD', meeting: m.id });
    assert.equal((await runner.request('events', { events: [used] })).op, 'ack');
    const skipped = (await events(p.call, 'meeting.skipped')).map((e) => [e.data.role, e.data.reason]);
    assert.deepEqual(skipped, [['qa', 'capped'], ['designer', 'capped']]);
    const close = await turnFor(runner, m.id, 'chief-of-staff', { closing: true });
    assert.equal(close.wake.data.capped, true);
    assert.equal(close.wake.data.replies.length, 1);
    const late = await p.db.system("select state from deliveries d join events e on e.team = d.team and e.id = d.event where e.type = 'meeting.turn' and e.envelope->'data'->>'to' = 'qa'");
    assert.ok(late.every((d) => ['dead', 'acked', 'sent'].includes(d.state)));
    assert.equal((await tool(p.call, close, 'meeting_close', { meeting: m.id, minutes: 'Only web-dev spoke before the cap.' })).status, 200);
    const page = (await p.call('GET', `/teams/shop/meetings/${m.id}`)).body;
    assert.deepEqual([page.outcome, page.spent, page.capped], ['capped', 100, true]);
    const chat = (await p.call('GET', '/teams/shop/chat')).body.items.find((e) => e.data?.meeting === m.id && e.type === 'chat.message');
    assert.match(chat.data.text, /cost cap/);
    // The facilitator's closing turn is billed once, after the close; then a closed meeting takes nothing more.
    const closing = envFor(close, 'chief-of-staff', 'usage.recorded', { inputTokens: 1, outputTokens: 1, cost: 7, currency: 'USD', meeting: m.id });
    await runner.request('events', { events: [closing] });
    const again = envFor(web, 'web-dev', 'usage.recorded', { inputTokens: 1, outputTokens: 1, cost: 9, currency: 'USD', meeting: m.id });
    await runner.request('events', { events: [again] });
    assert.equal((await p.call('GET', `/teams/shop/meetings/${m.id}`)).body.spent, 107, 'the closing turn counts; a closed meeting does not');
    assert.equal(run.state, 'running');
  }, { tickMs: 0 });
});

test('proof 6: a facilitator that is not the front door sends its decisions to the front door as a BLOCKED, not a card', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p);
    const m = (await p.call('POST', '/teams/shop/meetings', { meeting: 'design' })).body;
    assert.equal(m.facilitator, 'web-dev');
    for (const role of ['qa', 'designer']) {
      const s = await turnFor(runner, m.id, role);
      assert.equal((await tool(p.call, s, 'meeting_reply', { meeting: m.id, text: `${role}: fine by me` })).status, 200);
    }
    const close = await turnFor(runner, m.id, 'web-dev', { closing: true });
    const decision = { question: 'Ship the new page this week?', options: [{ id: 'yes', label: 'Ship it', consequence: 'It goes live on Friday.' }, { id: 'wait', label: 'Wait a week', consequence: 'More testing first.' }], recommended: 'yes', why: 'QA passed' };
    const r = await tool(p.call, close, 'meeting_close', { meeting: m.id, minutes: 'Agreed on the layout.', decisions: [decision] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.cards, undefined);
    const [{ n }] = await p.db.system("select count(*)::int as n from cards where kind = 'decision'");
    assert.equal(n, 0, 'no card');
    const blocked = (await events(p.call, 'message.blocked')).find((e) => e.data.meeting === m.id);
    assert.deepEqual([blocked.data.to, blocked.data.needFrom, blocked.actor.id], ['chief-of-staff', 'owner', 'web-dev']);
    assert.match(blocked.data.recommendation, /^yes \(Ship it\): QA passed/);
    // The BLOCKED wakes the front door.
    await runner.next((f) => f.op === 'session.start' && f.body.role === 'chief-of-staff' && f.body.wake.type === 'message.blocked');
  }, { tickMs: 0 });
});

test('the front door as facilitator turns a decision into a card', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p);
    const m = (await p.call('POST', '/teams/shop/meetings', { meeting: 'busy-check' })).body;
    for (const role of ['web-dev', 'qa']) {
      const s = await turnFor(runner, m.id, role);
      await tool(p.call, s, 'meeting_reply', { meeting: m.id, text: 'ok' });
    }
    const close = await turnFor(runner, m.id, 'chief-of-staff', { closing: true });
    const r = await tool(p.call, close, 'meeting_close', { meeting: m.id, minutes: 'ok', decisions: [{ question: 'Hire a designer?', options: [{ id: 'yes', label: 'Yes', consequence: 'We post the role.' }, { id: 'no', label: 'No', consequence: 'We wait.' }], recommended: 'no' }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.cards.length, 1);
    const [card] = await p.db.system('select kind, session, state from cards where id = $1', [r.body.cards[0]]);
    assert.deepEqual([card.kind, card.session, card.state], ['decision', close.session, 'open']);
  }, { tickMs: 0 });
});

test('proof 7 and 8: a second start of an open meeting is refused; stopping the run abandons it', async () => {
  await plane(async (p) => {
    const { runner, run } = await setup(p);
    const m = (await p.call('POST', '/teams/shop/meetings', { meeting: 'standup' })).body;
    const again = await p.call('POST', '/teams/shop/meetings', { meeting: 'standup' });
    assert.equal(again.status, 409);
    assert.match(again.body.error ?? JSON.stringify(again.body), /already open/);
    assert.equal((await p.call('POST', '/teams/shop/meetings', { meeting: 'nope' })).status, 404);
    assert.equal((await p.call('POST', '/teams/shop/meetings', {})).status, 400);
    const web = await turnFor(runner, m.id, 'web-dev');
    // Paused: the turn waits; resumed: the deadline starts again.
    assert.equal((await p.call('POST', `/runs/${run.id}/pause`)).status, 200);
    assert.equal((await p.call('POST', '/teams/shop/meetings', { meeting: 'design' })).status, 409, 'no meeting starts while the run is paused');
    assert.equal((await p.call('POST', `/runs/${run.id}/resume`, undefined, await p.su(`resume:${run.id}`))).status, 200);
    assert.equal((await p.call('POST', `/runs/${run.id}/stop`)).status, 200);
    const [closed] = await events(p.call, 'meeting.closed');
    assert.deepEqual([closed.data.meeting, closed.data.outcome], [m.id, 'abandoned']);
    assert.equal((await p.call('GET', `/teams/shop/meetings/${m.id}`)).body.outcome, 'abandoned');
    assert.equal((await events(p.call, 'meeting.turn')).filter((e) => e.data.closing).length, 0, 'no minutes turn');
    assert.equal(web.wake.data.to, 'web-dev');
    assert.equal((await p.call('POST', '/teams/shop/meetings', { meeting: 'standup' })).status, 409, 'no run is going');
  }, { tickMs: 0 });
});

test('start checks: the budget left today, the worked-since-last rule, and the definitions a run is started with', async () => {
  await plane(async (p) => {
    await p.call('POST', '/teams', { id: 'shop' });
    assert.equal((await p.call('POST', '/teams/shop/meetings', { meeting: 'standup' })).status, 409, 'no run');
    assert.equal((await p.call('PUT', '/teams/shop/budget', { perDay: 150, sessions: 10 }, await p.su())).status, 200);
    const bad = await p.call('POST', '/teams/shop/runs', { team: roster([{ id: 'x', title: 'X', attendees: ['nobody'], capUsd: 1 }]) });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error ?? JSON.stringify(bad.body), /nobody is not in the team/);
    assert.equal((await p.call('POST', '/teams/shop/runs', { team: roster([{ id: 'x', title: 'X', attendees: ['qa'], capUsd: 0 }]) })).status, 400);
    const run = (await p.call('POST', '/teams/shop/runs', { team: roster() })).body;
    // 100 of 150 spent: 50 left, below the 100 cap.
    await p.m3.tx('acme', (ctx) => ctx.emit('shop', 'usage.recorded', { inputTokens: 1, outputTokens: 1, cost: 100, currency: 'USD' }, { run: run.id }));
    const low = await p.call('POST', '/teams/shop/meetings', { meeting: 'standup' });
    assert.equal(low.status, 409);
    assert.match(low.body.error ?? JSON.stringify(low.body), /50 left/);
    // capUsd is dollars: a budget in another currency is refused rather than converted wrongly.
    await p.call('PUT', '/teams/shop/budget', { perDay: 100000, currency: 'JPY', sessions: 10 }, await p.su());
    const yen = await p.call('POST', '/teams/shop/meetings', { meeting: 'standup' });
    assert.equal(yen.status, 409);
    assert.match(yen.body.error ?? JSON.stringify(yen.body), /US dollars/);
    await p.call('PUT', '/teams/shop/budget', { perDay: 1000, currency: 'USD', sessions: 10 }, await p.su());
    // worked-since-last: nobody has reported yet, then qa does.
    assert.equal((await p.call('POST', '/teams/shop/meetings', { meeting: 'catch-up' })).status, 409);
    await p.m3.tx('acme', (ctx) => ctx.emit('shop', 'report.status', { status: 'working', task: 'Checkout' }, { run: run.id, actor: { kind: 'role', id: 'qa', via: 'tool' } }));
    const m = await p.call('POST', '/teams/shop/meetings', { meeting: 'catch-up' });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    assert.deepEqual(m.body.attendees, ['qa']);
  }, { tickMs: 0 });
});

test('meetings keep tenants apart', async () => {
  await plane(async (p) => {
    await setup(p);
    await p.call('POST', '/teams/shop/meetings', { meeting: 'standup' });
    await store.ensureTenant(p.db, 'rival');
    assert.ok((await p.db.tenant('acme', ({ q }) => q('select * from meetings'))).length > 0);
    assert.deepEqual(await p.db.tenant('rival', ({ q }) => q('select * from meetings')), [], 'invisible to another tenant');
    assert.deepEqual(await p.db.tenant('rival', ({ q }) => q("update meetings set spent = 0 returning id")), [], 'nor can it change them');
    await assert.rejects(p.db.tenant('rival', ({ q }) => q("insert into meetings(id, tenant, team, run, definition, title, facilitator, cap, opened_by) values ('mtg_x', 'acme', 'shop', 'run_x', 'x', 'X', 'qa', 1, 'x')")), /row-level security|violates/);
    assert.equal((await p.call('GET', '/teams/shop/meetings/mtg_nope')).status, 404);
  }, { tickMs: 0 });
});

test('tools/1 checks meeting_reply and meeting_close', () => {
  const ctx = { role: 'web-dev', frontDoor: false, frontDoorRole: 'chief-of-staff', roster: ['chief-of-staff', 'web-dev', 'qa'] };
  assert.ok(checkTool('meeting_reply', { meeting: 'mtg_1', text: 'ok' }, ctx).input);
  assert.ok(checkTool('meeting_reply', { meeting: 'standup', text: 'ok' }, ctx).problems);
  assert.ok(checkTool('meeting_reply', { meeting: 'mtg_1' }, ctx).problems);
  assert.ok(checkTool('meeting_close', { meeting: 'mtg_1', minutes: 'x'.repeat(20_001) }, ctx).problems);
  assert.match(checkTool('meeting_close', { meeting: 'mtg_1', minutes: 'm', actionItems: [{ to: 'qa', task: 't' }] }, ctx).problems.join(' '), /doneWhen is required/);
  assert.match(checkTool('meeting_close', { meeting: 'mtg_1', minutes: 'm', actionItems: [{ to: 'nobody', task: 't', doneWhen: 'd' }] }, ctx).problems.join(' '), /not a role/);
  assert.match(checkTool('meeting_close', { meeting: 'mtg_1', minutes: 'm', actionItems: Array.from({ length: 21 }, () => ({ to: 'qa', task: 't', doneWhen: 'd' })) }, ctx).problems.join(' '), /at most 20/);
  assert.match(checkTool('meeting_close', { meeting: 'mtg_1', minutes: 'm', decisions: Array.from({ length: 5 }, () => ({})) }, ctx).problems.join(' '), /at most 4/);
  assert.match(checkTool('meeting_close', { meeting: 'mtg_1', minutes: 'm', decisions: [{ question: 'q', recommended: 'z', options: [{ id: 'a', label: 'A', consequence: 'c' }, { id: 'b', label: 'B', consequence: 'c' }] }] }, ctx).problems.join(' '), /recommended must be one of/);
  assert.ok(checkTool('meeting_close', { meeting: 'mtg_1', minutes: 'm', actionItems: [{ to: 'qa', task: 't', doneWhen: 'd' }], decisions: [{ question: 'q', recommended: 'a', options: [{ id: 'a', label: 'A', consequence: 'c' }, { id: 'b', label: 'B', consequence: 'c' }] }] }, ctx).input);
});

void ADMIN;

test('G-15: the front door starts an ad hoc meeting from the chat; no cap given means the team default, inside the daily budget', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p);
    await p.call('POST', '/teams/shop/chat', { text: 'Web dev and QA on the checkout errors, now' });
    const front = await runner.next((f) => f.op === 'session.start' && f.body.role === 'chief-of-staff');
    const fd = { session: front.body.session, token: front.body.token };
    // A role that is not on the team: refused.
    const r0 = await tool(p.call, fd, 'meeting_start', { title: 'Checkout errors', agenda: 'Why do payments fail?', attendees: ['web-dev', 'nobody'] });
    assert.equal(r0.status, 422, JSON.stringify(r0.body));
    const r = await tool(p.call, fd, 'meeting_start', { title: 'Checkout errors', agenda: 'Why do payments fail?', attendees: ['web-dev', 'qa', 'chief-of-staff'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.attendees, r.body.cap, r.body.currency], [['web-dev', 'qa'], 100, 'USD'], 'the facilitator left out; a tenth of the 1000 daily cap');
    const web = await turnFor(runner, r.body.meeting, 'web-dev');
    assert.equal(web.wake.data.title, 'Checkout errors');
    assert.equal((await tool(p.call, web, 'meeting_reply', { meeting: r.body.meeting, text: 'The card form times out.' })).status, 200);
    // A busy attendee (next-pause): the turn waits in its queue and is answered after its current step.
    const qa = await turnFor(runner, r.body.meeting, 'qa');
    assert.equal((await tool(p.call, qa, 'meeting_reply', { meeting: r.body.meeting, text: 'Reproduced on staging.' })).status, 200);
    const close = await turnFor(runner, r.body.meeting, 'chief-of-staff', { closing: true });
    assert.equal(close.session, fd.session, 'the front door that started it runs it');
    // An action item for a role on the team that did not attend: refused, so a reply cannot steer work outside the meeting.
    const outside = await tool(p.call, close, 'meeting_close', { meeting: r.body.meeting, minutes: 'm', actionItems: [{ to: 'designer', task: 'Redraw checkout', doneWhen: 'drawn' }] });
    assert.equal(outside.status, 422, JSON.stringify(outside.body));
    assert.match(JSON.stringify(outside.body), /designer did not attend/);
    const done = await tool(p.call, close, 'meeting_close', { meeting: r.body.meeting, minutes: 'The card form times out; reproduced.', actionItems: [{ to: 'web-dev', task: 'Fix the card form timeout', doneWhen: 'checkout passes on staging' }] });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const page = (await p.call('GET', `/teams/shop/meetings/${r.body.meeting}`)).body;
    assert.deepEqual([page.adhoc, page.outcome, page.facilitator], [true, 'completed', 'chief-of-staff']);
    assert.ok((await p.call('GET', '/teams/shop/chat')).body.items.some((e) => e.type === 'chat.message' && e.data.meeting === r.body.meeting), 'minutes in the chat');
    assert.ok((await events(p.call, 'message.handoff')).some((e) => e.data.meeting === r.body.meeting && e.data.to === 'web-dev'), 'the action as a HANDOFF');

    // The team default meeting cap, and a cap in another currency refused.
    assert.equal((await p.call('PUT', '/teams/shop/budget', { meetingCap: 40 })).status, 200, 'lowering needs no step-up');
    const r2 = await tool(p.call, fd, 'meeting_start', { title: 'Again', attendees: ['qa'] });
    assert.equal(r2.body.cap, 40);
    const r3 = await tool(p.call, fd, 'meeting_start', { title: 'Euro', attendees: ['designer'], cap: { amount: 50, currency: 'EUR' } });
    assert.equal(r3.status, 422);
    assert.match(JSON.stringify(r3.body), /in EUR and this team's budget is in USD/);
    const r4 = await tool(p.call, fd, 'meeting_start', { title: 'Big', attendees: ['designer'], cap: { amount: 5000, currency: 'USD' } });
    assert.match(JSON.stringify(r4.body), /above the team's meeting cap \(40\); an owner can raise it in Budget/);
    // An explicit cap cannot go around the step-up-protected meeting cap, from chat or from the Studio.
    const r5 = await tool(p.call, fd, 'meeting_start', { title: 'Just over', attendees: ['designer'], cap: { amount: 41, currency: 'USD' } });
    assert.equal(r5.status, 422);
    assert.match(JSON.stringify(r5.body), /above the team's meeting cap \(40\)/);
    const s5 = await p.call('POST', '/teams/shop/meetings', { adhoc: { title: 'Just over', attendees: ['designer'], cap: { amount: 41, currency: 'USD' } } });
    assert.equal(s5.status, 409);
    assert.match(JSON.stringify(s5.body), /above the team's meeting cap \(40\)/);
    assert.equal((await p.call('PUT', '/teams/shop/budget', { meetingCap: 2000 })).status, 409, 'not above perDay');
    assert.equal((await p.call('PUT', '/teams/shop/budget', { meetingCap: 500 })).status, 401, 'raising it needs step-up');
    // Another role cannot start one.
    const webS = { session: web.session, token: web.token };
    assert.equal((await tool(p.call, webS, 'meeting_start', { title: 'Mine', attendees: ['qa'] })).status, 403);
    // A person can start one too (POST /teams/{team}/meetings { adhoc }).
    const byPerson = await p.call('POST', '/teams/shop/meetings', { adhoc: { title: 'Quick sync', attendees: ['designer'] } });
    assert.equal(byPerson.status, 201, JSON.stringify(byPerson.body));
    assert.deepEqual([byPerson.body.adhoc, byPerson.body.facilitator, byPerson.body.cap], [true, 'chief-of-staff', 40]);
    // Open meetings hold what is left of their caps: two open (40 + 40) and a daily cap of 100 leave at most 20.
    assert.equal((await p.call('PUT', '/teams/shop/budget', { perDay: 100 })).status, 200);
    const r6 = await tool(p.call, fd, 'meeting_start', { title: 'One more', attendees: ['qa'], cap: { amount: 30, currency: 'USD' } });
    assert.equal(r6.status, 422);
    assert.match(JSON.stringify(r6.body), /after 80 held by open meetings, less than the meeting's cap of 30/);
    // Lowering perDay below the meeting cap is a lowering: no step-up, and the meeting cap comes down with it.
    const low = await p.call('PUT', '/teams/shop/budget', { perDay: 30 });
    assert.equal(low.status, 200, JSON.stringify(low.body));
    assert.deepEqual([low.body.perDay, low.body.meetingCap], [30, 30]);
  }, { tickMs: 0 });
});

test('discussion: attendees answer each other for up to the rounds set; done drops an attendee; the facilitator closes with decisions and actions', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p);
    const m = (await p.call('POST', '/teams/shop/meetings', { meeting: 'plan' })).body;
    assert.deepEqual([m.format, m.rounds, m.round], ['discussion', 3, 1]);
    const [opened] = await events(p.call, 'meeting.opened');
    assert.deepEqual([opened.data.format, opened.data.rounds], ['discussion', 3]);
    const say = async (role, round, text, more = {}) => {
      const s = await turnIn(runner, m.id, role, round);
      const r = await tool(p.call, s, 'meeting_reply', { meeting: m.id, text, ...more });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return s.wake.data;
    };
    // Round 1: everyone, in order, each seeing what was said before.
    let w = await say('web-dev', 1, 'Cards first: pay later needs a new provider.');
    assert.deepEqual([w.turn, w.of, w.round, w.rounds], [1, 3, 1, 3]);
    w = await say('qa', 1, 'Agree; cards are already tested.');
    assert.deepEqual(w.replies.map((r) => [r.role, r.round]), [['web-dev', 1]]);
    await say('designer', 1, 'Pay later converts better on mobile.');
    // Round 2: they answer each other. web-dev has nothing more to add.
    w = await say('web-dev', 2, 'Nothing to add: cards first, pay later next.', { done: true });
    assert.deepEqual([w.turn, w.of, w.round], [1, 3, 2]);
    assert.deepEqual(w.replies.map((r) => r.role), ['web-dev', 'qa', 'designer'], 'the whole transcript');
    await say('qa', 2, 'Designer has a point; we can test pay later in a week.');
    await say('designer', 2, 'Then cards now, pay later in the next release.', { done: true });
    // Round 3: only qa is left to ask.
    w = await say('qa', 3, 'Agreed.', { done: true });
    assert.deepEqual([w.turn, w.of, w.round], [1, 1, 3], 'of counts only the attendees asked this round');
    const replied = await events(p.call, 'meeting.replied');
    assert.deepEqual(replied.map((e) => [e.data.role, e.data.round, e.data.done ?? false]), [
      ['web-dev', 1, false], ['qa', 1, false], ['designer', 1, false], ['web-dev', 2, true], ['qa', 2, false], ['designer', 2, true], ['qa', 3, true],
    ]);
    const close = await turnIn(runner, m.id, 'chief-of-staff', 0, { closing: true });
    assert.deepEqual([close.wake.data.round, close.wake.data.rounds, close.wake.data.replies.length, close.wake.data.capped], [3, 3, 7, false]);
    const r = await tool(p.call, close, 'meeting_close', {
      meeting: m.id, minutes: 'Cards first; pay later in the next release.',
      actionItems: [{ to: 'web-dev', task: 'Ship card checkout', doneWhen: 'cards work end to end' }],
      decisions: [{ question: 'Pay later in the next release?', options: [{ id: 'yes', label: 'Yes', consequence: 'Planned next.' }, { id: 'no', label: 'No', consequence: 'Dropped.' }], recommended: 'yes' }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [closed] = await events(p.call, 'meeting.closed');
    assert.deepEqual([closed.data.outcome, closed.data.rounds, closed.data.replies, closed.data.actionItems, closed.data.decisions], ['completed', 3, 7, 1, 1]);
    assert.ok(r.body.cards?.length === 1, 'the front door facilitator turns the decision into a card');
  }, { tickMs: 0 });
});

test('discussion: when everyone is done early the facilitator closes early; done is refused as not boolean', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p);
    const m = (await p.call('POST', '/teams/shop/meetings', { meeting: 'plan' })).body;
    const s = await turnIn(runner, m.id, 'web-dev', 1);
    assert.equal((await tool(p.call, s, 'meeting_reply', { meeting: m.id, text: 'x', done: 'yes' })).status, 422);
    for (const role of ['web-dev', 'qa', 'designer']) {
      const t = await turnIn(runner, m.id, role, 1);
      assert.equal((await tool(p.call, t, 'meeting_reply', { meeting: m.id, text: `${role}: nothing to add`, done: true })).status, 200);
    }
    const close = await turnIn(runner, m.id, 'chief-of-staff', 0, { closing: true });
    assert.deepEqual([close.wake.data.round, close.wake.data.rounds], [1, 3], 'closed after round 1 of 3');
  }, { tickMs: 0 });
});

test('discussion: the cap skips each attendee still to speak once, from the round it would speak in next', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p);
    const m = (await p.call('POST', '/teams/shop/meetings', { meeting: 'plan' })).body;
    const web = await turnIn(runner, m.id, 'web-dev', 1);
    assert.equal((await tool(p.call, web, 'meeting_reply', { meeting: m.id, text: 'Cards first.' })).status, 200);
    await turnIn(runner, m.id, 'qa', 1);
    const used = envFor(web, 'web-dev', 'usage.recorded', { inputTokens: 1, outputTokens: 1, cost: 100, currency: 'USD', meeting: m.id });
    assert.equal((await runner.request('events', { events: [used] })).op, 'ack');
    const skipped = (await events(p.call, 'meeting.skipped')).map((e) => [e.data.role, e.data.reason, e.data.fromRound]);
    assert.deepEqual(skipped, [['web-dev', 'capped', 2], ['qa', 'capped', 1], ['designer', 'capped', 1]], 'one per attendee, not one per turn per round');
    const close = await turnIn(runner, m.id, 'chief-of-staff', 0, { closing: true });
    assert.equal(close.wake.data.capped, true);
  }, { tickMs: 0 });
});

test('discussion: past its overall deadline the facilitator gets the closing turn early, timed out', async () => {
  await plane(async (p) => {
    const { runner } = await setup(p);
    const m = (await p.call('POST', '/teams/shop/meetings', { meeting: 'plan' })).body;
    await turnIn(runner, m.id, 'web-dev', 1);
    await p.db.system("update meetings set opened_at = now() - interval '5 hours' where id = $1", [m.id]);
    await p.server.bus.tick();
    const close = await turnIn(runner, m.id, 'chief-of-staff', 0, { closing: true });
    assert.deepEqual([close.wake.data.timedOut, close.wake.data.capped], [true, false]);
    const r = await tool(p.call, close, 'meeting_close', { meeting: m.id, minutes: 'Nobody answered in time.' });
    assert.equal(r.status, 200);
    const [closed] = await events(p.call, 'meeting.closed');
    assert.equal(closed.data.timedOut, true);
  }, { tickMs: 0 });
});

test('discussion: past 40 KB an attendee\'s earlier-round replies go before anyone\'s latest, so every voice stays', async () => {
  const { carried } = await import('../meetings.mjs');
  const big = 'x'.repeat(7000);
  const replies = [];
  for (const round of [1, 2, 3]) for (const role of ['a', 'b', 'c']) replies.push({ role, text: `${role}${round} ${big}`, round });
  const out = carried(replies);
  assert.ok(out.dropped > 0 && /left out/.test(out.note));
  const roles = new Set(out.replies.map((r) => r.role));
  assert.deepEqual([...roles].sort(), ['a', 'b', 'c'], 'every attendee is still there');
  for (const role of ['a', 'b', 'c']) assert.ok(out.replies.some((r) => r.role === role && r.round === 3), `${role}'s latest reply is kept`);
  assert.ok(!out.replies.some((r) => r.round === 1), 'the earliest round goes first');
});
