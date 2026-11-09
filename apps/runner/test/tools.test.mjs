// tools/1 checks (docs/contracts/team-tools.md): one passing and one refused input per tool, including a SIGNOFF
// with no evidence and an ask_owner from a role that is not the front door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTool, TOOLS } from '../tools.mjs';

const ctx = { role: 'web-dev', frontDoor: false, frontDoorRole: 'chief-of-staff', roster: ['web-dev', 'qa-web', 'chief-of-staff', 'release-manager'] };
const ok = (name, input, c = ctx) => { const r = checkTool(name, input, c); assert.equal(r.problems, undefined, `${name}: ${r.problems}`); return r.input; };
const no = (name, input, re, c = ctx) => { const r = checkTool(name, input, c); assert.ok(r.problems, `${name} should be refused`); assert.match(r.problems.join(' | '), re); };

test('the seven tools of tools/1 and the three meeting tools, and nothing else', () => {
  assert.deepEqual(Object.keys(TOOLS).sort(), ['ask_owner', 'blocked', 'bug', 'handoff', 'meeting_close', 'meeting_reply', 'meeting_start', 'ready_to_try', 'report', 'request_approval', 'signoff']);
  no('merge', {}, /no team tool called merge/);
});

test('report', () => {
  assert.deepEqual(ok('report', { status: 'waiting', task: 'Login', waitingOn: 'CI on PR 57', pr: 57, extra: 'ignored' }), { status: 'waiting', task: 'Login', waitingOn: 'CI on PR 57', pr: 57 });
  ok('report', { status: 'done' });
  no('report', { status: 'working' }, /needs the task/);
  no('report', { status: 'waiting', task: 'Login' }, /waitingOn/);
  no('report', { status: 'sleeping' }, /status/);
});

test('handoff', () => {
  const h = { to: 'qa-web', issue: '#12', changed: 'login form', verify: 'sign in', doneWhen: 'QA signs off', artifact: 'https://preview.example/12', branch: 'web/12-login' };
  assert.equal(ok('handoff', h).issue, 12);
  ok('handoff', { ...h, issue: undefined, task: 'Login' });
  ok('handoff', { ...h, to: 'qa-web#2' });
  no('handoff', { ...h, issue: undefined }, /issue or a task/);
  no('handoff', { ...h, verify: '  ' }, /verify is required/);
  no('handoff', { ...h, to: 'web-dev' }, /never to yourself/);
  no('handoff', { ...h, to: 'ghost' }, /not a role on this team/);
  no('handoff', { ...h, artifact: 'ftp://x' }, /https:\/\/ URL or a path/);
  no('handoff', { ...h, changed: 'x'.repeat(4001) }, /at most 4000/);
});

test('bug', () => {
  const b = { to: 'release-manager', task: 'Save button', where: 'Settings', steps: 'tap save', expected: 'saved', actual: 'nothing', severity: 2, evidence: ['shots/save.png'] };
  ok('bug', b);
  no('bug', { ...b, evidence: [] }, /evidence needs at least one link/);
  no('bug', { ...b, severity: 5 }, /severity/);
});

test('signoff names the version it checked, in full; unverified is a list, empty means none (governance G1, G2)', () => {
  const s = { to: 'release-manager', issue: 9, testedOn: 'iPhone 15, Safari', walked: 'checkout', result: 'pass', evidence: ['shots/checkout.png'] };
  const sha = 'a'.repeat(40);
  assert.equal(ok('signoff', { ...s, version: sha }).versionKind, 'commit', 'a full commit id is a commit');
  assert.equal(ok('signoff', { ...s, version: 'b'.repeat(64), versionKind: 'commit' }).versionKind, 'commit');
  assert.deepEqual(ok('signoff', { ...s, version: 'rev 3', versionKind: 'revision', unverified: [] }).unverified, [], 'an empty list is "Unverified: none"');
  assert.equal(ok('signoff', { ...s, version: 'drf_12@2', versionKind: 'draft' }).versionKind, 'draft');
  assert.equal(ok('signoff', s).unverified, undefined, 'left out is "not stated", never none');
  no('signoff', { ...s, version: 'a1b2c3d' }, /versionKind/);
  no('signoff', { ...s, version: 'a1b2c3d', versionKind: 'commit' }, /full commit id/);
  no('signoff', { ...s, versionKind: 'draft' }, /needs the version/);
  no('signoff', { ...s, versionKind: 'branch', version: 'x' }, /versionKind/);
  no('signoff', { ...s, unverified: ['  '] }, /unverified\.0 is required/);
  no('signoff', { ...s, unverified: Array(21).fill('x') }, /at most 20/);
  assert.equal(ok('signoff', { ...s, checks: [{ call: 'call_fake', tool: 'Bash', summary: 'ran npm test · pass' }] }).checks, undefined, 'an agent can\'t supply its own checks');
  for (const [name, input] of [['report', { status: 'done' }], ['handoff', { to: 'qa-web', task: 'x', changed: 'x', verify: 'x', doneWhen: 'x' }], ['bug', { to: 'qa-web', task: 'x', where: 'x', steps: 'x', expected: 'x', actual: 'x', severity: 3, evidence: ['a.png'] }], ['blocked', { task: 'x', need: 'x', needFrom: 'qa-web', meanwhile: 'x' }]]) {
    assert.deepEqual(ok(name, { ...input, unverified: ['works on Android (only checked on iPhone)'] }).unverified, ['works on Android (only checked on iPhone)'], name);
  }
});

