// The M3 exit test's dry run (Pass A), in CI: the real control plane, the Studio and the runner with the scripted
// fake model (apps/runner/adapters/dryrun.mjs), against a stand-in remote on disk. No model, no key, no GitHub.
// The owner's side goes through the Studio's own API, as the page would: the daily cap with step-up, Start, a chat
// request, then the approval card answered with step-up. The run must end in a merge pinned to the approved head.
// A second request walks step 9b: a push after the approval makes the merge fail head-moved, and a new card asks again.
// Then a meeting (a written round, minutes in the chat) and its cap, and step 11, the daily cap.
//
//   npm ci --prefix apps/server && npm ci --prefix apps/runner && node --test tests/e2e/m3-dry-run.e2e.mjs
//   M3_DRY_RUN_RUNNER=docker uses the runner image (docker build -f apps/runner/Dockerfile -t agent-team-runner .;
//   M3_DRY_RUN_IMAGE names another tag). M3_DRY_RUN_DEBUG=1 prints the step log, the pull requests and the cards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { KIT } from '../../bin/agent-team.mjs';
import { up, hooks, waitFor } from '../../tools/dry-run/m3.mjs';

const deps = existsSync(join(KIT, 'apps/server/node_modules/@electric-sql/pglite')) && existsSync(join(KIT, 'apps/runner/node_modules/ws'));
if (process.env.CI && !deps) throw new Error('CI is set but npm ci --prefix apps/server and apps/runner were not run');
const skip = !deps && 'run npm ci --prefix apps/server and npm ci --prefix apps/runner first';
const RUNNER = process.env.M3_DRY_RUN_RUNNER ?? 'process';
const IMAGE = process.env.M3_DRY_RUN_IMAGE ?? 'agent-team-runner';

let h, hk, cookie;
const logs = [];

