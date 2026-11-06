// Kit 0.11: meetings.json (definitions only; the runner holds them) and the shared model price table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT } from '../bin/agent-team.mjs';
import {
  applyMeetings, checkMeetings, compileLayer, diffTeams, importLayer, meetingAttendees, meetingEstimate, meetingWhen, renderMeetings,
  resolveSpec, validate, wakesOn,
} from '../packages/team-model/index.mjs';
import { loadKit, readLayer } from '../packages/team-model/node.mjs';
import { checkPrices, estimate, priceOf, tierModel } from '../packages/model-prices/index.mjs';
import { loadPrices } from '../packages/model-prices/node.mjs';

const kit = loadKit();
const prices = loadPrices();
const cli = join(KIT, 'bin/agent-team.mjs');
const clone = (x) => JSON.parse(JSON.stringify(x));

const STANDUP = {
  id: 'standup', title: 'Daily standup', when: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], at: '09:00' },
  attendees: { roles: ['web-dev', 'backend-dev'], lanes: [], rule: null }, facilitator: 'chief-of-staff',
  format: 'round', rounds: 1, agenda: '1. Done since last time\n2. Next\n3. Blocked on', ifBusy: 'next-pause',
  owner: { minutes: true, speaks: false }, capUsd: 1, skipIfQuiet: true,
};

