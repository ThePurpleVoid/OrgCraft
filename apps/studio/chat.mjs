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
    const open = runs.filter((r) => (r.state ?? r.status) !== 'stopped');
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
    answer: ({ card, kind, subject, option, version, key }) => {
      const headers = key ? { 'idempotency-key': key } : {};
      const approval = kind === 'approval' && /^approval\/(.+)$/.exec(subject ?? '')?.[1];
      if (approval) return call('POST', `/approvals/${encodeURIComponent(approval)}`, { decision: option === 'deny' ? 'denied' : option === 'approve' ? 'approved' : option, version }, headers);
      return call('POST', `/cards/${encodeURIComponent(card)}`, { option, version }, headers);
    },
    /** This team's line from /me/summary (cost today against the cap, run state) and the run itself. */
    async run() {
      const [summary, run] = await Promise.all([call('GET', '/me/summary'), currentRun().catch(() => null)]);
      const line = (summary?.teams ?? []).find((x) => x.team === team) ?? null;
      return { summary: line, run: run && { id: run.id, state: run.state ?? run.status ?? line?.run ?? null } };
    },
    async control(action, key) {
      if (!['pause', 'resume', 'stop'].includes(action)) throw new Upstream(400, { error: 'pause, resume or stop' });
      const run = await currentRun();
      if (!run) throw new Upstream(409, { error: 'no run is going' });
      return call('POST', `/runs/${encodeURIComponent(run.id)}/${action}`, {}, key ? { 'idempotency-key': key } : {});
    },
  };
}
