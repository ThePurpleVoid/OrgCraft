// A stand-in control plane for the runner's tests (docs/product/m3-design.md section 10): the M3 runner-protocol
// ops over a real WebSocket, the team tool endpoint with session tokens, and a minimal bus (a message wakes its
// target: session.start when it has no live session, session.message when it has one). The real bus, cards and
// approvals live in apps/server; this exists so the runner is tested on the wire.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';

const MAY_EMIT = (t) => /^session\./.test(t) || ['usage.recorded', 'report.heartbeat', 'chat.message'].includes(t) || /^proposal\.(opened|updated|accepted|failed|previewed)$/.test(t);
const TOOL_EVENT = { report: 'report.status', handoff: 'message.handoff', bug: 'message.bug', signoff: 'message.signoff', blocked: 'message.blocked' };

export async function fakeControlPlane({ secrets = {}, key = 'rk_test', tenant = 'acme', decide = () => ({ decision: 'approved', by: 'owner' }), sessionDefaults = () => ({}), tokenTtlMs = 15 * 60_000 } = {}) {
  const wss = new WebSocketServer({ noServer: true });
  const events = [], frames = [], approvals = [], toolCalls = [], nacks = [], resent = [];
  const live = new Map(); // role -> session id
  const tokens = new Map(); // token -> { session, role, run, instance }
  let sock = null, n = 0;
  const waiters = [];
  const id = (p = 'cp') => `${p}_${++n}_${randomBytes(3).toString('hex')}`;
  const send = (op, body, ref) => { const f = { op, id: id('f'), body, ...(ref ? { ref } : {}) }; sock?.send(JSON.stringify(f)); return f; };
  const check = () => { for (const w of [...waiters]) if (w.test()) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); } };
  const mint = (s) => { const t = `st_${randomBytes(12).toString('hex')}`; tokens.set(t, s); return { token: t, tokenExpires: new Date(Date.now() + tokenTtlMs).toISOString() }; };
  const sessionOf = {}; // session id -> { role, run, instance }

  const decided = new Map(); // approval id -> decision, so a resent approval.wait gets its answer again
  function decideLater(approvalId, req) {
    // Like apps/server since L6: the result echoes the hash the card was bound to (a test's decide may override it).
    setTimeout(() => Promise.resolve(decide(req)).then((d) => { const r = { ...(req?.callsHash ? { callsHash: req.callsHash } : {}), ...d }; decided.set(approvalId, r); send('approval.result', { approval: approvalId, ...r }); check(); }), 50).unref();
  }

  const http = createServer(async (req, res) => {
    const m = /^\/v1\/sessions\/([^/]+)\/tools\/([^/]+)$/.exec(req.url);
    if (!m || req.method !== 'POST') { res.writeHead(404); return res.end(); }
    const who = tokens.get((/^Bearer (.+)$/.exec(req.headers.authorization ?? '') ?? [])[1]);
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); check(); };
    if (!who || who.session !== decodeURIComponent(m[1])) return reply(401, { error: 'session token missing, expired or for another session' });
    let body = '';
    for await (const c of req) body += c;
    const input = JSON.parse(body || '{}');
    const tool = m[2];
    toolCalls.push({ tool, input, as: who, idempotencyKey: req.headers['idempotency-key'] });
    // The server checks again; one rule is enough to prove the runner relays a 422.
    if (tool === 'signoff' && !input.evidence?.length) return reply(422, { problems: ['evidence needs at least one link: a screenshot or a log'] });
    if (tool === 'request_approval') {
      // As apps/server (D1): an accept names the pull request and the full head commit.
      if (input.action === 'accept' && (!Number.isInteger(input.pr) || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(input.headSha ?? ''))) return reply(422, { problems: ['an accept approval needs pr and headSha, so the merge can only land on the commit that was approved'] });
      const a = id('apr');
      approvals.push({ approval: a, via: 'tool', input, as: who });
      decideLater(a, { action: input.action, call: input.call, pr: input.pr, headSha: input.headSha, ...(input.callsHash ? { calls: input.calls, callsHash: input.callsHash } : {}) });
      return reply(200, { approval: a, card: id('card') });
    }
    if (tool === 'ask_owner') return reply(200, { card: id('card') });
    // Meetings: the real sequencing is apps/server's; here a reply or a close is recorded and answered.
    if (tool === 'meeting_reply' || tool === 'meeting_close') return reply(200, { event: id('ev') });
    if (tool === 'ready_to_try') return reply(200, { card: id('card'), event: id('evt'), preview: null });
    if (tool === 'meeting_start') return reply(200, { meeting: id('mtg'), attendees: input.attendees, cap: 100, currency: 'USD' });
    // The event is minted here, with the actor from the token, never from the body.
    const event = {
      specversion: '1.0', id: id('ev'), type: TOOL_EVENT[tool], version: 1, source: `/tenants/${tenant}/teams/my-team`, tenant, team: 'my-team', time: new Date().toISOString(),
      actor: { kind: 'role', id: who.role, instance: who.instance ?? null, session: who.session, via: 'tool' }, subject: `role/${who.role}`, run: who.run, teamVersion: 'abc1234',
      data: { ...input, ...(tool === 'blocked' ? { to: input.to ?? input.needFrom } : {}) },
    };
    onEvent(event);
    return reply(200, { event: event.id });
  });

  http.on('upgrade', (req, socket, head) => {
    if (req.url !== '/v1/runners/connect' || req.headers.authorization !== `Bearer ${key}`) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    if (plane.away) { socket.destroy(); return; } // gone: nothing answers
    wss.handleUpgrade(req, socket, head, (ws) => {
      sock = ws;
      ws.on('message', (raw) => {
        const f = JSON.parse(String(raw));
        frames.push(f);
        if (f.op === 'hello') { send('welcome', { protocol: 'runner/1', heartbeat: 20, tenant, sessions: plane.resumeOnWelcome.splice(0) }); return; }
        if (f.op === 'ping') { send('pong', { t: f.body.t }, f.id); return; }
        if (f.op === 'ack' || f.op === 'pong') { check(); return; }
        if (f.op === 'events') {
          const bad = f.body.events.find((e) => !MAY_EMIT(e.type));
          if (bad) { nacks.push(bad); send('nack', { ref: f.id, problem: `a runner key may not send ${bad.type}` }, f.id); check(); return; }
          send('ack', {}, f.id);
          for (const e of f.body.events) onEvent(e);
        } else if (f.op === 'approval.wait' && f.body.approval?.id) {
          // A wait sent again after a reconnect: the same approval, answered again if it was decided meanwhile.
          resent.push(f.body);
          send('ack', { approval: f.body.approval.id }, f.id);
          if (decided.has(f.body.approval.id)) send('approval.result', { approval: f.body.approval.id, ...decided.get(f.body.approval.id) });
        } else if (f.op === 'approval.wait') {
          const a = id('apr');
          approvals.push({ approval: a, via: 'policy', ...f.body });
          send('ack', { approval: a, card: id('card') }, f.id);
          decideLater(a, f.body.approval);
        } else if (f.op === 'secret.get') {
          // Released only for names bound to the session (here: the `secrets` map), and every release is recorded.
          plane.secretGets.push(f.body);
          if (Object.hasOwn(secrets, f.body.name)) send('ack', { name: f.body.name, value: secrets[f.body.name] }, f.id);
          else send('nack', { ref: f.id, problem: `${f.body.name} is not bound to this session's role` }, f.id);
        } else if (f.op === 'spend.lease' && plane.lease) {
          // L24s: a test's lease rule; without one, the ack below carries no amount, as from a server without leases.
          plane.leaseAsks.push(f.body);
          const r = plane.lease(f.body);
          if (r?.nack) send('nack', { ref: f.id, problem: r.nack }, f.id); else send('ack', r, f.id);
        } else if (f.op === 'session.renew') {
          send('ack', {}, f.id);
          const s = sessionOf[f.body.session];
          send('session.token', { session: f.body.session, ...mint({ session: f.body.session, ...s }) });
        } else send('ack', {}, f.id);
        check();
      });
    });
  });

  function onEvent(e) {
    if (events.some((x) => x.id === e.id)) return; // idempotent by id
    events.push(e);
    if (e.type === 'session.ended' && live.get(e.actor.id) === e.actor.session) live.delete(e.actor.id);
    const to = e.type.startsWith('message.') ? String(e.data.to).split('#')[0] : null;
    if (to) {
      const s = live.get(to);
      if (s) send('session.message', { session: s, message: e, delivery: id('dl') });
      else plane.start({ role: to, run: e.run, wake: e, worktree: e.data.branch ? { branch: e.data.branch } : undefined, ...sessionDefaults(to, e) });
    }
  }

  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  const plane = {
    url: `http://127.0.0.1:${http.address().port}`,
    key, events, frames, approvals, toolCalls, nacks, tokens, resent, secretGets: [], leaseAsks: [], lease: null,
    /** Session bodies to hand back in the next welcome (a reconnect resumes them). */
    resumeOnWelcome: [],
    body(b) {
      const session = b.session ?? `ses_${b.role}_${randomBytes(3).toString('hex')}`;
      sessionOf[session] = { role: b.role, run: b.run, instance: b.instance };
      return { team: 'my-team', teamVersion: 'abc1234', ...b, session, ...mint({ session, role: b.role, run: b.run, instance: b.instance }) };
    },
    start(b) {
      const body = plane.body(b);
      live.set(body.role, body.session);
      return send('session.start', body);
    },
    send,
    drop() { sock?.terminate(); },
    /** While true, reconnects are not answered (the control plane is away). */
    away: false,
    /** Resolve when `test()` holds (checked after every frame and tool call), or fail after `ms`. */
    until(test, ms = 10_000) {
      if (test()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const w = { test, resolve };
        waiters.push(w);
        const t = setInterval(() => { if (test()) { clearInterval(t); if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); resolve(); } } }, 50);
        t.unref();
        setTimeout(() => { clearInterval(t); if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`timed out; events: ${events.map((e) => `${e.actor.id}:${e.type}`).join(', ')}`)); } }, ms).unref();
      });
    },
    close() { for (const c of wss.clients) c.terminate(); return new Promise((r) => http.close(r)); },
  };
  return plane;
}
