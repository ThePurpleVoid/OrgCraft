// The runner end to end with the stub model, over a real WebSocket and HTTP to a stand-in control plane, and real
// git: the proofs docs/product/m3-design.md asks of the AI engineer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkEvent } from '../../../packages/events/index.mjs';
import { startRunner } from '../runner.mjs';
import { stubAdapter } from '../adapters/stub.mjs';
import { fakeControlPlane } from './fake-control-plane.mjs';
import { brief, noFailedTurns, origin, sh } from './helpers.mjs';

const OWNER = '  Add a line to the docs saying who to ask about releases. 🚀\n';

test('a chief-of-staff session sends a HANDOFF, which wakes a second role, which sends a SIGNOFF; every event has the run and session ids', async () => {
  const { bare, root } = origin();
  const cp = await fakeControlPlane({
    sessionDefaults: (role) => ({ repo: { url: bare, ref: 'main' }, areas: role === 'docs-keeper' ? ['docs/'] : [], prompt: { brief: brief('routine') }, roster: ['chief-of-staff', 'docs-keeper'] }),
  });
  const seen = { chief: [], docs: [] };
  const adapter = stubAdapter({
    'chief-of-staff': async (t) => {
      seen.chief.push(t.prompt);
      if (t.turn === 1) {
        await t.call('report', { status: 'working', task: 'Release contact line', issue: 7 });
        const bad = await t.call('handoff', { to: 'docs-keeper', issue: 7 });
        assert.equal(bad.isError, true, 'a HANDOFF without its fields is refused locally');
        const ok = await t.call('handoff', { to: 'docs-keeper', issue: 7, task: 'Release contact line', branch: 'docs/7-release-contact', changed: 'nothing yet', verify: 'read docs/releases.md', doneWhen: 'the line is there', artifact: 'docs/releases.md' });
        assert.equal(ok.isError, undefined, ok.text);
        assert.match(ok.text, /"event":"ev_/);
        await t.say('Handed to the docs keeper; I will tell you when it is signed off.');
        return {};
      }
      await t.call('report', { status: 'done', task: 'Release contact line', issue: 7 });
      await t.say('Done: the line is on branch docs/7-release-contact, signed off with evidence.');
      return {};
    },
    'docs-keeper': async (t) => {
      seen.docs.push(t.prompt);
      assert.match(t.model, /sonnet/, 'the routine tier picks the routine model');
      mkdirSync(join(t.cwd, 'docs'), { recursive: true });
      const own = await t.use('Write', { file_path: 'docs/releases.md' }, () => writeFileSync(join(t.cwd, 'docs', 'releases.md'), 'Ask the release manager.\n'));
      assert.ok(own.ok, 'a write inside the owned area is allowed');
      const other = await t.use('Edit', { file_path: join(t.cwd, 'apps/server/server.mjs') });
      assert.match(other.refused, /not in this role's owned areas/);
      const noEvidence = await t.call('signoff', { to: 'chief-of-staff', issue: 7, testedOn: 'node 22, linux, HEAD', walked: 'read docs/releases.md', result: 'pass', evidence: [] });
      assert.equal(noEvidence.isError, true);
      await t.say('This text is not for the chat: only the front door speaks there.');
      const ok = await t.call('signoff', { to: 'chief-of-staff', issue: 7, testedOn: 'node 22, linux, HEAD', walked: 'read docs/releases.md', result: 'pass', evidence: ['logs/docs-7.txt'] });
      assert.equal(ok.isError, undefined, ok.text);
      return {};
    },
  });
  const runner = startRunner({ server: cp.url, key: cp.key, root, adapter });
  try {
    await runner.ready;
    cp.start({
      role: 'chief-of-staff', run: 'run_1', repo: { url: bare, ref: 'main' }, prompt: { brief: brief('standard', 'owner'), memory: 'Identity: chief of staff.' },
      roster: ['chief-of-staff', 'docs-keeper'],
      wake: { id: 'ev_owner_1', type: 'chat.message', actor: { kind: 'person', id: 'owner' }, data: { from: 'owner', text: OWNER } },
    });
    await cp.until(() => cp.events.filter((e) => e.type === 'chat.message').length === 2);

    // The owner's words reached the chief of staff verbatim, every line quoted.
    assert.ok(seen.chief[0].includes(OWNER.split('\n').map((l) => `> ${l}`).join('\n')));
    // The HANDOFF woke the second role with its fields; the SIGNOFF woke the chief of staff again.
    assert.match(seen.docs[0], /^Resume from roles\/docs-keeper\.md/);
    assert.match(seen.docs[0], /HANDOFF from chief-of-staff/);
    assert.match(seen.docs[0], /doneWhen: the line is there/);
    assert.match(seen.chief[1], /SIGNOFF from docs-keeper/);
    assert.match(seen.chief[1], /logs\/docs-7.txt/);

    // Role messages went through the tool endpoint as their own role, and the server minted them.
    assert.deepEqual(cp.toolCalls.map((c) => `${c.as.role}:${c.tool}`), ['chief-of-staff:report', 'chief-of-staff:handoff', 'docs-keeper:signoff', 'chief-of-staff:report']);
    assert.ok(cp.toolCalls.every((c) => c.idempotencyKey));
    const types = cp.events.map((e) => `${e.actor.id}:${e.type}`);
    for (const t of ['chief-of-staff:session.started', 'chief-of-staff:message.handoff', 'docs-keeper:session.started', 'docs-keeper:message.signoff', 'chief-of-staff:usage.recorded', 'chief-of-staff:chat.message']) assert.ok(types.includes(t), `${t} in ${types.join(', ')}`);
    assert.equal(cp.events.filter((e) => e.type === 'message.signoff').length, 1, 'the refused SIGNOFF sent nothing');
    assert.ok(!types.includes('docs-keeper:chat.message'), 'only the front door posts to the chat');
    assert.deepEqual(cp.nacks, [], 'the runner sent only what its key may send');
    // Every event is a valid envelope with its run and its session.
    for (const e of cp.events) {
      assert.deepEqual(checkEvent(e), []);
      assert.equal(e.run, 'run_1', `${e.type} carries the run`);
      assert.ok(e.actor.session?.startsWith('ses_'), `${e.type} carries the session`);
      assert.equal(e.teamVersion, 'abc1234');
    }
    const docs = cp.events.filter((e) => e.actor.id === 'docs-keeper');
    assert.equal(new Set(docs.map((e) => e.actor.session)).size, 1);
    assert.ok(cp.events.some((e) => e.type === 'session.tool' && e.actor.id === 'docs-keeper' && e.data.decision === 'refused' && e.data.rule === 'ownership'));
    noFailedTurns(cp);
  } finally {
    await runner.close();
    await cp.close();
  }
  // Stopping pushed the docs keeper's work to its branch on the origin.
  assert.equal(sh(bare, 'show', 'docs/7-release-contact:docs/releases.md'), 'Ask the release manager.');
});

test('the runner pauses a merge until approval.result, and refuses it on deny', async () => {
  const { bare, root } = origin();
  const answers = ['approved', 'denied', 'approved'];
  const cp = await fakeControlPlane({ decide: () => ({ decision: answers.shift(), by: 'owner', note: 'checked' }) });
  const order = [];
  const adapter = stubAdapter({
    'release-manager': async (t) => {
      order.push('asking');
      const merged = await t.use('Bash', { command: 'gh pr merge 12 --squash --match-head-commit 0123456789abcdef0123456789abcdef01234567' }, () => order.push('merged'));
      assert.ok(merged.ok);
      const again = await t.use('Bash', { command: 'gh pr merge 13 --squash --match-head-commit 0123456789abcdef0123456789abcdef01234567' }, () => order.push('merged 13'));
      assert.match(again.refused, /did not approve this \(denied\): checked/);
      const asked = await t.call('request_approval', { action: 'deploy-production', call: 'deploy.sh --production', why: 'the release is signed off' });
      assert.match(asked.text, /"decision":"approved"/);
      return {};
    },
  });
  const runner = startRunner({ server: cp.url, key: cp.key, root, adapter });
  try {
    await runner.ready;
    cp.start({ role: 'release-manager', run: 'run_2', repo: { url: bare } });
    await cp.until(() => cp.events.some((e) => e.type === 'session.idle'));
    assert.deepEqual(order, ['asking', 'merged'], 'the merge ran only after the approval, and the denied one never ran');
    assert.deepEqual(cp.approvals.map((a) => `${a.via}:${a.via === 'policy' ? a.approval.action : a.input.action}`), ['policy:accept', 'policy:accept', 'tool:deploy-production']);
    assert.equal(cp.approvals[0].approval.call, 'gh pr merge 12 --squash --match-head-commit 0123456789abcdef0123456789abcdef01234567');
    assert.deepEqual([cp.approvals[0].approval.pr, cp.approvals[0].approval.headSha], [12, '0123456789abcdef0123456789abcdef01234567'], 'D1: the approval names the PR and head');
    const decisions = cp.events.filter((e) => e.type === 'session.tool').map((e) => `${e.data.decision}:${e.data.rule}`);
    assert.deepEqual(decisions, ['needs-approval:accept', 'allowed:accept', 'needs-approval:accept', 'refused:accept']);
    noFailedTurns(cp);
  } finally {
    await runner.close();
    await cp.close();
  }
});

test('session.checkpoint pushes the branch and hands back the head and the memory file; session.stop finish-step lets the turn end', async () => {
  const { bare, root } = origin();
  const cp = await fakeControlPlane();
  let release;
  const adapter = stubAdapter({
    'backend-dev': async (t) => {
      const mem = /Your memory file is (\S+?):/.exec(t.systemPrompt)[1];
      assert.match(readFileSync(mem, 'utf8'), /Current task: cleanup/, 'the checkpoint memory came back');
      const w = await t.use('Write', { file_path: mem }, () => writeFileSync(mem, 'Identity: backend dev\nCurrent task: cleanup, half done\n'));
      assert.ok(w.ok, 'the memory file is writable although it is outside the worktree');
      writeFileSync(join(t.cwd, 'notes.txt'), 'half done\n');
      await new Promise((r) => (release = r));
      return {};
    },
  });
  const runner = startRunner({ server: cp.url, key: cp.key, root, adapter });
  try {
    await runner.ready;
    const f = cp.start({ role: 'backend-dev', run: 'run_3', repo: { url: bare }, worktree: 'api/9-cleanup', areas: ['notes.txt'], resume: true, checkpoint: { commit: null, memory: 'Identity: backend dev\nCurrent task: cleanup\n' } });
    await cp.until(() => release);
    const cpFrame = cp.send('session.checkpoint', { session: f.body.session, reason: 'pause' });
    cp.send('session.stop', { session: f.body.session, mode: 'finish-step', reason: 'owner' });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!cp.frames.some((x) => x.op === 'ack' && x.ref === cpFrame.id), 'the checkpoint waits for the turn boundary');
    release();
    await cp.until(() => cp.events.some((e) => e.type === 'session.ended'));
    const ack = cp.frames.find((x) => x.op === 'ack' && x.ref === cpFrame.id);
    assert.equal(ack.body.pushed, true);
    assert.equal(ack.body.commit, sh(bare, 'rev-parse', 'api/9-cleanup'));
    assert.match(ack.body.memory, /half done/);
    assert.equal(sh(bare, 'show', 'api/9-cleanup:notes.txt'), 'half done');
    assert.equal(cp.events.find((e) => e.type === 'session.ended').data.reason, 'owner');
    noFailedTurns(cp);
  } finally {
    await runner.close();
    await cp.close();
  }
});

test('the session token never appears in the agent\'s environment or prompt, and is renewed before it expires', async () => {
  const { bare, root } = origin();
  const cp = await fakeControlPlane({ tokenTtlMs: 2 * 60_000 + 1500 });
  let env, prompts = '';
  const adapter = stubAdapter({
    'web-dev': async (t) => {
      env = JSON.stringify(t.env); prompts += t.prompt + t.systemPrompt;
      if (t.turn === 2) { const r = await t.call('report', { status: 'working', task: 'Login' }); assert.equal(r.isError, undefined, r.text); }
      return {};
    },
  });
  const runner = startRunner({ server: cp.url, key: cp.key, root, adapter });
  try {
    await runner.ready;
    const f = cp.start({ role: 'web-dev', run: 'run_4', repo: { url: bare }, worktree: 'web/3-login' });
    await cp.until(() => cp.frames.some((x) => x.op === 'session.renew'), 5000);
    cp.send('session.message', { session: f.body.session, message: { id: 'ev_x', type: 'message.handoff', actor: { id: 'cto' }, data: { to: 'web-dev', task: 'Login' } } });
    cp.send('session.message', { session: f.body.session, message: { id: 'ev_x', type: 'message.handoff', actor: { id: 'cto' }, data: { to: 'web-dev', task: 'Login' } } });
    await cp.until(() => cp.toolCalls.length === 1);
    assert.notEqual(cp.toolCalls[0].as.session, undefined);
    for (const t of cp.tokens.keys()) { assert.ok(!env.includes(t), 'no token in the environment'); assert.ok(!prompts.includes(t), 'no token in a prompt'); }
    assert.ok(!/AGENT_TEAM_RUNNER_KEY|rk_test/.test(env + prompts), 'nor the runner key');
    await cp.until(() => cp.events.filter((e) => e.type === 'session.idle').length === 2);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(cp.events.filter((e) => e.type === 'session.idle').length, 2, 'a resent message wakes the session once');
    noFailedTurns(cp);
  } finally {
    await runner.close();
    await cp.close();
  }
});

test('the runner stops a session at remainingToday even when the server is unreachable', async () => {
  const { bare, root } = origin();
  const cp = await fakeControlPlane();
  let turns = 0;
  const adapter = stubAdapter({ 'qa-web': async (t) => { turns++; assert.ok(Math.abs(t.maxBudgetUsd - (turns === 1 ? 0.1 : 0.04)) < 1e-9, 'the SDK gets what is left as its own budget'); return { usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.06 } }; } });
  const runner = startRunner({ server: cp.url, key: cp.key, root, adapter });
  try {
    await runner.ready;
    const f = cp.start({ role: 'qa-web', run: 'run_5', repo: { url: bare }, caps: { remainingToday: 10, remainingRun: 500 } });
    await cp.until(() => cp.events.some((e) => e.type === 'session.idle'));
    cp.send('session.message', { session: f.body.session, message: 'walk the login screen again' });
    await cp.until(() => turns === 2);
    cp.drop(); // the control plane is gone while the second turn ends
    await runner.sessions.get(f.body.session).ended; // stopped locally, while offline
    await cp.until(() => cp.events.some((e) => e.type === 'session.ended'), 15_000);
    assert.equal(cp.events.find((e) => e.type === 'session.ended').data.reason, 'budget');
    const usage = cp.events.filter((e) => e.type === 'usage.recorded');
    assert.deepEqual(usage.map((e) => e.data.cost), [6, 6], 'whole minor units, exact for the session');
    noFailedTurns(cp);
  } finally {
    await runner.close();
    await cp.close();
  }
});

