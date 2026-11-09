// The runner: one outbound link to the control plane, and the role sessions it was asked to run.
// docs/contracts/runner-protocol.md is the contract, and docs/product/m3-design.md section 4 the subset M3 builds:
// hello/welcome (with sessions to resume), session.start/message/stop/checkpoint, events, approval.wait/result,
// session.renew/token, ping/pong, ack/nack.
import { checkEvent, SPEC, VERSION } from '../../packages/events/index.mjs';
import { connect, ulid } from './link.mjs';
import { Session } from './session.mjs';
import { toolServer } from './toolserver.mjs';
import { startModelProxy } from './modelproxy.mjs';
import { sandboxPool } from './sandbox.mjs';

export const PROTOCOL = 'runner/1';
const RUNNER_VERSION = '0.1.0';
/** What the runner key may send as events (runner-protocol.md, "What each credential may send"). */
const MAY_EMIT = (type, frontDoor) => /^session\./.test(type) || type === 'usage.recorded' || type === 'report.heartbeat' || /^proposal\.(opened|updated|accepted|failed|previewed)$/.test(type) || (type === 'chat.message' && frontDoor);
const RENEW_BEFORE_MS = 2 * 60_000;

/**
 * Start a runner. `server` is the control plane's base URL, `key` the runner key, `root` the working folder for
 * clones, worktrees and memory files, `adapter` the runtime (agentSdkAdapter() or stubAdapter(...)).
 * Returns { sessions, link, ready, close() }; ready resolves with the first welcome.
 */
