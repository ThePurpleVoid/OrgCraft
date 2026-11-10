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
  /** The step-up header for one call, taken before it, so two calls in flight cannot both use one step-up. */
  const spendStepUp = () => { const h = stepUpHeader(); stepUp = null; return h; };

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
    /** The rollout of the team version the control plane last heard was published (team.published). */
    rollout: () => call('GET', `/teams/${t}/rollout`),
    /** One held meeting (a link to its minutes names it): { definition, title, … }. */
    meeting: (id) => call('GET', `/teams/${t}/meetings/${encodeURIComponent(id)}`),
    /** A page of the chat, newest last. `before` is the opaque cursor the control plane gave. */
    chat: ({ before } = {}) => call('GET', `/teams/${t}/chat${before ? `?before=${encodeURIComponent(before)}` : ''}`),
    /** The owner's words, verbatim. The client id makes a retry land once. */
    say: ({ text, clientId, replyTo }) => call('POST', `/teams/${t}/chat`, { text, clientId, ...(replyTo ? { replyTo } : {}) }, clientId ? { 'idempotency-key': clientId } : {}),
    /** Answers a card with the version the person saw. Approvals go to /approvals/{id}, every other card to /cards/{id}. */
    async answer({ card, kind, subject, option, version, key }) {
      const su = spendStepUp();
      const headers = { ...(key ? { 'idempotency-key': key } : {}), ...su };
      // An approval card's answer goes to its approval: the id from its subject, else the card id.
      const approval = kind === 'approval' && (/^approval\/(.+)$/.exec(subject ?? '')?.[1] ?? card);
      // One step-up, one answer, whatever comes of it: the next approval asks again.
      return approval
        ? call('POST', `/approvals/${encodeURIComponent(approval)}`, { decision: option === 'deny' ? 'denied' : option === 'approve' ? 'approved' : option, version }, headers)
        : call('POST', `/cards/${encodeURIComponent(card)}`, { option, version }, headers);
    },
    /**
     * "Do it" (L39): approves the lettered asks the person saw, each with its card version, in one call. One step-up
     * covers the set when any ask is bound; the control plane names its scope when it asks.
     */
    doIt: ({ asks, key }) => call('POST', '/approvals/do-it', { asks, via: 'chat' }, { ...(key ? { 'idempotency-key': key } : {}), ...spendStepUp() }),
    /** This team's line from /me/summary (cost today against the cap, run state) and the run itself. */
    async run() {
      const [summary, run] = await Promise.all([call('GET', '/me/summary'), currentRun().catch(() => null)]);
      const line = (summary?.teams ?? []).find((x) => x.team === team) ?? null;
      return { summary: line, run: run && { id: run.id, state: run.state ?? run.status ?? line?.run ?? null } };
    },
    /** Proves a recent sign-in. Until OIDC (M4) the proof is the step-up secret the person types; it is passed on, not kept. */
    async stepUp(secret, scope) {
      // A scope binds the step-up to one change (ADR 0013): the control plane names it when it asks, e.g. resume:<run>.
      const r = await call('POST', '/auth/step-up', { secret, ...(typeof scope === 'string' && scope ? { scope } : {}) });
      stepUp = { token: r.token, expires: r.expires ?? new Date(Date.now() + 5 * 60_000).toISOString() };
      return { ok: true, expires: stepUp.expires };
    },
    /** Pause and stop never need step-up. Resuming does (ADR 0013), so a resume spends one if there is one. */
    async control(action, key, runId) {
      if (!['pause', 'resume', 'stop'].includes(action)) throw new Upstream(400, { error: 'pause, resume or stop' });
      const run = typeof runId === 'string' && runId ? { id: runId } : await currentRun();
      if (!run) throw new Upstream(409, { error: 'no run is going' });
      const su = action === 'resume' ? spendStepUp() : {};
      return call('POST', `/runs/${encodeURIComponent(run.id)}/${action}`, {}, { ...(key ? { 'idempotency-key': key } : {}), ...su });
    },
    /** The team's caps, in whole minor units (cents for USD), and today's spend. perDay null means no run may start. */
    budget: () => call('GET', `/teams/${t}/budget`),
    /** Sets caps. Lowering never needs step-up; raising or clearing one does, so it spends one if there is one. */
    setBudget(body, key) {
      const pick = Object.fromEntries(['perDay', 'perRun', 'sessions', 'currency'].filter((k) => body?.[k] !== undefined).map((k) => [k, body[k]]));
      return call('PUT', `/teams/${t}/budget`, pick, { ...(key ? { 'idempotency-key': key } : {}), ...spendStepUp() });
    },
    /**
     * A one-time code for registering a runner (XXXX-XXXX-XXXX, 15 minutes, one use). It needs step-up, so it spends
     * one. The code passes through to the page once and is kept nowhere here. `server` is what the register command
     * needs: the control plane's base URL.
     */
    async runnerCode(name) {
      const r = await call('POST', '/runners/codes', { name: typeof name === 'string' ? name.slice(0, 100) : '' }, spendStepUp());
      return { code: r.code, expires: r.expires, server };
    },
    /** The workspace's runners: name, last seen, revoked. Never their keys (the control plane keeps only hashes). */
    runners: () => call('GET', '/runners'),
    // Live overrides (L18, apps/server/live.mjs): Stop everything and a teammate paused or off, set at once with no
    // step-up and no code host or Git involved (SH-10). Only lifting one needs a step-up, bound to lift:<id>.
    /** The live changes in force: { live: [{ id, kind, member, state, reason, by, at, text, liveChange }] }. */
    live: () => call('GET', `/teams/${t}/live`),
    // Approvals (L22, apps/server/ledger.mjs): the standing rules with their use this period, and the ledger, newest
    // first. Withdrawing narrows what the team may do, so it needs no step-up. `me` names the viewer for "You".
    me: () => call('GET', '/me'),
    // L40: the team's systems (resources.json) live on the control plane, set only by an admin with a step-up scoped
    // systems:<team> (apps/server/credentials.mjs putSystems); runs freeze them at start.
    systems: () => call('GET', `/teams/${t}/systems`),
    /** Drops a held step-up unspent: a refusal before the send must not leave it to authorise a set never shown. */
    dropStepUp: () => { spendStepUp(); },
    /** L40b: switches on the pending systems bound to `sha`, as shown (`contentHash`), spending the held step-up. */
    applyPending: (body) => call('POST', `/teams/${t}/systems/pending/apply`, body, spendStepUp()),
    setSystems: (body, key) => call('PUT', `/teams/${t}/systems`, body, { ...(key ? { 'idempotency-key': key } : {}), ...spendStepUp() }),
    rules: () => call('GET', `/teams/${t}/standing-rules`),
    // L22 (mockup v20): a rule drafted from an approval a person approved, and making it behind a step-up scoped
    // rule:<hash of the form> (the control plane names the scope in its 401).
    ruleDraft: (approval) => call('GET', `/teams/${t}/approvals/${encodeURIComponent(approval)}/rule-draft`),
    addRule: (body, key) => call('POST', `/teams/${t}/standing-rules`, body, { ...(key ? { 'idempotency-key': key } : {}), ...spendStepUp() }),
    withdrawRule: (id) => call('DELETE', `/teams/${t}/standing-rules/${encodeURIComponent(id)}`),
    ledger: (before) => call('GET', `/teams/${t}/ledger${before ? `?before=${encodeURIComponent(before)}` : ''}`),
    stopEverything: (reason, key) => call('POST', `/teams/${t}/live/stop-everything`, reason ? { reason } : {}, key ? { 'idempotency-key': key } : {}),
    setMember: (member, state, reason, key) => call('PUT', `/teams/${t}/live/members/${encodeURIComponent(member)}`, { state, ...(reason ? { reason } : {}) }, key ? { 'idempotency-key': key } : {}),
    /** Lifts one change: it spends the step-up this server holds, if any; without one the control plane asks (401). */
    lift: (id) => call('DELETE', `/teams/${t}/live/${encodeURIComponent(id)}`, undefined, spendStepUp()),
    /** Starts a run on the published team (runs.mjs builds the body). One run per team: a second one is a 409. */
    start: (body, key) => call('POST', `/teams/${t}/runs`, body, key ? { 'idempotency-key': key } : {}),
  };
}