test('usage carries the fraction over and rounds up on the session\'s last report', async () => {
  const { bare, root } = origin();
  const cp = await fakeControlPlane();
  const adapter = stubAdapter({ '*': async () => ({ usage: { inputTokens: 5, outputTokens: 5, costUsd: 0.0123 } }) });
  const runner = startRunner({ server: cp.url, key: cp.key, root, adapter });
  try {
    await runner.ready;
    const f = cp.start({ role: 'ux-writer', run: 'run_6', repo: { url: bare } });
    for (let i = 2; i <= 3; i++) {
      await cp.until(() => cp.events.filter((e) => e.type === 'session.idle').length === i - 1);
      cp.send('session.message', { session: f.body.session, message: `turn ${i}` });
    }
    await cp.until(() => cp.events.filter((e) => e.type === 'session.idle').length === 3);
    cp.send('session.stop', { session: f.body.session, mode: 'finish-step', reason: 'owner' });
    await cp.until(() => cp.events.some((e) => e.type === 'session.ended'));
    const costs = cp.events.filter((e) => e.type === 'usage.recorded').map((e) => e.data.cost);
    assert.deepEqual(costs, [1, 1, 1, 1], '1.23 + 1.23 + 1.23 = 3.69 cents: 1, 1, 1, then 1 to round up at the end');
  } finally {
    await runner.close();
    await cp.close();
  }
});

