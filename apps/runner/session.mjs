// One role session: the supervisor around an agent runtime (the Claude Agent SDK, or the stub model in tests).
// It owns the session's working copy, its queue of messages, its budget and its liveness. The runner key's events
// (session.*, usage.recorded, report.heartbeat, and the front door's chat.message) go out through `emit`; role
// messages go through the team tool server, so the control plane mints them (docs/product/m3-design.md).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decide, DEFAULT_RULES } from './policy.mjs';
import { checkTool, TOOLS } from './tools.mjs';
import { redactSecrets } from './secrets.mjs';
import { safeRead, safeWrite, sharedDir } from './sandbox.mjs';
import { checkpoint as saveWork, onBranch, outOfArea, prepare, release } from './worktree.mjs';

/** Model per brief tier. The runner's config or the session.start body can override it. */
export const DEFAULT_TIERS = { deep: 'claude-opus-5-5', standard: 'claude-opus-5-5', routine: 'claude-sonnet-5-5', light: 'claude-haiku-5-5' };
/**
 * The only parts of the runner's environment a session inherits (security review R1). Not HOME: each session
 * gets its own empty one. Not the model key: the session gets the loopback proxy's address and a token of its
 * own. Never the runner key or the session token. A runner can add names with `sessionEnv` (a proxy, say).
 */
const PASS_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'SHELL', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'];
/** Tools whose message the next role acts on: the branch is checkpointed and pushed first, so it is there. */
const PUSH_FIRST = new Set(['handoff', 'bug', 'signoff', 'blocked']);
// How many times one accept asks again because the pull request's head moved after an approval.
const MAX_REASKS = 3;
const HEARTBEAT_MS = 5 * 60_000;
const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80);

/** The system prompt: the role's brief, the protocols, the project's instructions and the role's memory file. */
export function systemPrompt(p = {}, role, memoryPath) {
  const part = (title, body) => (body ? `\n\n# ${title}\n\n${String(body).trim()}` : '');
  return [
    `You are the ${role} on this team, running as a session of the team's runner.`,
    'Use the team tools (report, handoff, bug, signoff, blocked, ask_owner, request_approval) for every report and message the protocols describe; they are checked and delivered for you.',
    'Writes outside your owned areas are refused, and the steps the protocols keep for the owner (such as merging) wait for a person\'s approval.',
    memoryPath ? `Your memory file is ${memoryPath}: rewrite it (Identity, Current task, Open items, Decisions, Lessons) at the end of every task.` : '',
  ].filter(Boolean).join(' ') + part('Your brief', p.brief) + part('Team protocols', p.protocols) + part('Project instructions', p.instructions) + part(`Your memory file (roles/${role}.md)`, p.memory);
}