/** The Studio's API, with the cookie its link gives, as the page calls it. */
async function studio(method, path, body) {
  const res = await fetch(`${h.studio}${path}`, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json', origin: h.studio }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.error ?? JSON.stringify(data)}`);
  return data;
}
const stepUp = () => studio('POST', '/v1/team/step-up', { secret: h.secret });
/** The cards in the chat as they stand now: the newest version of each, from card.created and card.updated. */
const cards = async () => {
  const page = await studio('GET', '/v1/team/chat');
  const latest = new Map();
  for (const e of page.items ?? []) if (e.data?.card?.id) { const c = e.data.card; if (!latest.has(c.id) || (latest.get(c.id).version ?? 0) <= (c.version ?? 0)) latest.set(c.id, c); }
  return [...latest.values()];
};
/** The open approval card, once there is one other than `seen`. */
const openApproval = (seen = new Set()) => waitFor(async () => (await cards()).find((c) => c.kind === 'approval' && c.state === 'open' && !seen.has(c.id)), 60_000);
const answer = async (c, option = 'approve') => {
  await stepUp();
  return studio('POST', `/v1/team/cards/${encodeURIComponent(c.id)}`, { kind: c.kind, subject: c.subject, option, version: c.version, key: `e2e-${c.id}-${option}` });
};
const proposal = (pred) => waitFor(() => Object.values(hk.proposals()).find(pred), 60_000);

before(async () => {
  if (skip) return;
  h = await up({ port: 0, studioPort: 0, runner: RUNNER, image: IMAGE, log: (l) => logs.push(l) });
  hk = hooks(h.dir);
  const res = await fetch(h.link, { redirect: 'manual' });
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  assert.ok(cookie, 'the Studio link gives a cookie');
});
after(async () => {
  if (process.env.M3_DRY_RUN_DEBUG && h) console.log(JSON.stringify({ log: hk.log(), proposals: hk.proposals(), chat: await cards().catch((e) => e.message), events: await h.events().catch((e) => e.message) }, null, 1));
  await h?.down();
});

test('a chat request ends in a pull request, an approval card with step-up, and a merge pinned to the approved head', { skip, timeout: 180_000 }, async () => {
  // Step 2: the daily cap, which raising needs step-up for. Then Start (step 3).
  await stepUp();
  await studio('POST', '/v1/team/budget', { perDay: 500, perRun: 300, key: 'e2e-cap' });
  await studio('POST', '/v1/team/run/start', { key: 'e2e-start' });
  // Step 4: the owner's request.
  await studio('POST', '/v1/team/chat', { text: 'Add a page that says hello to new visitors', clientId: 'e2e-ask-1' });

  // Steps 5 and 6: the builder changes its file, the runner pushes and opens the PR, QA waits for its SIGNOFF.
  const opened = await proposal((p) => p.state === 'open' && p.branch.startsWith('team/web-dev/'));
  assert.equal(Object.keys(hk.proposals()).length, 1, 'only the builder, which changed something, has a pull request');
  await waitFor(() => hk.log().some((l) => l.step === 'qa:waiting-for-signoff'), 60_000);
  hk.signoff({ evidence: ['qa/dry-run.log'], walked: 'the M3 exit test, step 6' });

  // Step 7: the chief of staff's decision card, answered with the other option; it says back what was chosen.
  const decision = await waitFor(async () => (await cards()).find((x) => x.kind === 'decision' && x.state === 'open'), 60_000);
  assert.deepEqual(decision.options.map((o) => o.id), ['home', 'new-page']);
  await studio('POST', `/v1/team/cards/${encodeURIComponent(decision.id)}`, { kind: decision.kind, subject: decision.subject, option: 'new-page', version: decision.version, key: `e2e-${decision.id}` });
  await waitFor(() => hk.log().some((l) => l.step === 'chief-of-staff:answered' && l.answer === 'new-page'), 60_000);

  // Step 8: the approval card names the PR and its head; approved with step-up.
  const c = await openApproval();
  const head = execFileSync('git', ['-C', h.bare, 'rev-parse', `refs/heads/${opened.branch}`], { encoding: 'utf8' }).trim();
  assert.equal(c.data.pr, opened.ref, 'the approval card names the pull request');
  assert.equal(c.data.headSha, head, 'and its head commit');
  await answer(c);

  // Step 9: merged by the runner, pinned to that head; the base has the change.
  const merged = await proposal((p) => p.ref === opened.ref && p.state === 'merged');
  assert.equal(merged.mergedHead, head);
  const main = execFileSync('git', ['-C', h.bare, 'show', 'main:app/request.md'], { encoding: 'utf8' });
  assert.match(main, /hello to new visitors/);
  await waitFor(() => hk.log().some((l) => l.step === 'chief-of-staff:reported'), 60_000);
  console.log(JSON.stringify({ pr: merged.ref, headSha: merged.mergedHead, result: merged.result }));
});

test('step 9b: a push after the approval stops the merge (head-moved); a new card names the new head, and only that merges', { skip, timeout: 180_000 }, async () => {
  const seen = new Set((await cards()).map((c) => c.id));
  const before = new Set(Object.keys(hk.proposals()));
  hk.hold();
  await studio('POST', '/v1/team/chat', { text: 'Now say goodbye too', clientId: 'e2e-ask-2' });
  const opened = await proposal((p) => p.state === 'open' && !before.has(String(p.ref)));
  await waitFor(() => hk.log().filter((l) => l.step === 'qa:waiting-for-signoff').length === 2, 60_000);
  hk.signoff({ evidence: ['qa/dry-run-2.log'] });
  const first = await openApproval(seen);
  seen.add(first.id);
  assert.equal(first.data.pr, opened.ref);
  await answer(first);
  // The approved merge is held; someone pushes to the pull request; then it goes ahead and must not land.
  await waitFor(() => existsSync(join(h.control, 'hold-merge')) && hk.proposals()[opened.ref].state === 'open', 10_000);
  const moved = hk.moveHead();
  assert.notEqual(moved.head, first.data.headSha);
  hk.release();
  const again = await openApproval(seen);
  assert.equal(again.data.pr, opened.ref, 'the new card is for the same pull request');
  assert.equal(again.data.headSha, moved.head, 'and names the moved head');
  assert.match(again.body ?? '', /did not push/, 'and says the new head has commits the session did not push');
  assert.equal(hk.proposals()[opened.ref].state, 'open', 'nothing merged on the old approval');
  await answer(again);
  const merged = await proposal((p) => p.ref === opened.ref && p.state === 'merged');
  assert.equal(merged.mergedHead, moved.head);
  console.log(JSON.stringify({ pr: merged.ref, headSha: merged.mergedHead, result: merged.result }));
});

test('meetings: a written round ends with the minutes in the chat; a turn that blows the cap closes it capped', { skip, timeout: 120_000 }, async () => {
  const m = await hk.meeting('standup');
  assert.deepEqual(m.attendees, ['qa-web', 'web-dev'], 'resolved by the Studio, the facilitator left out');
  await waitFor(async () => (await hk.meetingNow(m.id)).state === 'closed', 60_000);
  const done = await hk.meetingNow(m.id);
  assert.equal(done.outcome, 'completed');
  assert.deepEqual(done.replies.map((r) => r.role), ['qa-web', 'web-dev']);
  const page = await studio('GET', '/v1/team/chat');
  const minutes = (page.items ?? []).find((e) => e.type === 'chat.message' && e.data?.meeting === m.id);
  assert.ok(minutes, 'the minutes are in the chat');
  assert.match(minutes.data.text, /qa-web: qa-web: on track/);
  assert.equal(execFileSync('git', ['-C', h.bare, 'log', '--oneline', '--all', '--grep', 'inutes'], { encoding: 'utf8' }).trim(), '', 'minutes are never committed');

  // The cap: the first attendee's turn costs $1, the cap is $0.50; the rest is skipped and the minutes are partial.
  hk.meetingSpend(1);
  const c = await hk.meeting('standup');
  await waitFor(async () => (await hk.meetingNow(c.id)).state === 'closed', 60_000);
  const capped = await hk.meetingNow(c.id);
  assert.deepEqual([capped.outcome, capped.capped, capped.spent >= capped.cap], ['capped', true, true]);
  assert.deepEqual(capped.skipped.map((x) => [x.role, x.reason]), [['qa-web', 'capped'], ['web-dev', 'capped']]);
  assert.ok(hk.log().some((l) => l.step === 'meeting:closed' && l.meeting === c.id && l.capped), 'the facilitator wrote partial minutes');
  const run = await studio('GET', '/v1/team/run');
  assert.equal(run.run?.state, 'running', 'the meeting\'s cap stops the meeting, not the run');
});

test('step 11: a turn that takes the day past the cap pauses the run and puts a budget card in the chat', { skip, timeout: 120_000 }, async () => {
  hk.spend(6);
  await studio('POST', '/v1/team/chat', { text: 'One more thing', clientId: 'e2e-ask-3' });
  const run = await waitFor(async () => { const r = await studio('GET', '/v1/team/run'); return r.run?.state === 'paused' && r; }, 60_000);
  assert.equal(run.run.state, 'paused');
  const budget = await waitFor(async () => (await cards()).find((c) => c.kind === 'budget' && c.state === 'open'), 30_000);
  assert.ok(budget, 'a budget card');
});
