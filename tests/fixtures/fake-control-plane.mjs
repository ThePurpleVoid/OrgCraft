// A stand-in control plane for the Studio's chat tests: the /v1/ paths the chat uses, in memory, with a stubbed runner,
// shaped as docs/product/m3-design.md section 5 and api-v1.yaml (ChatPage) say the real one answers: the chat page
// (items, cards by id, run, cost, asOf), verbatim messages whose repeated clientId returns 200, card.updated carrying
// the whole card, a 409 with the current card when an answer is stale, step-up for approvals, Idempotency-Key
// replays, runs with pause and stop, usage counted into today's cost, and the event stream.
// When the real endpoints land (issue #28, backend dev), the chat tests also run against apps/server.
import { createServer } from 'node:http';

export async function fakeControlPlane({ token = 'test-token', stepUpSecret = 'step-up-secret', team = 'demo', runner = defaultRunner, running = true, perDay = 5000 } = {}) {
  const events = [];
  const cards = new Map(); // id -> card
  const replays = new Map(); // idempotency key -> [status, body]
  const streams = new Set();
  const runs = running ? [{ id: 'run_1', state: 'running', started: new Date().toISOString() }] : [];
  const budget = { currency: 'USD', perDay, perRun: null, sessions: 3 };
  const cost = { today: 620, capPerDay: perDay, currency: 'USD', state: 'ok' };
  const started = []; // the RunCreate bodies, for the tests
  const stepUps = new Map(); // su_ token -> expiry (ms)
  // L22 (apps/server/ledger.mjs): standing rules and the ledger, newest first; a test pushes rows.
  const rules = [];
  const ledger = [];
  const live = []; // live overrides in force (apps/server/live.mjs): { id, kind, member, state, reason, by, at, text, liveChange }
  let n = 0;
  const id = () => `ev_${String(++n).padStart(6, '0')}`;

  function append(type, actor, data, subject) {
    const e = { specversion: '1.0', id: id(), type, version: 1, source: `/tenants/t/teams/${team}`, tenant: 't', team, time: new Date().toISOString(), actor, ...(subject ? { subject } : {}), data };
    events.push(e);
    for (const res of streams) res.write(`id: ${e.id}\nevent: ${type}\ndata: ${JSON.stringify(e)}\n\n`);
    return e;
  }
  const role = (slug) => ({ kind: 'role', id: slug, via: 'tool' });
  const api = {
    say: (text, from = 'chief-of-staff') => append('chat.message', role(from), { from: { kind: 'role', id: from }, text }),
    card(card, from = 'chief-of-staff') {
      const c = { team, version: 1, url: `http://studio.invalid/t/${team}/cards/${card.id}`, ...card };
      cards.set(c.id, c);
      append('card.updated', { kind: 'system', id: 'cards' }, { card: c }, `card/${c.id}`);
      return append(c.kind === 'approval' ? 'approval.requested' : 'decision.requested', role(from), { cardId: c.id, ...(c.kind === 'decision' ? { question: c.title } : { why: c.body }) }, c.subject);
    },
    /**
     * Changes a card behind the page's back, as another member or an expiry would. `silent` holds back its
     * card.updated, as when the change lands while the person's answer is already on its way: the page cannot have
     * seen it, so its answer must get the 409.
     */
    bump(cardId, patch = {}, { silent = false } = {}) {
      const c = { ...cards.get(cardId), ...patch, version: cards.get(cardId).version + 1 };
      cards.set(cardId, c);
      if (!silent) append('card.updated', { kind: 'system', id: 'cards' }, { card: c }, `card/${c.id}`);
      return c;
    },
    usage(amount) { cost.today += amount; append('usage.recorded', role('chief-of-staff'), { inputTokens: 1000, outputTokens: 200, cost: amount, currency: cost.currency }); },
    /** Spends today's budget: the runs pause with reason budget, as the real control plane does at 100%. */
    exhaust() { cost.state = 'exhausted'; for (const r of runs) if (r.state === 'running') { r.state = 'paused'; r.reason = 'budget'; append('run.paused', { kind: 'system', id: 'budget' }, { reason: 'budget' }, `run/${r.id}`); } },
    events, cards, runs, cost, budget, started, live, rules, ledger,
  };
  const scopes = new Map(); // su -> scope it was bound to (ADR 0013)
  const stepped = (req, scope = null) => { const su = req.headers['x-step-up']; if (!su || !(stepUps.get(su) > Date.now()) || (scopes.get(su) ?? null) !== scope) return false; stepUps.delete(su); scopes.delete(su); return true; };
  const needStepUp = (res, what) => send(res, 401, { type: 'step-up-required', title: `${what} needs a recent sign-in`, status: 401 });

  const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const read = async (req) => { let b = ''; for await (const c of req) b += c; return b ? JSON.parse(b) : {}; };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: 'bearer token required' });
    const key = req.headers['idempotency-key'];
    if (req.method === 'POST' && key && replays.has(key)) return send(res, ...replays.get(key));
    const done = (status, body) => { if (req.method === 'POST' && key) replays.set(key, [status, body]); return send(res, status, body); };

    // A held meeting (meetings.mjs view): the Studio reads its definition to open a link to its minutes.
    const held = new RegExp(`^/v1/teams/${team}/meetings/([^/]+)$`).exec(p);
    if (held && req.method === 'GET') return held[1] === 'mtg_held1' ? send(res, 200, { id: 'mtg_held1', definition: 'weekly-review', title: 'Weekly review', state: 'closed' }) : send(res, 404, { error: 'no such meeting' });
    if (p === `/v1/teams/${team}/chat` && req.method === 'GET') {
      const shown = events.filter((e) => /^(chat\.|decision\.|approval\.|card\.updated|run\.|budget\.)/.test(e.type));
      const before = url.searchParams.get('before');
      const end = before ? shown.findIndex((e) => e.id === before) : shown.length;
      const page = shown.slice(Math.max(0, end - 50), end);
      const r = runs.find((x) => x.state !== 'stopped') ?? null;
      return send(res, 200, {
        asOf: events.at(-1)?.id ?? null, items: page, cards: Object.fromEntries(cards), run: r && { id: r.id, state: r.state, version: 1 }, cost,
        ...(end > 50 ? { next: page[0].id } : {}),
      });
    }
    if (p === `/v1/teams/${team}/chat` && req.method === 'POST') {
      const body = await read(req);
      const dup = body.clientId && events.find((e) => e.data?.clientId === body.clientId);
      if (dup) return done(200, dup);
      const e = append('chat.message', { kind: 'person', id: 'owner', via: 'studio' }, { from: { kind: 'person', id: 'owner' }, text: body.text, clientId: body.clientId });
      setTimeout(() => runner(api, body.text), 30);
      return done(201, e);
    }
    const card = /^\/v1\/cards\/([^/]+)$/.exec(p) ?? /^\/v1\/approvals\/([^/]+)$/.exec(p);
    if (card && req.method === 'POST') {
      const body = await read(req);
      const c = cards.get(card[1]) ?? [...cards.values()].find((x) => x.subject === `approval/${card[1]}`);
      if (!c) return send(res, 404, { error: 'no such card' });
      if (body.version !== undefined && body.version !== c.version) return send(res, 409, c);
      // A card this person's role may not answer (card.forbid): the server's 403, with its own words.
      if (c.forbid) return send(res, 403, { type: 'forbidden', error: 'role member lacks cards.answer for this kind' });
      const option = (c.options ?? []).find((o) => o.id === (body.option ?? (body.decision === 'approved' ? 'approve' : body.decision === 'denied' ? 'deny' : '')));
      if (c.kind === 'approval' || option?.stepUp) {
        const su = req.headers['x-step-up'];
        if (!su || !(stepUps.get(su) > Date.now())) return send(res, 401, { type: 'step-up-required', title: 'A recent sign-in is needed', status: 401 });
      }
      const answer = body.option ?? body.decision;
      const e = c.kind === 'approval'
        ? append('approval.decided', { kind: 'person', id: 'owner', via: 'studio' }, { approval: card[1], cardId: c.id, decision: answer, by: 'owner' }, c.subject)
        : append('decision.answered', { kind: 'person', id: 'owner', via: 'studio' }, { cardId: c.id, answer, by: 'owner' }, c.subject);
      const answered = { ...c, version: c.version + 1, answered: { option: answer, by: 'owner' } };
      cards.set(c.id, answered);
      append('card.updated', { kind: 'system', id: 'cards' }, { card: answered }, `card/${c.id}`);
      return done(200, e);
    }
    if (p === '/v1/auth/step-up' && req.method === 'POST') {
      const body = await read(req);
      if (body.secret !== stepUpSecret) return send(res, 401, { title: 'not accepted', status: 401 });
      const su = `su_${Math.random().toString(36).slice(2)}`;
      stepUps.set(su, Date.now() + 5 * 60_000);
      if (typeof body.scope === 'string') scopes.set(su, body.scope);
      return send(res, 201, { token: su, expires: new Date(Date.now() + 5 * 60_000).toISOString() });
    }
    if (p === `/v1/teams/${team}/runs` && req.method === 'GET') return send(res, 200, { runs });
    if (p === `/v1/teams/${team}/runs` && req.method === 'POST') {
      const body = await read(req);
      const roles = body.team?.roles;
      if (!Array.isArray(roles) || !roles.length) return send(res, 409, { title: "send the team's roles", status: 409 });
      if (roles.filter((r) => r.reportsTo === 'owner').length !== 1) return send(res, 409, { title: 'exactly one role reports to the owner', status: 409 });
      if (budget.perDay === null) return send(res, 409, { title: 'set a daily cap first: PUT /v1/teams/{team}/budget with perDay', status: 409 });
      const going = runs.find((r) => r.state !== 'stopped');
      if (going) return send(res, 409, { title: `run ${going.id} is still going; stop it first`, status: 409 });
      if (cost.state === 'exhausted') return send(res, 409, { type: 'budget-exhausted', title: "today's budget is spent; raise it or start tomorrow", status: 409 });
      const r = { id: `run_${runs.length + 1}`, state: 'running', started: new Date().toISOString(), teamVersion: body.team.version };
      runs.push(r);
      started.push(body);
      append('run.started', { kind: 'person', id: 'owner', via: 'studio' }, { mode: body.mode, by: 'owner', roles: roles.length }, `run/${r.id}`);
      return done(201, { id: r.id, team, mode: body.mode, state: 'running', teamVersion: r.teamVersion, version: 1 });
    }
    if (p === `/v1/teams/${team}/budget` && req.method === 'GET') return send(res, 200, { ...budget, today: { spent: cost.today, state: cost.state } });
    if (p === `/v1/teams/${team}/budget` && req.method === 'PUT') {
      const body = await read(req);
      const next = { ...budget, ...body };
      const raises = (o, n, nullIsUnlimited) => (o === null ? (nullIsUnlimited ? false : n !== null) : n === null ? true : n > o);
      if ((raises(budget.perDay, next.perDay, false) || raises(budget.perRun, next.perRun, true) || next.sessions > budget.sessions) && !stepped(req)) return needStepUp(res, 'Raising a budget');
      Object.assign(budget, next);
      cost.capPerDay = budget.perDay;
      if (cost.state === 'exhausted' && budget.perDay !== null && cost.today < budget.perDay) cost.state = 'ok';
      append('budget.updated', { kind: 'person', id: 'owner', via: 'studio' }, { ...budget, by: 'owner' }, 'budget');
      return done(200, { ...budget, today: { spent: cost.today, state: cost.state } });
    }
    const act = /^\/v1\/runs\/([^/]+)\/(pause|resume|stop)$/.exec(p);
    if (act && req.method === 'POST') {
      const r = runs.find((x) => x.id === act[1]);
      if (!r) return send(res, 404, { error: 'no such run' });
      if (act[2] === 'resume' && cost.state === 'exhausted') return send(res, 409, { type: 'budget-exhausted', title: "today's budget is spent; raise it or wait for tomorrow", status: 409 });
      // Like the control plane (ADR 0013): resuming needs a step-up bound to this run, whoever paused it.
      if (act[2] === 'resume' && !stepped(req, `resume:${act[1]}`)) return send(res, 401, { type: 'step-up-required', title: 'Resuming a paused run needs a recent sign-in', status: 401, scope: `resume:${act[1]}` });
      r.state = { pause: 'paused', resume: 'running', stop: 'stopped' }[act[2]];
      r.reason = act[2] === 'pause' ? 'owner' : null;
      return done(200, append(`run.${r.state === 'running' ? 'resumed' : r.state}`, { kind: 'person', id: 'owner', via: 'studio' }, { by: 'owner' }, `run/${r.id}`));
    }
    // Live overrides (L18), like apps/server/live.mjs: setting needs no step-up; lifting one needs a step-up bound to
    // lift:<id>; only a lift clears one (a run that starts does not).
    if (p === '/v1/me' && req.method === 'GET') return send(res, 200, { id: 'per_owner', login: 'owner', name: 'Owner' });
    if (p === `/v1/teams/${team}/standing-rules` && req.method === 'GET') {
      return send(res, 200, { kinds: [['refund', true], ['pay.known', true], ['send.known', true], ['reply', false], ['merge', false], ['cost', false]].map(([id, enforced]) => ({ id, enforced })), never: ['newrecipient', 'live', 'delete', 'passkey', 'outside'], rules });
    }
    const sr = new RegExp(`^/v1/teams/${team}/standing-rules/([^/]+)$`).exec(p);
    if (sr && req.method === 'DELETE') {
      const r = rules.find((x) => x.id === sr[1] && x.live);
      if (!r) return send(res, 404, { error: 'no such live rule' });
      Object.assign(r, { live: false, withdrawnAt: new Date().toISOString(), withdrawnBy: 'per_owner' });
      ledger.unshift({ at: new Date().toISOString(), kind: 'rule-withdrawn', by: 'per_owner', rule: r.id, ruleNumber: r.number, ruleForm: r.form });
      return send(res, 200, { id: r.id, withdrawn: true });
    }
    if (p === `/v1/teams/${team}/ledger` && req.method === 'GET') {
      // Pages of three; here `before` is an offset, where the real server's is a row id (both opaque to the Studio).
      const start = Number(url.searchParams.get('before') ?? 0);
      const page = ledger.slice(start, start + 3);
      return send(res, 200, { items: page, next: start + 3 < ledger.length ? String(start + 3) : null });
    }
    if (p === `/v1/teams/${team}/live` && req.method === 'GET') return send(res, 200, { live });
    const at = () => new Date().toISOString();
    if (p === `/v1/teams/${team}/live/stop-everything` && req.method === 'POST') {
      const body = await read(req);
      let o = live.find((x) => x.kind === 'halt');
      if (!o) {
        const paused = runs.filter((r) => r.state === 'running');
        for (const r of paused) r.state = 'paused';
        o = { id: `lo_${live.length + 1}`, kind: 'halt', state: 'paused', reason: body.reason ?? null, by: 'owner', at: at(), runs: paused.map((r) => r.id), text: 'Everything is stopped. Resume when you\'re ready.', liveChange: 'Live change by you: everything stopped' };
        live.push(o);
        append('live.changed', { kind: 'person', id: 'owner', via: 'studio' }, { op: 'set', override: o.id, kind: 'halt', state: 'paused', by: 'owner' }, 'live');
      }
      return send(res, 200, o);
    }
    const mem = new RegExp(`^/v1/teams/${team}/live/members/([^/]+)$`).exec(p);
    if (mem && req.method === 'PUT') {
      const body = await read(req);
      const member = decodeURIComponent(mem[1]);
      const i = live.findIndex((x) => x.kind === 'member' && x.member === member);
      const o = { id: i >= 0 ? live[i].id : `lo_${live.length + 1}`, kind: 'member', member, state: body.state, reason: body.reason ?? null, by: 'owner', at: at(), text: `${member} is ${body.state === 'off' ? 'switched off' : 'paused'}`, liveChange: `Live change by you: ${member} ${body.state}` };
      if (i >= 0) live[i] = o; else live.push(o);
      append('live.changed', { kind: 'person', id: 'owner', via: 'studio' }, { op: 'set', override: o.id, kind: 'member', member, state: o.state, by: 'owner' }, 'live');
      return send(res, 200, o);
    }
    const lift = new RegExp(`^/v1/teams/${team}/live/([^/]+)$`).exec(p);
    if (lift && req.method === 'DELETE') {
      const i = live.findIndex((x) => x.id === lift[1]);
      if (i < 0) return send(res, 404, { error: 'no such live change' });
      if (!stepped(req, `lift:${lift[1]}`)) return send(res, 401, { type: 'step-up-required', title: 'Lifting a live change needs a recent sign-in', status: 401, scope: `lift:${lift[1]}` });
      const [o] = live.splice(i, 1);
      if (o.kind === 'halt') for (const r of runs) if (o.runs.includes(r.id) && r.state === 'paused') r.state = 'running';
      append('live.changed', { kind: 'person', id: 'owner', via: 'studio' }, { op: 'lifted', override: o.id, kind: o.kind, by: 'owner', stepUp: true }, 'live');
      return send(res, 200, { ...o, lifted: true });
    }
    if (p === '/v1/me/summary') {
      const r = runs.find((x) => x.state !== 'stopped');
      return send(res, 200, { asOf: events.at(-1)?.id ?? null, teams: [{ team, name: team, run: r?.state ?? null, cost, inbox: 0 }] });
    }
    if (p === `/v1/teams/${team}/board`) return send(res, 200, { current: [], feed: [], flow: [], asOf: events.at(-1)?.id ?? null });
    if (p === `/v1/teams/${team}/events/stream`) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write('retry: 1000\n\n');
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    send(res, 404, { error: `fake control plane: no ${req.method} ${p}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, token, stepUpSecret, team, ...api,
    env: { AGENT_TEAM_SERVER: url, AGENT_TEAM_SERVER_TOKEN: token, AGENT_TEAM_SERVER_TEAM: team },
    close: () => { for (const s of streams) s.end(); server.closeAllConnections?.(); server.close(); },
  };
}

/** The stubbed runner: the chief of staff acknowledges, then asks a decision and an approval. No model involved. */
function defaultRunner(api, text) {
  api.usage(35);
  api.say(`Got it. I opened an issue for **${text.split('\n')[0].slice(0, 60)}** and routed it to the CTO's lane.\n\nNext:\n- web dev builds it\n- QA checks it before anything merges`);
  api.card({ id: `card_${api.events.length}`, kind: 'decision', subject: `decision/d_${api.events.length}`, title: 'What should the default be?', body: 'Follow the device setting, or always start in light.', recommendation: { option: 'system', why: 'Matches what people already chose.' }, options: [{ id: 'system', label: 'Follow system' }, { id: 'light', label: 'Light' }] });
  api.card({ id: `card_${api.events.length}`, kind: 'approval', subject: `approval/apr_${api.events.length}`, title: 'release-manager asks to merge #12 at 3f9c2ab', data: { pr: 12, headSha: '3f9c2ab41e7d0c95b8f6a2d4e1c0b9a8f7e6d5c4' }, body: 'QA signed off with evidence. The merge gate is green.', risk: 'low', options: [{ id: 'approve', label: 'Approve', style: 'primary', stepUp: true }, { id: 'deny', label: 'Deny', style: 'danger' }], links: [{ rel: 'pr', url: 'https://example.com/pull/12' }] });
}