test('a reconnect resumes the sessions in welcome and resends what was not acknowledged', async () => {
  const { bare, root } = origin();
  const cp = await fakeControlPlane();
  let go;
  const gate = new Promise((r) => (go = r));
  const woke = [];
  const adapter = stubAdapter({
    'qa-web': async (t) => { await gate; await t.call('report', { status: 'working', task: 'Walk login' }); return {}; },
    'qa-ios': async (t) => { woke.push(t.prompt); return {}; },
  });
  const runner = startRunner({ server: cp.url, key: cp.key, root, adapter });
  try {
    await runner.ready;
    cp.start({ role: 'qa-web', run: 'run_7', repo: { url: bare } });
    await cp.until(() => cp.events.some((e) => e.type === 'session.started'));
    // The control plane hands back a session to resume on the next welcome, then the link drops.
    cp.resumeOnWelcome.push(cp.body({ role: 'qa-ios', run: 'run_7', repo: { url: bare }, checkpoint: { memory: 'Current task: walk sign-up' }, wake: 'carry on' }));
    cp.drop();
    go();
    await cp.until(() => cp.events.some((e) => e.actor.id === 'qa-ios' && e.type === 'session.idle'), 15_000);
    await cp.until(() => cp.events.some((e) => e.type === 'message.handoff' || e.type === 'report.status'), 15_000);
    assert.ok(cp.frames.filter((f) => f.op === 'hello').length >= 2, 'hello again on reconnect');
    assert.ok(cp.frames.filter((f) => f.op === 'hello').at(-1).body.sessions.length >= 1, 'hello names the sessions still running');
    assert.match(woke[0], /^Resume from roles\/qa-ios\.md, then:\n\ncarry on/);
    assert.equal(cp.events.find((e) => e.actor.id === 'qa-ios' && e.type === 'session.started').data.reason, 'resumed');
    const ids = cp.events.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, 'each event stored once');
    noFailedTurns(cp);
  } finally {
    await runner.close();
    await cp.close();
  }
});

