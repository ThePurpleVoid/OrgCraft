// The chief-of-staff chat for the Studio: the conversation, the cards in it, today's cost and the run controls, all
// from the control plane (apps/server) through its public /v1/ API (docs/contracts/clients.md). Like the live board,
// this server calls the control plane, so the token never reaches the page.
//
// It needs AGENT_TEAM_SERVER, AGENT_TEAM_SERVER_TOKEN and AGENT_TEAM_SERVER_TEAM. Without them the chat says how to
// connect one: a chat with nobody behind it would only pretend.

class Upstream extends Error { constructor(status, body) { super(body?.error ?? body?.title ?? `the control plane answered HTTP ${status}`); this.status = status; this.body = body; } }

export function chatSource(env = process.env) {
  const server = env.AGENT_TEAM_SERVER?.replace(/\/+$/, '');
  if (!server || !env.AGENT_TEAM_SERVER_TOKEN || !env.AGENT_TEAM_SERVER_TEAM) return { connected: false };
  const team = env.AGENT_TEAM_SERVER_TEAM;
  const t = encodeURIComponent(team);
  const auth = { authorization: `Bearer ${env.AGENT_TEAM_SERVER_TOKEN}` };
  // A step-up token for approvals and stepUp options: it stays on this server, never in the page, lasts at most its
  // 5 minutes and is spent by the next answer, whatever its outcome. Only the Studio's own session can use it (server.mjs checks the cookie).
  let stepUp = null; // { token, expires }
  const stepUpHeader = () => (stepUp && Date.parse(stepUp.expires) > Date.now() + 5_000 ? { 'x-step-up': stepUp.token } : {});

  async function call(method, path, body, headers = {}) {
    const res = await fetch(`${server}/v1${path}`, {
      method,
      headers: { ...auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
    if (!res.ok) throw new Upstream(res.status, data);
    return data;
  }

  /** The newest run that has not stopped, or null. */
  async function currentRun() {
    const body = await call('GET', `/teams/${t}/runs`);
    const runs = Array.isArray(body) ? body : body?.runs ?? [];
    const open = runs.filter((r) => ['running', 'paused'].includes(r.state ?? r.status));
    return open.sort((a, b) => String(b.started ?? b.time ?? '').localeCompare(String(a.started ?? a.time ?? '')))[0] ?? null;
  }

  return {
    connected: true,
    team,
    where: `${server}/v1/teams/${t}`,
    Upstream,
    /** A page of the chat, newest last. `before` is the opaque cursor the control plane gave. */
    chat: ({ before } = {}) => call('GET', `/teams/${t}/chat${before ? `?before=${encodeURIComponent(before)}` : ''}`),
    /** The owner's words, verbatim. The client id makes a retry land once. */
    say: ({ text, clientId, replyTo }) => call('POST', `/teams/${t}/chat`, { text, clientId, ...(replyTo ? { replyTo } : {}) }, clientId ? { 'idempotency-key': clientId } : {}),
    /** Answers a card with the version the person saw. Approvals go to /approvals/{id}, every other card to /cards/{id}. */
    async answer({ card, kind, subject, option, version, key }) {
      const su = stepUpHeader();
      const headers = { ...(key ? { 'idempotency-key': key } : {}), ...su };
      // An approval card's answer goes to its approval: the id from its subject, else the card id.
      const approval = kind === 'approval' && (/^approval\/(.+)$/.exec(subject ?? '')?.[1] ?? card);
      try {
        const r = approval
          ? await call('POST', `/approvals/${encodeURIComponent(approval)}`, { decision: option === 'deny' ? 'denied' : option === 'approve' ? 'approved' : option, version }, headers)
          : await call('POST', `/cards/${encodeURIComponent(card)}`, { option, version }, headers);
        return r;
      } finally {
        // A step-up covers one answer, whatever came of it: the next approval asks again.
        if (su['x-step-up']) stepUp = null;
      }
    },
    /** This team's line from /me/summary (cost today against the cap, run state) and the run itself. */
    async run() {
      const [summary, run] = await Promise.all([call('GET', '/me/summary'), currentRun().catch(() => null)]);
      const line = (summary?.teams ?? []).find((x) => x.team === team) ?? null;
      return { summary: line, run: run && { id: run.id, state: run.state ?? run.status ?? line?.run ?? null } };
    },
    /** Proves a recent sign-in. Until OIDC (M4) the proof is the step-up secret the person types; it is passed on, not kept. */
    async stepUp(secret) {
      const r = await call('POST', '/auth/step-up', { secret });
      stepUp = { token: r.token, expires: r.expires ?? new Date(Date.now() + 5 * 60_000).toISOString() };
      return { ok: true, expires: stepUp.expires };
    },
    async control(action, key, runId) {
      if (!['pause', 'resume', 'stop'].includes(action)) throw new Upstream(400, { error: 'pause, resume or stop' });
      const run = typeof runId === 'string' && runId ? { id: runId } : await currentRun();
      if (!run) throw new Upstream(409, { error: 'no run is going' });
      return call('POST', `/runs/${encodeURIComponent(run.id)}/${action}`, {}, key ? { 'idempotency-key': key } : {});
    },
  };
}