/** A message that wakes a session, as the prompt of its next turn. The owner's words travel verbatim and quoted. */
export function wakePrompt(m, role, { resume = false } = {}) {
  const lead = `Resume from roles/${role}.md`;
  if (!m) return `${lead}.`;
  if (typeof m === 'string') return resume ? `${lead}, then:\n\n${m}` : m;
  const from = m.actor?.id ?? m.data?.from ?? 'someone';
  const d = m.data ?? {};
  if (m.type === 'chat.message') {
    const quoted = String(d.text ?? '').split('\n').map((l) => `> ${l}`).join('\n');
    return `${resume ? `${lead}, then handle this.\n\n` : ''}Message from ${from}, verbatim:\n\n${quoted}`;
  }
  if (m.type === 'run.resumed') {
    // The run was paused (by the owner or the daily cap) and is going again: carry on where the checkpoint left off.
    return `${lead}. The run was resumed${d.reason ? ` (${d.reason})` : ''}${d.by ? ` by ${d.by}` : ''} after a pause. Carry on from your last checkpoint: your branch and your memory file are as you left them.`;
  }
  if (m.type === 'decision.answered') {
    return `${lead}. The owner answered your question${d.question ? ` "${d.question}"` : ''}: ${JSON.stringify(d.answer ?? null)}${d.note ? `, with this note, verbatim:\n\n> ${d.note}` : '.'}`;
  }
  const kind = (/^message\.(\w+)$/.exec(m.type ?? '') ?? [])[1];
  const head = kind ? `${kind.toUpperCase()} from ${from}` : `${m.type ?? 'Message'} from ${from}`;
  const fields = Object.entries(d).filter(([k, v]) => k !== 'source' && v !== null && v !== '' && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
  return `${lead}, then handle this.\n\n${head}${m.id ? ` (event ${m.id})` : ''}:\n\n${fields}`;
}

export class Session {
  /**
   * `body` is the session.start body (docs/contracts/runner-protocol.md, with the M3 fields). `deps`:
   *   adapter            the runtime: { turn(opts) } (adapters/agent-sdk.mjs or adapters/stub.mjs)
   *   emit(session, type, data, { via })   an event the runner key may send
   *   tools              the team tool server for this session: { call(tool, input) } (toolserver.mjs)
   *   approve(request)   the policy path: approval.wait, resolves { decision, by, note }
   *   awaitApproval(id)  resolves the approval.result for an approval the server minted
   *   root               the runner's working folder; tiers, rules, log optional
   */
  constructor(body, deps) {
    this.body = body;
    this.id = body.session;
    this.role = body.role;
    this.deps = deps;
    this.queue = [];
    this.state = 'starting'; // starting, working, idle, stopping, ended
    this.spent = 0; // minor units, with fractions, since the session started
    this.reported = 0; // whole minor units already reported in usage.recorded
    this.resume = body.runtimeSession ?? null; // the runtime's own conversation id, kept between turns
    this.woken = new Set();
    this.ended = new Promise((r) => (this._ended = r));
    this.stopped = new Promise((r) => (this._stopped = r));
    this.work = deps.work ?? deps.root; // what the agent may reach; deps.root stays the runner's own
    this.memoryPath = join(this.work, 'memory', safe(this.id), `${safe(this.role)}.md`);
    const brief = body.prompt?.brief ?? '';
    this.frontDoor = body.frontDoor ?? /\*\*Reports to:\*\*\s*owner\b/i.test(brief);
  }

  get model() {
    const tiers = { ...DEFAULT_TIERS, ...this.deps.tiers };
    const tier = (/\*\*Model:\*\*\s*([a-z]+)/i.exec(this.body.prompt?.brief ?? '') ?? [])[1]?.toLowerCase();
    return this.body.model ?? tiers[this.body.tier ?? tier] ?? tiers.standard;
  }

  /** What this session may still spend, in minor units: the smaller of today's and the run's remaining budget. */
  get remaining() {
    const c = this.body.caps ?? {};
    const caps = [c.remainingToday, c.remainingRun].filter((v) => Number.isFinite(v));
    return caps.length ? Math.min(...caps) - this.spent : null;
  }

  async start() {
    const b = this.body;
    try {
      const sb = this.deps.sandbox ?? null;
      this.copy = await prepare({ root: this.deps.root, work: this.work, repo: b.repo, worktree: b.worktree, session: this.id, sandbox: sb });
      sharedDir(join(this.work, 'memory'), sb);
      sharedDir(dirname(this.memoryPath), sb, { leaf: true });
      // A home of its own, with no credentials in it: nothing of the runner user's (ssh, gh, git, the runner key).
      this.home = join(this.work, 'homes', safe(this.id));
      sharedDir(join(this.work, 'homes'), sb);
      sharedDir(this.home, sb, { leaf: true });
      sharedDir(join(this.home, 'tmp'), sb, { leaf: true });
      // The agent runs git in a clone the runner owns; this lets it, and names its commits.
      safeWrite(join(this.home, '.gitconfig'), `[safe]\n\tdirectory = ${this.copy.cwd}\n[user]\n\tname = ${this.role}\n\temail = ${this.role}@agent-team.invalid\n`, { base: this.work });
      const memory = b.checkpoint?.memory ?? b.prompt?.memory;
      if (memory !== undefined && memory !== null) safeWrite(this.memoryPath, String(memory), { base: this.work });
      else if (!existsSync(this.memoryPath)) safeWrite(this.memoryPath, '', { base: this.work });
      const pass = [...PASS_ENV, ...(this.deps.sessionEnv ?? [])];
      this.env = { ...Object.fromEntries(pass.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])), HOME: this.home, TMPDIR: join(this.home, 'tmp'), AGENT_TEAM_ROLE: this.role, AGENT_TEAM_RUN: b.run ?? '', AGENT_TEAM_SESSION: this.id };
      if (this.deps.modelProxy && process.env.ANTHROPIC_API_KEY) {
        await this.deps.modelProxy.ready;
        const p = this.deps.modelProxy.register(this.id);
        this.proxyToken = p.token;
        Object.assign(this.env, { ANTHROPIC_BASE_URL: p.baseUrl, ANTHROPIC_API_KEY: p.token });
      }
      if (b.instance) this.env.AGENT_TEAM_INSTANCE = String(b.instance);
    } catch (e) {
      await this.emit('session.ended', { role: this.role, reason: 'failed', detail: `could not start: ${e.message}` });
      this.state = 'ended';
      this._ended();
      return;
    }
    // A resume names the commit its last checkpoint pushed. It must be on the branch this runner checked out;
    // if it is not (the push never landed, or the branch was rewritten), the session still starts, from what is
    // there, and says so: to the control plane in session.started, and to the role in its first prompt.
    let checkpoint = null;
    if (b.resume && b.checkpoint?.commit) {
      checkpoint = { commit: String(b.checkpoint.commit), found: await onBranch(this.copy.cwd, b.checkpoint.commit) };
      if (!checkpoint.found) this.resumeNote = `Note: your last checkpoint (${checkpoint.commit}) is not on ${this.copy.branch ?? 'this checkout'}; you are at ${this.copy.head}. Check what is missing before you go on.`;
    }
    await this.emit('session.started', { role: this.role, instance: b.instance ?? null, worktree: this.copy.cwd, branch: this.copy.branch, model: { provider: 'anthropic', name: this.model }, reason: b.resume ? 'resumed' : 'started', ...(checkpoint ? { checkpoint } : {}) });
    this.state = 'idle';
    this.deliver(b.wake ?? null, { first: true });
  }

  /** A waking message (session.start's wake, or session.message): handled at the next turn boundary, once per event id. */
  deliver(message, { first = false } = {}) {
    if (this.state === 'ended' || this.state === 'stopping') return false;
    const id = message && typeof message === 'object' ? message.id : null;
    if (id) { if (this.woken.has(id)) return true; this.woken.add(id); }
    this.queue.push({ message, resume: !first || Boolean(this.body.resume) });
    this.pump();
    return true;
  }

  async pump() {
    if (this.running || this.state === 'stopping' || this.state === 'ended' || !this.copy) return;
    this.running = true;
    try {
      do {
        if (this.queue.length && this.state !== 'stopping') await this.turn(this.queue.shift());
        while (this.afterTurn.length) await this.afterTurn.shift()();
      } while (this.queue.length && this.state !== 'stopping');
    } finally {
      this.running = false;
    }
    if (this.state === 'stopping') return this.finish(this.stopReason);
  }

  afterTurn = [];

  /** The first prompt after a resume carries what the resume found; later ones do not. */
  takeNote(prompt) {
    const n = this.resumeNote;
    this.resumeNote = null;
    return n ? `${n}\n\n${prompt}` : prompt;
  }

  async turn({ message, resume }) {
    const remaining = this.remaining;
    if (remaining !== null && remaining <= 0) { this.stopReason = 'budget'; this.state = 'stopping'; return; }
    this.state = 'working';
    this.abort = new AbortController();
    const task = message?.data?.task;
    await this.emit('report.heartbeat', { status: 'working', task, source: 'hook' }, { via: 'hook' });
    const beat = setInterval(() => this.emit('report.heartbeat', { status: 'working', source: 'hook' }, { via: 'hook' }), HEARTBEAT_MS);
    beat.unref?.();
    const limit = Number(this.body.caps?.time) > 0 ? setTimeout(() => this.abort.abort('time'), this.body.caps.time * 1000) : null;
    let out;
    try {
      out = await this.deps.adapter.turn({
        session: this.id, role: this.role, model: this.model, cwd: this.copy.cwd, env: this.env, resume: this.resume, sandbox: this.deps.sandbox ?? null,
        systemPrompt: systemPrompt(this.body.prompt, this.role, this.memoryPath), prompt: this.takeNote(wakePrompt(message, this.role, { resume })),
        signal: this.abort.signal, maxBudgetUsd: remaining === null ? undefined : remaining / 100, mcp: this.body.tools?.mcp ?? {},
        tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, shape: t.shape })),
        callTool: (name, args) => this.callTool(name, args),
        preToolUse: (tool, input) => this.preToolUse(tool, input),
        onText: (text) => this.say(text),
      });
    } catch (e) {
      out = { stop: this.abort.signal.aborted ? 'aborted' : 'error', error: e.message, usage: {} };
    } finally {
      clearInterval(beat);
      if (limit) clearTimeout(limit);
    }
    if (out.resume) this.resume = out.resume;
    await this.record(out.usage ?? {});
    const timedOut = this.abort.signal.reason === 'time';
    if (this.remaining !== null && this.remaining <= 0 && this.state !== 'stopping') { this.stopReason = 'budget'; this.state = 'stopping'; }
    if (this.state === 'stopping') return;
    this.state = 'idle';
    await this.emit('report.heartbeat', { status: 'idle', source: 'hook' }, { via: 'hook' });
    await this.emit('session.idle', { role: this.role, reason: timedOut ? 'time' : out.stop ?? 'end', ...(out.error ? { detail: `the turn failed: ${out.error}` } : {}) });
  }

  /** usage.recorded in whole minor units, the fraction carried to the next report (rounded up on the last one). */
  async record(u, { last = false } = {}) {
    const cost = (u.costUsd ?? 0) * 100;
    this.spent += cost;
    const whole = last ? Math.ceil(this.spent - 1e-9) : Math.floor(this.spent + 1e-9);
    const due = whole - this.reported;
    if (!(u.inputTokens || u.outputTokens || due > 0)) return;
    this.reported += Math.max(due, 0);
    await this.emit('usage.recorded', { inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0, cost: Math.max(due, 0), currency: 'USD', model: this.model });
  }

  /** The front door's completed text blocks are its replies in the chat; other roles' text stays in their session. */
  async say(text) {
    if (!this.frontDoor || !String(text ?? '').trim()) return;
    await this.emit('chat.message', { from: this.role, text: String(text) }, { via: 'tool' });
  }

  async callTool(name, args) {
    const local = checkTool(name, args, { role: this.role, frontDoor: this.frontDoor, frontDoorRole: this.body.frontDoorRole, roster: this.body.roster });
    if (local.problems) {
      await this.emit('session.tool', { tool: `team.${name}`, decision: 'refused', rule: 'tools/1', detail: local.problems.join(' ') });
      return { text: `Refused. ${local.problems.join('. ')}. Fix the call and try again.`, isError: true };
    }
    if (PUSH_FIRST.has(name) && this.copy?.branch) {
      const saved = await this.save(`before ${name}`);
      if (saved.refused) {
        await this.emit('session.tool', { tool: `team.${name}`, decision: 'refused', rule: saved.refused.rule, detail: saved.error });
        return { text: `Not sent: ${saved.error}. Fix that first (undo or move the change, or send a request to the path's owner), then send the ${name} again.`, isError: true };
      }
    }
    if (name === 'request_approval' && local.input.action === 'accept' && this.proposes()) return this.acceptFlow(local.input);
    let r;
    try {
      r = await this.deps.tools.call(name, local.input);
    } catch (e) {
      return { text: `The control plane could not be reached (${e.message}). Nothing was sent; try again shortly.`, isError: true };
    }
    if (r.problems) return { text: `Refused by the control plane. ${r.problems.join('. ')}. Fix the call and try again.`, isError: true };
    if (name === 'request_approval') {
      this.state = 'waiting';
      const d = await this.untilStopped(this.deps.awaitApproval(r.result.approval, this.id));
      if (this.state === 'waiting') this.state = 'working';
      const ok = d.decision === 'approved';
      return { text: JSON.stringify({ approval: r.result.approval, decision: d.decision, note: d.note }) + (ok ? ' Approved: go ahead with exactly that call.' : ' Not approved: do not take the step.'), isError: !ok };
    }
    return { text: JSON.stringify(r.result) };
  }

  /** A wait for a person that ends when the session is stopped, so a stop never hangs on an open approval. */
  untilStopped(wait) {
    return Promise.race([wait, this.stopped.then(() => ({ decision: 'stopped', note: 'the session was stopped' }))]);
  }

  async preToolUse(tool, input) {
    // Writes made from the shell skip the file tools' check, so nothing that touches paths outside the owned areas
    // leaves the working copy: a push or a pull request is refused until those changes are undone.
    if (tool === 'Bash' && /\bgit\s+push\b|\bgh\s+pr\s+create\b/.test(String(input.command ?? '')) && this.copy?.branch) {
      const o = await outOfArea({ cwd: this.copy.cwd, areas: this.body.areas ?? [] }).catch((e) => ({ committed: [`(the branch could not be checked: ${e.message})`], uncommitted: [] }));
      if (o.committed.length) {
        await this.emit('session.tool', { tool, target: String(input.command).slice(0, 500), decision: 'refused', rule: 'ownership', detail: o.committed.slice(0, 20).join(', ') });
        return { allow: false, reason: `This branch's commits change paths outside your owned areas (${o.committed.slice(0, 10).join(', ')}). Undo those changes, and send a request to the owner of each path instead.` };
      }
    }
    const d = decide({ tool, input, cwd: this.copy.cwd, repo: this.body.repo?.url ?? null, areas: this.body.areas ?? [], also: [this.memoryPath], rules: this.deps.rules ?? DEFAULT_RULES });
    if (d.rule === 'team-tool') return { allow: true };
    // Where the runner proposes, it alone merges (D2): the session asks for the merge, it does not run one.
    if ((d.rule === 'accept' || (d.decision === 'refused' && d.rule === 'match-head-commit')) && this.proposes()) {
      await this.emit('session.tool', { tool, target: String(d.target ?? '').slice(0, 500), decision: 'refused', rule: 'runner-merges' });
      return { allow: false, reason: `The runner merges this branch's pull request${this.proposal ? ` (#${this.proposal.ref})` : ''} itself, after the owner approves its head. Call request_approval with action "accept" instead; do not merge or push to the base yourself.` };
    }
    if (d.decision === 'needs-approval') {
      await this.emit('session.tool', { tool, target: String(d.target).slice(0, 500), decision: 'needs-approval', rule: d.rule });
      this.state = 'waiting';
      const call = tool === 'Bash' ? String(input.command ?? '') : JSON.stringify({ tool, input });
      const a = await this.untilStopped(this.deps.approve({ action: d.rule, call, why: `The team policy keeps this for a person: it ${d.why}.`, ...(d.pr ? { pr: d.pr, headSha: d.headSha, ...(d.repo ? { repo: d.repo } : {}) } : {}) }));
      if (this.state === 'waiting') this.state = 'working';
      const ok = a.decision === 'approved';
      await this.emit('session.tool', { tool, target: String(d.target).slice(0, 500), decision: ok ? 'allowed' : 'refused', rule: d.rule, by: a.by });
      return ok ? { allow: true } : { allow: false, reason: `A person did not approve this (${a.decision})${a.note ? `: ${a.note}` : ''}. Do not try it another way; tell whoever asked for it.` };
    }
    await this.emit('session.tool', { tool, target: String(d.target ?? '').slice(0, 500), decision: d.decision, rule: d.rule ?? undefined });
    return d.decision === 'allowed' ? { allow: true } : { allow: false, reason: d.why };
  }

  /** session.checkpoint: at the next turn boundary, push the branch and hand back the head and the memory file. */
  checkpoint(reason = 'checkpoint') {
    const go = async () => {
      const r = await this.save(reason);
      // The memory file goes to the control plane, so it gets the same secret scan; hits are redacted.
      let raw = '', unreadable = null;
      try { raw = safeRead(this.memoryPath, { base: this.work }); } catch (e) { if (e.code !== 'ENOENT') unreadable = `the memory file was not sent: ${e.code === 'ELOOP' ? 'it is a link' : e.message}`; }
      const memory = redactSecrets(raw, this.secretValues());
      await this.emit('session.idle', { role: this.role, reason: 'checkpoint', branch: this.copy.branch, commit: r.commit, pushed: r.pushed, ...(r.error ? { detail: r.error } : {}), ...(memory !== raw ? { redacted: true } : {}) });
      const problem = [r.error, unreadable].filter(Boolean).join('; ');
      return { commit: r.commit, pushed: r.pushed, memory, ...(problem ? { problem } : {}) };
    };
    if (!this.copy) return Promise.resolve({ pushed: false, problem: 'the session has no working copy' });
    if (!this.running) return go();
    return new Promise((resolve) => this.afterTurn.push(async () => resolve(await go())));
  }

  /** Values that must never leave in a push or the memory file: the session's proxy token, the model key, the runner key. */
  secretValues() {
    // The merger app's key and its installation tokens are the runner's too: none may leave in a commit or a memory.
    return [this.proxyToken, process.env.ANTHROPIC_API_KEY, this.deps.runnerKey, ...(this.deps.proposals?.secrets?.() ?? [])].filter(Boolean);
  }

  /** Checkpoint and push through the runner's checks (ownership, symlinks, secrets); never throws. */
  async save(reason) {
    const r = await saveWork({ cwd: this.copy.cwd, branch: this.copy.branch, base: this.copy.base, role: this.role, reason, areas: this.body.areas ?? [], secrets: this.secretValues() })
      .catch((e) => ({ pushed: false, error: e.message }));
    if (r.pushed && this.proposes()) await this.propose(r.commit).catch((e) => { r.proposalError = e.message; this.deps.log?.(`proposal for ${this.copy.branch}: ${e.message}`); });
    return r;
  }

  /** Whether this session's branch gets a proposal: a branch of its own, and a runner with a proposal connector. */
  proposes() {
    return Boolean(this.deps.proposals && this.copy?.branch && this.copy.branch !== this.copy.base && this.body.repo?.url);
  }

  /**
   * Open the proposal (the pull request) after the first checkpoint push, or note that its head moved. The runner
   * does this with its own credential (D2); the session never holds one that can open or merge.
   */
  async propose(commit) {
    if (this.proposal?.headSha === commit) return this.proposal;
    const b = this.body;
    const p = await this.deps.proposals.open({ repo: b.repo.url, branch: this.copy.branch, base: this.copy.base, title: `${this.role}: ${this.copy.branch}`, body: `Opened by the runner for ${this.role}${b.run ? ` (run ${b.run})` : ''}. It is merged only after the owner approves this exact head.` });
    const first = !this.proposal && !p.existed;
    this.proposal = { connector: p.connector, ref: p.ref, url: p.url, headSha: commit };
    await this.emit(first ? 'proposal.opened' : 'proposal.updated', { connector: p.connector, ref: p.ref, url: p.url, branch: this.copy.branch, headSha: commit });
    return this.proposal;
  }

  /**
   * request_approval with action accept, when the runner proposes: checkpoint first, so the approval names the
   * pushed head and its pull request, then (on approved) merge pinned to that head (runner-protocol, Proposals).
   */
  async acceptFlow(input) {
    const saved = await this.save('before accept');
    if (!saved.pushed || !this.proposal) {
      return { text: `Not asked: the branch could not be pushed and proposed (${saved.error ?? saved.proposalError ?? 'no proposal'}). Fix that first, then ask again.`, isError: true };
    }
    let headSha = saved.commit;
    // A head that moves after the approval (someone pushed to the pull request) is not merged: the runner asks
    // again, naming the new head, and only that answer can merge it. The server only supersedes the old approval.
    for (let round = 1; ; round++) {
      let r;
      try {
        r = await this.deps.tools.call('request_approval', { ...input, pr: this.proposal.ref, headSha, ...(round > 1 ? { why: `${input.why} (asked again: the pull request's head moved to ${headSha} after the last approval)` } : {}) });
      } catch (e) {
        return { text: `The control plane could not be reached (${e.message}). Nothing was sent; try again shortly.`, isError: true };
      }
      if (r.problems) return { text: `Refused by the control plane. ${r.problems.join('. ')}. Fix the call and try again.`, isError: true };
      const approval = r.result.approval;
      this.state = 'waiting';
      const d = await this.untilStopped(this.deps.awaitApproval(approval, this.id));
      if (this.state === 'waiting') this.state = 'working';
      if (d.decision !== 'approved') return { text: JSON.stringify({ approval, decision: d.decision, note: d.note }) + ' Not approved: it was not merged.', isError: true };
      // The merge lands only on the head the person approved, whatever the branch holds now.
      const approved = d.headSha ?? headSha;
      const base = { connector: this.proposal.connector, ref: this.proposal.ref, url: this.proposal.url, branch: this.copy.branch, headSha: approved, approval };
      try {
        const m = await this.deps.proposals.accept({ repo: this.body.repo.url, ref: this.proposal.ref, branch: this.copy.branch, base: this.copy.base, headSha: approved, approval });
        await this.emit('proposal.accepted', { ...base, result: m.result });
        return { text: JSON.stringify({ approval, decision: 'approved', merged: m.result, pr: this.proposal.ref, headSha: approved }) + ' Approved and merged by the runner.' };
      } catch (e) {
        const reason = ['head-moved', 'checks', 'conflict'].includes(e.reason) ? e.reason : 'checks';
        await this.emit('proposal.failed', { ...base, reason, detail: String(e.message).slice(0, 500) });
        if (reason === 'head-moved' && round < MAX_REASKS) {
          const now = await this.deps.proposals.head({ repo: this.body.repo.url, ref: this.proposal.ref }).catch(() => null);
          if (now && now !== approved) {
            headSha = now;
            this.proposal.headSha = now;
            await this.emit('proposal.updated', { connector: this.proposal.connector, ref: this.proposal.ref, url: this.proposal.url, branch: this.copy.branch, headSha: now });
            continue;
          }
        }
        const next = reason === 'head-moved' ? ' The pull request kept moving after approval; ask again once it is settled.' : reason === 'conflict' ? ' Bring the base into the branch and resolve the conflict, then ask again.' : ' A required check has not passed: fix it, then ask again.';
        return { text: JSON.stringify({ approval, decision: 'approved', merged: false, reason }) + ` Approved, but not merged (${reason}).${next}`, isError: true };
      }
    }
  }


  /** session.stop: `now` aborts the turn in flight, `finish-step` lets it end first. Either way the work is pushed. */
  stop(mode = 'finish-step', reason = 'stopped') {
    if (this.state === 'ended' || this.finished) return this.ended;
    this.stopReason = reason;
    this.state = 'stopping';
    this._stopped();
    if (mode === 'now') this.abort?.abort('stop');
    if (!this.running) this.finish(reason);
    return this.ended;
  }

  async finish(reason) {
    if (this.finished) return this.ended;
    this.finished = true;
    let saved = {};
    if (this.copy) saved = await this.save(reason);
    if (this.copy) release(this.copy.cwd, this.id);
    this.deps.modelProxy?.unregister(this.id);
    await this.record({}, { last: true });
    await this.emit('report.heartbeat', { status: 'idle', detail: reason === 'budget' ? 'stopped: the session reached its budget' : `stopped (${reason})`, source: 'hook' }, { via: 'hook' });
    await this.emit('session.ended', { role: this.role, reason, branch: this.copy?.branch, commit: saved.commit, pushed: saved.pushed ?? false, ...(saved.error ? { detail: saved.error } : {}) });
    this.state = 'ended';
    this._ended();
    return this.ended;
  }

  emit(type, data, opts = {}) {
    return this.deps.emit(this, type, data, opts);
  }
}