test('a stop ends a wait for approval: the turn finishes and the work is pushed', async () => {
  const { bare, root } = origin();
  const cp = await fakeControlPlane({ decide: () => new Promise(() => {}) }); // nobody answers
  let refused;
  const adapter = stubAdapter({
    'release-manager': async (t) => {
      writeFileSync(join(t.cwd, 'notes.txt'), 'ready\n');
      refused = await t.use('Bash', { command: 'gh pr merge 12 --squash --match-head-commit 0123456789abcdef0123456789abcdef01234567' });
      return {};
    },
  });
  const runner = startRunner({ server: cp.url, key: cp.key, root, adapter });
  try {
    await runner.ready;
    const f = cp.start({ role: 'release-manager', run: 'run_8', repo: { url: bare }, worktree: 'rel/8', areas: ['notes.txt'] });
    await cp.until(() => cp.approvals.length === 1);
    cp.send('session.stop', { session: f.body.session, mode: 'now', reason: 'owner' });
    await cp.until(() => cp.events.some((e) => e.type === 'session.ended'), 5000);
    assert.match(refused.refused, /\(stopped\)/);
    assert.equal(cp.events.find((e) => e.type === 'session.ended').data.pushed, true);
    assert.equal(sh(bare, 'show', 'rel/8:notes.txt'), 'ready');
  } finally {
    await runner.close();
    await cp.close();
  }
});

