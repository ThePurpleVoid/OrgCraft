// tools/1 checks (docs/contracts/team-tools.md): one passing and one refused input per tool, including a SIGNOFF
// with no evidence and an ask_owner from a role that is not the front door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTool, TOOLS } from '../tools.mjs';

const ctx = { role: 'web-dev', frontDoor: false, frontDoorRole: 'chief-of-staff', roster: ['web-dev', 'qa-web', 'chief-of-staff', 'release-manager'] };
const ok = (name, input, c = ctx) => { const r = checkTool(name, input, c); assert.equal(r.problems, undefined, `${name}: ${r.problems}`); return r.input; };
const no = (name, input, re, c = ctx) => { const r = checkTool(name, input, c); assert.ok(r.problems, `${name} should be refused`); assert.match(r.problems.join(' | '), re); };

test('the seven tools of tools/1, and nothing else', () => {
  assert.deepEqual(Object.keys(TOOLS).sort(), ['ask_owner', 'blocked', 'bug', 'handoff', 'report', 'request_approval', 'signoff']);
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
