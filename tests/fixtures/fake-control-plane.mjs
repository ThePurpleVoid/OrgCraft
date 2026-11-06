// A stand-in control plane for the Studio's chat tests: the /v1/ paths the chat uses (docs/contracts/api-v1.yaml and
// clients.md), in memory, with a stubbed runner. It answers the way the contract says the real one will: verbatim chat
// messages with client ids, cards with versions and a 409 carrying the current card when an answer is stale,
// Idempotency-Key replays, runs with pause and stop, /me/summary with today's cost, and the event stream.
// When the real endpoints land (issue #28, backend dev), the chat tests also run against apps/server.
import { createServer } from 'node:http';

export async function fakeControlPlane({ token = 'test-token', team = 'demo', runner = defaultRunner } = {}) {
  const events = [];
  const cards = new Map(); // id -> card
  const replays = new Map(); // idempotency key -> [status, body]
  const streams = new Set();
  const runs = [{ id: 'run_1', state: 'running', started: new Date().toISOString() }];
  const cost = { today: 620, capPerDay: 5000, currency: 'USD' };
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
      return append(c.kind === 'approval' ? 'approval.requested' : 'decision.requested', role(from), { card: c }, c.subject);
    },
    /** Changes a card behind the page's back, as another member or an expiry would. */
    bump(cardId, patch = {}) { const c = { ...cards.get(cardId), ...patch, version: cards.get(cardId).version + 1 }; cards.set(cardId, c); return c; },
    events, cards, runs, cost,
  };

  const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const read = async (req) => { let b = ''; for await (const c of req) b += c; return b ? JSON.parse(b) : {}; };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: 'bearer token required' });
    const key = req.headers['idempotency-key'];
    if (req.method === 'POST' && key && replays.has(key)) return send(res, ...replays.get(key));
    const done = (status, body) => { if (req.method === 'POST' && key) replays.set(key, [status, body]); return send(res, status, body); };

    if (p === `/v1/teams/${team}/chat` && req.method === 'GET') {
      const shown = events.filter((e) => /^(chat|decision|approval)\./.test(e.type));
      const before = url.searchParams.get('before');
      const end = before ? shown.findIndex((e) => e.id === before) : shown.length;
      const page = shown.slice(Math.max(0, end - 50), end);
      return send(res, 200, { events: page, cards: [...cards.values()], asOf: events.at(-1)?.id ?? null, next: end > 50 ? page[0].id : null });
    }
    if (p === `/v1/teams/${team}/chat` && req.method === 'POST') {
      const body = await read(req);
      const dup = body.clientId && events.find((e) => e.data?.clientId === body.clientId);
      if (dup) return done(201, dup);
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
      const answer = body.option ?? body.decision;
      const e = c.kind === 'approval'
        ? append('approval.decided', { kind: 'person', id: 'owner', via: 'studio' }, { approval: card[1], decision: answer, by: 'owner' }, c.subject)
        : append('decision.answered', { kind: 'person', id: 'owner', via: 'studio' }, { answer, by: 'owner' }, c.subject);
      return done(200, e);
    }
    if (p === `/v1/teams/${team}/runs` && req.method === 'GET') return send(res, 200, { runs });
    const act = /^\/v1\/runs\/([^/]+)\/(pause|resume|stop)$/.exec(p);
    if (act && req.method === 'POST') {
      const r = runs.find((x) => x.id === act[1]);
      if (!r) return send(res, 404, { error: 'no such run' });
      r.state = { pause: 'paused', resume: 'running', stop: 'stopped' }[act[2]];
      return done(200, append(`run.${r.state === 'running' ? 'resumed' : r.state}`, { kind: 'person', id: 'owner', via: 'studio' }, { by: 'owner' }, `run/${r.id}`));
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
    url, token, team, ...api,
    env: { AGENT_TEAM_SERVER: url, AGENT_TEAM_SERVER_TOKEN: token, AGENT_TEAM_SERVER_TEAM: team },
    close: () => { for (const s of streams) s.end(); server.closeAllConnections?.(); server.close(); },
  };
}

/** The stubbed runner: the chief of staff acknowledges, then asks a decision and an approval. No model involved. */
function defaultRunner(api, text) {
  api.say(`Got it. I opened an issue for **${text.split('\n')[0].slice(0, 60)}** and routed it to the CTO's lane.\n\nNext:\n- web dev builds it\n- QA checks it before anything merges`);
  api.card({ id: `card_${api.events.length}`, kind: 'decision', subject: `decision/d_${api.events.length}`, title: 'What should the default be?', body: 'Follow the device setting, or always start in light.', recommendation: { option: 'system', why: 'Matches what people already chose.' }, options: [{ id: 'system', label: 'Follow system' }, { id: 'light', label: 'Light' }] });
  api.card({ id: `card_${api.events.length}`, kind: 'approval', subject: `approval/apr_${api.events.length}`, title: 'Merge PR #12', body: 'QA signed off with evidence. The merge gate is green.', risk: 'low', options: [{ id: 'approve', label: 'Approve', style: 'primary', stepUp: true }, { id: 'deny', label: 'Deny', style: 'danger' }], links: [{ rel: 'pr', url: 'https://example.com/pull/12' }] });
}