test('an approval decided while the link was down is asked for again after the reconnect', async () => {
  const { bare, root } = origin();
  let answer;
  const cp = await fakeControlPlane({ decide: () => new Promise((r) => (answer = r)) });
  let merged = false;
  const adapter = stubAdapter({ 'release-manager': async (t) => { const r = await t.use('Bash', { command: 'gh pr merge 12 --match-head-commit 0123456789abcdef0123456789abcdef01234567' }, () => (merged = true)); assert.ok(r.ok); return {}; } });
  const runner = startRunner({ server: cp.url, key: cp.key, root, adapter });
  try {
    await runner.ready;
    cp.start({ role: 'release-manager', run: 'run_9', repo: { url: bare } });
    await cp.until(() => answer);
    cp.drop();
    answer({ decision: 'approved', by: 'owner' }); // sent into a closed link: lost
    await cp.until(() => cp.resent.length === 1, 15_000);
    await cp.until(() => cp.events.some((e) => e.type === 'session.idle'), 5000);
    assert.equal(merged, true);
    assert.equal(cp.resent[0].approval.action, 'accept');
    noFailedTurns(cp);
  } finally {
    await runner.close();
    await cp.close();
  }
});

test('a HANDOFF is not sent while the branch holds a change outside the owned areas', async () => {
  const { bare, root } = origin();
  const cp = await fakeControlPlane();
  const results = [];
  const adapter = stubAdapter({
    'web-dev': async (t) => {
      mkdirSync(join(t.cwd, 'web'), { recursive: true });
      writeFileSync(join(t.cwd, 'web', 'page.txt'), 'mine\n');
      writeFileSync(join(t.cwd, 'server.txt'), 'from the shell\n');
      execFileSync('git', ['add', '-A'], { cwd: t.cwd, env: { PATH: process.env.PATH, HOME: t.env.HOME } });
      execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'x'], { cwd: t.cwd, env: { PATH: process.env.PATH, HOME: t.env.HOME } });
      results.push(await t.call('handoff', { to: 'qa-web', task: 'Page', changed: 'page', verify: 'look', doneWhen: 'signed off' }));
      return {};
    },
  });
  const runner = startRunner({ server: cp.url, key: cp.key, root, adapter });
  try {
    await runner.ready;
    cp.start({ role: 'web-dev', run: 'run_10', repo: { url: bare }, worktree: 'web/10', areas: ['web/'] });
    await cp.until(() => results.length === 1);
    assert.equal(results[0].isError, true);
    assert.match(results[0].text, /^Not sent: not pushed: the branch's commits change paths outside this role's owned areas \(server.txt\)/);
    assert.equal(cp.toolCalls.length, 0, 'nothing reached the control plane');
  } finally {
    await runner.close();
    await cp.close();
  }
});