test('signoff: refused without evidence', () => {
  const s = { to: 'release-manager', issue: 3, testedOn: 'Chrome 140, macOS, abc123', walked: 'login', result: 'pass', evidence: ['shots/a.png', 'https://ci.example/run/1'] };
  ok('signoff', s);
  no('signoff', { ...s, evidence: [] }, /A SIGNOFF without evidence is refused/);
  no('signoff', { ...s, evidence: ['../outside.png'] }, /path in the workspace/);
  no('signoff', { ...s, evidence: Array(21).fill('a.png') }, /at most 20/);
});

test('blocked', () => {
  ok('blocked', { issue: 4, need: 'review of the schema', needFrom: 'release-manager', meanwhile: 'writing tests' });
  ok('blocked', { task: 'Model key', need: 'an API key', needFrom: 'owner', meanwhile: 'building against the stub', recommendation: 'a daily cap of 20 USD' });
  no('blocked', { task: 'Model key', need: 'an API key', needFrom: 'owner', meanwhile: 'stub' }, /needs your recommendation/);
  no('blocked', { task: 'x', need: 'y', needFrom: 'Bob Smith', meanwhile: 'z' }, /role slug or owner/);
});

test('ask_owner: the front door only', () => {
  const q = { question: 'Which plan?', options: [{ id: 'cheap', label: 'Cheap', consequence: 'slower' }, { id: 'fast', label: 'Fast', consequence: 'costs more' }], recommended: 'cheap' };
  const cos = { ...ctx, role: 'chief-of-staff', frontDoor: true };
  ok('ask_owner', q, cos);
  no('ask_owner', q, /No role asks the owner directly: send a BLOCKED to chief-of-staff/);
  no('ask_owner', { ...q, recommended: 'other' }, /one of the option ids/, cos);
  no('ask_owner', { ...q, options: [q.options[0]] }, /2 to 4 options/, cos);
  no('ask_owner', { ...q, question: 'x'.repeat(301) }, /at most 300/, cos);
});

test('request_approval', () => {
  ok('request_approval', { action: 'deploy-production', call: 'deploy.sh --production', why: 'QA signed off', risk: 'medium', links: ['https://github.com/o/r/pull/57'] });
  ok('request_approval', { action: 'something-new', call: 'x', why: 'y' }, ctx);
  no('request_approval', { action: 'accept', why: 'merge it' }, /call/);
});

test('meeting_reply and meeting_close', () => {
  ok('meeting_reply', { meeting: 'mtg_01abc', text: 'Built the cart.' });
  no('meeting_reply', { meeting: 'standup', text: 'x' }, /meeting id/);
  no('meeting_reply', { meeting: 'mtg_1', text: ' ' }, /required/);
  ok('meeting_close', { meeting: 'mtg_1', minutes: 'm', actionItems: [{ to: 'qa-web', task: 'Test it', doneWhen: 'signed off' }], decisions: [{ question: 'Ship?', options: [{ id: 'yes', label: 'Yes', consequence: 'It ships.' }, { id: 'no', label: 'No', consequence: 'It waits.' }], recommended: 'yes' }] });
  no('meeting_close', { meeting: 'mtg_1', minutes: 'm', actionItems: [{ to: 'web-dev', task: 't', doneWhen: 'd' }] }, /never to yourself/);
  no('meeting_close', { meeting: 'mtg_1', minutes: 'm', actionItems: [{ to: 'qa-web', task: 't' }] }, /doneWhen/);
  no('meeting_close', { meeting: 'mtg_1', minutes: 'm', decisions: [{ question: 'q', options: [{ id: 'a', label: 'A', consequence: 'c' }, { id: 'b', label: 'B', consequence: 'c' }], recommended: 'z' }] }, /recommended/);
});

test('ready_to_try: the front door only, and no link from the model', () => {
  const door = { frontDoor: true, role: 'chief-of-staff', roster: ['chief-of-staff', 'web-dev'] };
  ok('ready_to_try', { pr: 12, title: 'Checkout retries', summary: 'Payments retry once on a timeout.' }, door);
  no('ready_to_try', { pr: 12, title: 'x', summary: 'y' }, /Only the front door/);
  no('ready_to_try', { pr: 0, title: 'x', summary: 'y' }, /pr/, door);
  no('ready_to_try', { pr: 12, title: 'x'.repeat(121), summary: 'y' }, /title/, door);
  assert.equal(ok('ready_to_try', { pr: 12, title: 'x', summary: 'y', url: 'https://evil.example' }, door).url, undefined, 'a link from the model is dropped');
});

test('meeting_start: the front door only', () => {
  const door = { ...ctx, role: 'chief-of-staff', frontDoor: true };
  ok('meeting_start', { title: 'Checkout errors', attendees: ['web-dev', 'qa-web'] }, door);
  ok('meeting_start', { title: 'Checkout errors', attendees: ['web-dev'], cap: { amount: 50, currency: 'USD' } }, door);
  no('meeting_start', { title: 'x', attendees: ['web-dev'] }, /Only the front door/);
  no('meeting_start', { title: 'x', attendees: ['nobody'] }, /not a role/, door);
  no('meeting_start', { title: 'x', attendees: [] }, /at least one/, door);
});

test('ADR 0011: a teammate\'s prompt names it by its name and member id, says its role, and keeps the member id as its address', async () => {
  const { systemPrompt } = await import('../session.mjs');
  assert.match(systemPrompt({}, 'cto'), /^You are the cto on this team/, 'a team without members reads as before');
  const p = systemPrompt({}, 'support-agent-2', null, { type: 'support-agent', name: 'Maya' });
  assert.match(p, /^You are Maya \(support-agent-2\), a support-agent on this team\b/);
  assert.match(p, /Teammates address you as support-agent-2\./);
  assert.match(systemPrompt({}, 'x', null, { name: 'Bad\nName' }), /^You are Bad Name \(x\)/, 'a name is one line');
});