function team(meetings) {
  const root = mkdtempSync(join(tmpdir(), 'meetings-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync(process.execPath, [cli, 'init', '--preset', 'engineering', '--project', 'Meet', '--timezone', 'Europe/Berlin', '--dir', root], { stdio: 'ignore' });
  if (meetings) writeFileSync(join(root, '.agent-team/meetings.json'), JSON.stringify(meetings, null, 2) + '\n');
  return root;
}

test('meetings.json round-trips through the model, and a team without it has no meetings key', () => {
  const root = team({ meetings: [STANDUP] });
  const files = readLayer(root);
  const spec = importLayer(files, kit);
  assert.deepEqual(spec.meetings.meetings[0], STANDUP);
  assert.equal(compileLayer(spec, kit)['meetings.json'], files['meetings.json']);
  const plain = importLayer(readLayer(team()), kit);
  assert.equal(plain.meetings, undefined);
  assert.equal(compileLayer(plain, kit)['meetings.json'], undefined);
});

test('sync adds a Meetings section and "- meeting" to the Wakes on of each role a meeting names', () => {
  const root = team({ meetings: [STANDUP, { ...STANDUP, id: 'cto-review', title: 'Lane review', when: { label: 'design' }, attendees: { lanes: ['cto'] }, facilitator: 'cto' }] });
  execFileSync(process.execPath, [cli, 'sync', '--dir', root], { stdio: 'ignore' });
  const instructions = readFileSync(join(root, 'docs/team/project-instructions.md'), 'utf8');
  assert.match(instructions, /## Meetings/);
  assert.match(instructions, /Times are in Europe\/Berlin/);
  assert.match(instructions, /\| Daily standup \| Mon to Fri 09:00 \| backend-dev, web-dev \| chief-of-staff \|/);
  assert.match(instructions, /\| Lane review \| when an item gets the label `design` \|/);
  for (const slug of ['web-dev', 'backend-dev', 'chief-of-staff', 'cto']) {
    const brief = readFileSync(join(root, `docs/team/roles/${slug}.md`), 'utf8');
    assert.equal(wakesOn(brief).triggers.filter((t) => t.type === 'meeting').length, 1, slug);
  }
  assert.doesNotMatch(readFileSync(join(root, 'docs/team/roles/cpo.md'), 'utf8').match(/## Wakes on[\s\S]*?\n## /)?.[0] ?? '', /- meeting/);
  assert.equal(spawnSync(process.execPath, [cli, 'check', '--dir', root]).status, 0);
  // The model resolves the same briefs as sync.
  const { roles } = resolveSpec(importLayer(readLayer(root), kit), kit);
  assert.match(roles.find((r) => r.slug === 'web-dev').md, /- meeting/);
});

test('a role that already wakes on meetings is not given a second line', () => {
  const roles = [{ slug: 'a', md: '# A\n\n**Reports to:** owner\n\n## Wakes on\n- meeting\n- handoff\n' }, { slug: 'b', md: '# B\n\n**Reports to:** a\n' }];
  const out = applyMeetings(roles, { meetings: [{ id: 'x', attendees: { roles: ['a', 'b'] } }] });
  assert.equal(out[0], roles[0]);
  assert.match(out[1].md, /## Wakes on\n- meeting\n/);
});

test('attendees: named roles, whole lanes without their dormant roles, the facilitator, and the dynamic rule', () => {
  const roles = [
    { slug: 'boss', md: '**Reports to:** owner' }, { slug: 'lead', md: '**Reports to:** boss' },
    { slug: 'dev', md: '**Reports to:** lead' }, { slug: 'sleepy', md: '**Reports to:** lead\n**Status:** dormant' },
    { slug: 'other', md: '**Reports to:** boss' },
  ];
  assert.deepEqual(meetingAttendees({ attendees: { lanes: ['lead'] }, facilitator: 'boss' }, roles), { roles: ['boss', 'dev', 'lead'], missing: [], dynamic: false });
  assert.deepEqual(meetingAttendees({ attendees: { roles: ['sleepy', 'ghost'], rule: 'worked-since-last' } }, roles), { roles: ['sleepy'], missing: ['ghost'], dynamic: true });
  assert.equal(meetingWhen({ days: ['tue', 'thu'], at: '14:00' }), 'Tue, Thu 14:00');
  assert.equal(meetingWhen({ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], at: '08:00' }), 'Daily 08:00');
  assert.equal(renderMeetings({ meetings: [] }, roles), '');
});

test('validate checks meetings: on the team, unique ids, valid times, the cap, clashes and small meetings', () => {
  const root = team();
  const spec = importLayer(readLayer(root), kit);
  spec.meetings = { meetings: [
    STANDUP,
    { ...STANDUP, title: 'Copy' },                                                        // same id
    { ...STANDUP, id: 'late', when: { days: ['mon', 'funday'], at: '25:00' } },           // bad day and time, clash on mon? no: 25:00
    { ...STANDUP, id: 'ghosts', attendees: { roles: ['web-dev', 'nobody'] }, facilitator: 'nobody-either', capUsd: 0, agenda: ' ' },
    { ...STANDUP, id: 'pricey', when: { days: ['fri'], at: '09:00' }, capUsd: 80, format: 'discussion', rounds: 9, ifBusy: 'shout' },
    { ...STANDUP, id: 'solo', when: { label: 'design' }, attendees: { roles: ['web-dev'] } },
  ] };
  const issues = validate(spec, kit, { dailyCapUsd: 50 }).filter((i) => i.where.startsWith('meetings'));
  const has = (level, where, re) => assert.ok(issues.some((i) => i.level === level && i.where === where && re.test(i.message)), `${level} ${where} ${re}\n${JSON.stringify(issues, null, 1)}`);
  has('error', 'meetings/standup', /used by two meetings/);
  has('error', 'meetings/late', /"funday" is not a day/);
  has('error', 'meetings/late', /"25:00" is not a time of day/);
  has('error', 'meetings/ghosts', /nobody is not on the team/);
  has('error', 'meetings/ghosts', /nobody-either is not on the team/);
  has('error', 'meetings/ghosts', /cap must be above zero/);
  has('error', 'meetings/ghosts', /no agenda/);
  has('error', 'meetings/pricey', /above the team's daily cap \(\$50\)/);
  has('error', 'meetings/pricey', /2 to 5 rounds/);
  has('error', 'meetings/pricey', /ifBusy "shout"/);
  has('warning', 'meetings/pricey', /same time as standup \(fri 09:00\), and both include backend-dev, chief-of-staff, web-dev/);
  has('warning', 'meetings/solo', /one attendee besides/);
  // Without a daily cap the cap is only checked for being above zero; team.json "budgets.dailyUsd" is the fallback.
  assert.ok(!validate(spec, kit).some((i) => /daily cap/.test(i.message)));
  spec.options.budgets = { dailyUsd: 50 };
  assert.ok(validate(spec, kit).some((i) => /daily cap/.test(i.message)));
  assert.deepEqual(checkMeetings({ meetings: 'no' }, []), [{ level: 'error', where: 'meetings', message: 'meetings.json must be { "meetings": [...] }' }]);
  assert.deepEqual(checkMeetings(undefined, []), []);
  // A clean team with a good meeting has no meeting issues, and diffTeams sees the meeting change.
  const good = clone(spec);
  good.meetings = { meetings: [STANDUP] };
  delete good.options.budgets;
  assert.deepEqual(validate(good, kit).filter((i) => i.where.startsWith('meetings')), []);
  const draft = clone(good);
  draft.meetings.meetings[0].when.at = '10:00';
  assert.ok(diffTeams(good, draft, kit).some((c) => c.kind === 'meeting'));
});

test('the price table is valid, the tiers match the runner today, and estimates carry the date', () => {
  assert.deepEqual(checkPrices(prices), []);
  assert.deepEqual(prices.tiers, { deep: 'claude-opus-5-5', standard: 'claude-opus-5-5', routine: 'claude-sonnet-5-5', light: 'claude-haiku-5-5' });
  assert.equal(tierModel('routine', prices), 'claude-sonnet-5-5');
  assert.equal(tierModel('routine', prices, { routine: 'claude-opus-5-5' }), 'claude-opus-5-5');
  assert.equal(tierModel('mystery', prices), 'claude-opus-5-5');
  assert.equal(priceOf('no-such-model', prices), null);
  assert.deepEqual(estimate({ tier: 'deep', inputTokens: 1e6, outputTokens: 1e6 }, prices), { usd: 24, model: 'claude-opus-5-5', asOf: prices.asOf });
  assert.equal(estimate({ model: 'unknown' }, prices).usd, null);
  assert.ok(checkPrices({ ...prices, asOf: 'soon', tiers: { ...prices.tiers, light: 'gone' } }).length === 2);
});

test('meeting estimate: each attendee once per round at its tier, the facilitator twice, per month for schedules', () => {
  const roles = [
    { slug: 'chief-of-staff', md: '**Model:** deep (high effort)' }, { slug: 'web-dev', md: '**Model:** standard' }, { slug: 'qa', md: '**Model:** light' },
  ];
  const m = { ...STANDUP, attendees: { roles: ['web-dev', 'qa'] } };
  const turn = { inputTokens: 1e6, outputTokens: 0 };
  // web-dev 4 + qa 0.1 + chief of staff 2 × 4 = 12.1
  assert.deepEqual(meetingEstimate(m, roles, prices, { turn }), { perMeetingUsd: 12.1, perMonthUsd: 262.17, asOf: prices.asOf, turns: 4 });
  const d = meetingEstimate({ ...m, format: 'discussion', rounds: 3, when: { label: 'x' } }, roles, prices, { turn });
  assert.deepEqual([d.perMeetingUsd, d.perMonthUsd, d.turns], [20.3, null, 8]);
});