test('a run.resumed wake resumes each role from its checkpoint, and a checkpoint that is not on the branch is said out loud', async () => {
  const { bare, root } = origin();
  // What a pause left: a pushed checkpoint on the role's branch.
  const seed = join(root, '..', 'seed');
  sh(seed, 'checkout', '--quiet', '-b', 'web/4-login');
  writeFileSync(join(seed, 'login.txt'), 'half a form\n');
  sh(seed, 'add', '-A'); sh(seed, 'commit', '--quiet', '-m', 'checkpoint (web-dev): pause'); sh(seed, 'push', '--quiet', bare, 'web/4-login');
  const commit = sh(bare, 'rev-parse', 'web/4-login');
  const prompts = {};
  const adapter = stubAdapter({
    'web-dev': async (t) => { prompts[t.env.AGENT_TEAM_SESSION] = t.prompt; return {}; },
  });
  const cp = await fakeControlPlane();
  const runner = startRunner({ server: cp.url, key: cp.key, root, adapter, log: (m) => process.env.DBG && console.error('LOG', m) });
  try {
    await runner.ready;
    const wake = (id) => ({ id, type: 'run.resumed', actor: { kind: 'system', id: 'budget' }, data: { reason: 'next-day', by: 'budget' } });
    const a = cp.start({ role: 'web-dev', run: 'run_9', repo: { url: bare }, worktree: 'web/4-login', areas: ['login.txt'], resume: true, checkpoint: { commit, memory: 'Current task: login form' }, wake: wake('evt_r1') });
    await cp.until(() => prompts[a.body.session] && cp.events.some((e) => e.type === 'session.started'));
    const started = cp.events.find((e) => e.type === 'session.started');
    assert.equal(started.data.reason, 'resumed');
    assert.deepEqual(started.data.checkpoint, { commit, found: true });
    assert.match(prompts[a.body.session], /^Resume from roles\/web-dev\.md\. The run was resumed \(next-day\) by budget after a pause\. Carry on from your last checkpoint/);
    cp.send('session.stop', { session: a.body.session, mode: 'finish-step', reason: 'owner' });
    await cp.until(() => cp.events.filter((e) => e.type === 'session.ended').length === 1);

    // A checkpoint the branch does not hold (the push never landed): the session starts from what is there, and says so.
    const lost = 'f'.repeat(40);
    const b = cp.start({ role: 'web-dev', run: 'run_9', repo: { url: bare }, worktree: 'web/4-login', areas: ['login.txt'], resume: true, checkpoint: { commit: lost }, wake: wake('evt_r2') });
    // Events arrive over their own connection, so wait for the event itself, not only the prompt.
    await cp.until(() => prompts[b.body.session] && cp.events.filter((e) => e.type === 'session.started').length === 2);
    const again = cp.events.filter((e) => e.type === 'session.started').at(-1);
    assert.deepEqual(again.data.checkpoint, { commit: lost, found: false });
    assert.match(prompts[b.body.session], new RegExp(`^Note: your last checkpoint \\(${lost}\\) is not on web/4-login; you are at ${commit}\\.`));
    for (const e of cp.events) assert.deepEqual(checkEvent(e).problems ?? [], [], JSON.stringify(e));
    noFailedTurns(cp);
  } finally {
    await runner.close();
    await cp.close();
  }
});