export function startRunner({ server, key, root, work = root, sandbox = null, proposals = null, previewDelays, adapter, id = 'runner', maxSessions = 8, tiers, rules, sessionEnv, modelProxy, log = () => {}, fetch, link: makeLink = connect }) {
  // The model key stays in this process; sessions reach the model through the loopback proxy (modelproxy.mjs).
  const proxy = modelProxy === undefined ? startModelProxy({ log }) : modelProxy;
  // The agent users (#28): one per live session from a pool, or one shared user for a runner of a single customer.
  const pool = sandboxPool(sandbox);
  let customer = null; // with one shared agent user: the only team this runner serves
  const sessions = new Map();
  const approvals = new Map(); // approval id -> { resolve, session, approval } or { early }
  let welcomed = false;
  const renewals = new Map(); // session id -> resolve of a pending session.renew
  let tenant = null;
  let readyResolve;
  const ready = new Promise((r) => (readyResolve = r));
  // Whether the control plane is there now (welcomed, and not disconnected since). The budget and every approval live
  // there, so while it is away no session starts a model turn or merges (resilience pass, #28).
  let up = false;
  let waiting = [];

  const link = makeLink({
    server, key, log,
    hello: () => ({ runner: id, version: RUNNER_VERSION, protocol: PROTOCOL, capabilities: { sandboxes: ['process'], runtimes: [adapter.runtime ?? 'agent-sdk'], maxSessions, slots: {} }, sessions: [...sessions.values()].filter((s) => s.state !== 'ended').map((s) => s.id) }),
  });

  /** Values that must never leave the runner in an event: the model key and the session's tool token. */
  const scrub = (s, event) => {
    const values = [process.env.ANTHROPIC_API_KEY, s.token, s.proxyToken].filter((v) => typeof v === 'string' && v.length >= 8);
    let json = JSON.stringify(event), hit = false;
    for (const v of values) if (json.includes(v)) { json = json.split(v).join('[redacted]'); hit = true; }
    const out = JSON.parse(json);
    if (hit) out.data.redacted = true;
    return out;
  };

  function emit(s, type, data, { via = 'hook', cause } = {}) {
    if (!MAY_EMIT(type, s.frontDoor)) { log(`not sent: the runner key may not send ${type}`); return Promise.resolve(); }
    const b = s.body;
    const event = {
      specversion: SPEC, id: ulid(), type, version: VERSION,
      source: `/tenants/${tenant}/teams/${b.team}`, tenant, team: b.team, time: new Date().toISOString(),
      actor: { kind: 'role', id: s.role, instance: b.instance ?? null, session: s.id, via },
      subject: `role/${s.role}`, run: b.run ?? null, teamVersion: b.teamVersion ?? null,
      data: Object.fromEntries(Object.entries(data ?? {}).filter(([, v]) => v !== undefined)),
      ...(typeof cause === 'string' ? { cause } : {}),
    };
    const clean = scrub(s, event);
    const problems = checkEvent(clean);
    if (problems.length) { log(`dropped a malformed ${type} event: ${problems.join('; ')}`); return Promise.resolve(); }
    link.send('events', { events: [clean] });
    return Promise.resolve();
  }

  /**
   * Wait for approval.result on an approval id; a result that arrived first is kept. Open waits are sent again
   * after every reconnect (approval.wait with the approval's id), so a result lost while the link was down is
   * asked for again rather than waited on forever.
   */
  function awaitApproval(approvalId, session, approval = { id: approvalId }) {
    const got = approvals.get(approvalId);
    if (got?.early) { approvals.delete(approvalId); return Promise.resolve(got.early); }
    return new Promise((resolve) => approvals.set(approvalId, { resolve, session, approval: { ...approval, id: approvalId } }));
  }

  /** The policy path: approval.wait, whose ack names the approval the control plane minted. */
  async function approve(s, req) {
    const ack = await link.send('approval.wait', { session: s.id, approval: { action: req.action, call: req.call, why: req.why, ...(req.pr ? { pr: req.pr, headSha: req.headSha, ...(req.repo ? { repo: req.repo } : {}) } : {}) } });
    if (ack.nack || !ack.approval) return { decision: 'denied', note: ack.nack ?? 'the control plane did not record the approval' };
    return awaitApproval(ack.approval, s.id, { action: req.action, call: req.call, why: req.why });
  }

  function renew(s) {
    return new Promise((resolve) => {
      renewals.set(s.id, resolve);
      link.send('session.renew', { session: s.id });
      setTimeout(() => { if (renewals.get(s.id) === resolve) { renewals.delete(s.id); resolve(null); } }, 30_000).unref?.();
    });
  }

  function setToken(s, token, expires) {
    s.token = token;
    s.tools.setToken(token);
    clearTimeout(s.renewTimer);
    const at = Date.parse(expires ?? '') - Date.now() - RENEW_BEFORE_MS;
    if (Number.isFinite(at)) { s.renewTimer = setTimeout(() => renew(s), Math.max(at, 1000)); s.renewTimer.unref?.(); }
  }

  function startSession(body) {
    if (!body?.session || !body.role || !body.team) return log('session.start needs session, role and team');
    const running = sessions.get(body.session);
    if (running && running.state !== 'ended') { if (body.wake) running.deliver(body.wake); return; } // a resend, or a wake for a live session
    if ([...sessions.values()].filter((s) => s.state !== 'ended').length >= Math.min(maxSessions, pool?.size ?? Infinity)) {
      emit({ id: body.session, role: body.role, body, frontDoor: false }, 'session.ended', { role: body.role, reason: 'capacity', detail: `this runner already runs ${Math.min(maxSessions, pool?.size ?? Infinity)} sessions` });
      return;
    }
    // One shared agent user means one customer: sessions of every team on it could read each other (review of #28, E).
    if (pool?.shared) {
      const who = `${tenant ?? ''}/${body.team}`;
      if (customer && customer !== who) {
        emit({ id: body.session, role: body.role, body, frontDoor: false }, 'session.ended', { role: body.role, reason: 'capacity', detail: 'this runner has one agent user and already serves another team; give it a pool of agent users (AGENT_TEAM_SANDBOX_UIDS) to serve more than one' });
        return;
      }
      customer = who;
    }
    let s;
    const tools = toolServer({ server, session: body.session, token: body.token, fetch, renew: () => renew(s) });
    s = new Session(body, { adapter, root, work, sandbox: pool, proposals, previewDelays, runnerKey: key, tiers, rules, sessionEnv, modelProxy: proxy, log, tools, emit, approve: (r) => approve(s, r), awaitApproval, online,
      // step.io (N1): sent before the event that names it; a control plane that does not keep step I/O refuses it, harmlessly.
      stepIo: (frame) => { Promise.resolve(link.send('step.io', frame)).catch(() => {}); } });
    s.tools = tools;
    setToken(s, body.token, body.tokenExpires);
    sessions.set(body.session, s);
    s.ended.then(() => {
      clearTimeout(s.renewTimer);
      for (const [k, a] of approvals) if (a.session === s.id) approvals.delete(k);
      setTimeout(() => sessions.get(body.session) === s && sessions.delete(body.session), 60_000).unref?.();
    });
    s.start();
  }

  link.on('close', () => { up = false; });

  /**
   * Resolves once the control plane is there: welcomed, and one request answered after that. Frames are in order,
   * so by then anything the welcome brought (a session.stop for a session it stopped meanwhile) has been handled.
   */
  async function online() {
    while (!up) await new Promise((r) => waiting.push(r));
    await link.send('events', { events: [] });
  }

  link.on('welcome', (w) => {
    up = true;
    for (const r of waiting.splice(0)) r();
    tenant = w.tenant ?? tenant ?? 'local';
    if (welcomed) for (const [, a] of approvals) if (a.resolve && sessions.get(a.session)?.state !== 'ended') link.send('approval.wait', { session: a.session, approval: a.approval, resend: true });
    welcomed = true;
    // Sessions to resume after a reconnect: ids this runner still runs are kept; full bodies are (re)started.
    for (const a of w.sessions ?? w.assignments ?? []) if (a && typeof a === 'object') startSession({ resume: true, ...a });
    readyResolve(w);
  });

  link.on('frame', async (f) => {
    const b = f.body ?? {};
    switch (f.op) {
      case 'session.start': return startSession(b);
      case 'session.message': {
        // Refused when the session is not here (this runner restarted): the control plane starts it again rather
        // than counting the message as delivered.
        const s = sessions.get(b.session);
        if (s?.deliver(b.message)) return f.reply({});
        log(`no running session ${b.session} for a message`);
        return f.refuse(`no session ${b.session} on this runner`, 'no-session');
      }
      case 'session.checkpoint': {
        const s = sessions.get(b.session);
        return f.reply(s ? await s.checkpoint(b.reason) : { problem: `no session ${b.session} on this runner` });
      }
      case 'session.stop': return sessions.get(b.session)?.stop(b.mode ?? 'finish-step', b.reason ?? 'stopped');
      case 'session.token': {
        const s = sessions.get(b.session);
        if (s) setToken(s, b.token, b.tokenExpires);
        const r = renewals.get(b.session);
        if (r) { renewals.delete(b.session); r(b.token); }
        return;
      }
      case 'approval.result': {
        const d = { decision: b.decision, by: b.by, note: b.note, ...(b.headSha ? { headSha: b.headSha } : {}) };
        const r = approvals.get(b.approval);
        if (r?.resolve) { approvals.delete(b.approval); r.resolve(d); } else approvals.set(b.approval, { early: d });
        return;
      }
      default: return log(`unknown op ${f.op}`);
    }
  });

  return {
    sessions, ready, link,
    async close({ mode = 'finish-step' } = {}) {
      await Promise.all([...sessions.values()].map((s) => s.stop(mode, 'runner-shutdown')));
      // Let the last events reach the control plane before the link goes.
      for (let i = 0; i < 50 && link.pending?.() > 0; i++) await new Promise((r) => setTimeout(r, 100));
      link.close();
      await proxy?.close();
    },
  };
}