test('a meeting turn: the prompt has the agenda and the replies so far, meeting_reply goes to the server, and the turn\'s usage is tagged', async () => {
  const { bare, root } = origin();
  const cp = await fakeControlPlane();
  const prompts = [];
  const adapter = stubAdapter({ qa: async (t) => {
    prompts.push(t.prompt);
    const id = /\(meeting (mtg_[\w-]+)/.exec(t.prompt)?.[1];
    if (id && !/close this meeting/.test(t.prompt)) await t.call('meeting_reply', { meeting: id, text: 'Tested checkout; nothing blocks me.' });
    return { usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.02 } };
  } });
  const runner = startRunner({ server: cp.url, key: cp.key, root, adapter });
  try {
    await runner.ready;
    const turn = { specversion: '1.0', id: 'ev_turn_1', type: 'meeting.turn', version: 1, actor: { kind: 'system', id: 'control-plane' }, data: { meeting: 'mtg_01abc', definition: 'standup', title: 'Daily standup', agenda: 'What is next?', to: 'qa', turn: 2, of: 3, closing: false, capped: false, replies: [{ role: 'web-dev', text: 'Built the cart.' }] } };
    const f = cp.start({ role: 'qa', run: 'run_m', repo: { url: bare }, wake: turn });
    await cp.until(() => cp.events.some((e) => e.type === 'session.idle'));
    assert.match(prompts[0], /MEETING "Daily standup" \(meeting mtg_01abc\), turn 2 of 3/);
    assert.match(prompts[0], /Agenda: What is next\?/);
    assert.match(prompts[0], /web-dev, verbatim:\n {2}> Built the cart\./);
    const reply = cp.toolCalls.find((c) => c.tool === 'meeting_reply');
    assert.deepEqual(reply.input, { meeting: 'mtg_01abc', text: 'Tested checkout; nothing blocks me.' });
    // An ordinary message next: its usage is not the meeting's.
    cp.send('session.message', { session: f.body.session, message: 'carry on' });
    await cp.until(() => cp.events.filter((e) => e.type === 'session.idle').length === 2);
    const usage = cp.events.filter((e) => e.type === 'usage.recorded');
    assert.deepEqual(usage.map((e) => e.data.meeting ?? null), ['mtg_01abc', null]);
    // The closing turn reads as one.
    const { wakePrompt } = await import('../session.mjs');
    const closing = wakePrompt({ ...turn, data: { ...turn.data, to: 'chief-of-staff', closing: true, capped: true, skipped: [{ role: 'designer', reason: 'capped' }] } }, 'chief-of-staff');
    assert.match(closing, /close this meeting/);
    assert.match(closing, /cost cap/);
    assert.match(closing, /Skipped: designer \(capped\)/);
    assert.match(closing, /meeting_close with \{ meeting: "mtg_01abc", minutes \}/);
    noFailedTurns(cp);
  } finally {
    await runner.close();
    await cp.close();
  }
});
