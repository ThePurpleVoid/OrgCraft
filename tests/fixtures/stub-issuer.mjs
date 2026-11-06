// A stand-in for the hosted deployment's issuer (docs/specs/m4-sign-in.md sections 2 to 4), for the sign-in pages'
// tests until the real one exists. It serves the Studio's static pages as the hosted deployment would, and plays
// the issuer and an upstream "GitHub":
//
//   GET  /oauth/authorize?client_id=agent-team-web&return=<path>   session? → return : /sign-in?interaction=<uid>
//   GET  /oauth/interaction/<uid>/github                           → the stub GitHub, then /oauth/callback/github
//   GET  /oauth/callback/github?code&state                         member or invitee? cookie + return : not-invited
//   POST /oauth/revoke                                             ends the session
//   GET  /v1/me, /v1/me/passkeys, /v1/me/passkeys/options; POST /v1/me/passkeys; DELETE /v1/me/passkeys/<id>
//   GET  /v1/auth/step-up/challenge; POST /v1/auth/step-up { webauthn } → { token: su_…, expires }
//
// It checks what the pages are responsible for: the cookie (HttpOnly, Secure, SameSite=Lax, __Host-), CSRF (Origin
// and JSON on unsafe methods), the return path, single-use challenges with a 2-minute life, the client data's type,
// challenge and exact origin, the authenticator's user-present and user-verified flags and rpId hash, step-up as a
// single-use su_ token, and a lockout. It does NOT verify attestation or assertion signatures: the real issuer does
// that with @simplewebauthn/server (section 4a, K1), and nothing here is meant to be reused as one.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeReturn } from '../../apps/studio/public/auth.js';
import { KINDS, SUGGESTED } from '../../apps/server/email.mjs';
import { CHANNEL_DEFAULT_KINDS } from '../../apps/server/slack.mjs';

const PUBLIC = fileURLToPath(new URL('../../apps/studio/public/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const COOKIE = '__Host-agent-team';
const b64u = (b) => Buffer.from(b).toString('base64url');
const rid = (p) => `${p}${randomBytes(12).toString('base64url')}`;

/** The authData byte string inside a CBOR attestation object ("none" attestation): found after its text key. */
function authDataOf(att) {
  const key = Buffer.from([0x68, ...Buffer.from('authData')]);
  const at = att.indexOf(key);
  if (at < 0) return null;
  let i = at + key.length;
  const h = att[i++];
  let len = h & 0x1f;
  if (len === 24) len = att[i++]; else if (len === 25) { len = att.readUInt16BE(i); i += 2; } else if (len > 25) return null;
  return att.subarray(i, i + len);
}

export async function stubIssuer({ members = { octo: { id: 'per_octo', name: 'Octo Cat', workspaces: [{ tenant: 'acme', name: 'Acme', role: 'owner' }] } } } = {}) {
  const sessions = new Map(); // sid -> { person, authTime }
  const interactions = new Map(); // uid -> { return, state }
  const challenges = new Map(); // challenge -> { kind, person, expires }
  const passkeys = new Map(); // person -> [{ id, name, createdAt, lastUsed }]
  const notices = new Map(); // person -> [{ action, at, passkey, name }], oldest first (GET /v1/me lists them newest first)
  const stepUps = new Map(); // su_ -> { person, expires }
  const failures = new Map(); // person -> [ms]
  const upstream = { login: 'octo' }; // who the stub GitHub signs in; tests change it
  const log = []; // { method, path, status } for the tests
  // A person's email addresses per team, as apps/server/email.mjs keeps them (kit #101), and the codes it "sent".
  const teams = new Set(['sample-app']);
  const emails = []; // { id, team, person, email, verified, kinds, code, tries, createdAt }
  const codes = []; // { email, code }
  const mail = { sink: true }; // false: the team has no email sink yet, so no code is sent
  // Slack (kit #110), in memory: the workspace connection, the people linked, the channels picked, and the
  // states Connect Slack handed out (the "Slack" sign-in in a test comes back with one of them).
  const slack = { connected: true, ready: true, canLink: true, failingSince: null, workspace: 'Acme', links: new Map(), channels: [], states: new Map(), user: { name: 'octo.cat', workspace: 'Acme' } };
  let origin = '';

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const p = url.pathname;
    const send = (status, body, headers = {}) => { log.push({ method: req.method, path: p, status }); res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(body)); };
    const redirect = (to, headers = {}) => { log.push({ method: req.method, path: p, status: 302, to }); res.writeHead(302, { location: to, 'cache-control': 'no-store', ...headers }); res.end(); };
    const problem = (status, type, error) => send(status, { type, title: error, status, error });
    const cookie = String(req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === COOKIE)?.[1];
    const session = cookie && sessions.get(cookie);
    const read = async () => { let b = ''; for await (const c of req) b += c; return b ? JSON.parse(b) : {}; };

    // CSRF (section 2): an unsafe method with the cookie needs the deployment's own Origin and a JSON body.
    if (!['GET', 'HEAD'].includes(req.method) && (req.headers.origin !== origin || !String(req.headers['content-type'] ?? '').startsWith('application/json'))) return problem(403, 'csrf', 'cross-site request refused');

    if (p === '/oauth/authorize' && req.method === 'GET') {
      if (url.searchParams.get('client_id') !== 'agent-team-web') return problem(400, 'invalid-client', 'unknown client');
      const back = safeReturn(url.searchParams.get('return') ?? '/');
      if (session) return redirect(back);
      const uid = rid('');
      interactions.set(uid, { return: back, state: rid('st_'), expires: Date.now() + 10 * 60_000 });
      return redirect(`/sign-in?interaction=${uid}`);
    }
    const inter = /^\/oauth\/interaction\/([A-Za-z0-9_-]+)\/github$/.exec(p);
    if (inter && req.method === 'GET') {
      const it = interactions.get(inter[1]);
      if (!it || it.expires < Date.now()) return redirect('/sign-in?error=expired');
      // The stub GitHub signs in `upstream.login` at once and comes back to the issuer's own callback.
      return redirect(`/oauth/callback/github?code=${encodeURIComponent(upstream.login)}&state=${it.state}`);
    }
    if (p === '/oauth/callback/github' && req.method === 'GET') {
      const entry = [...interactions.entries()].find(([, v]) => v.state === url.searchParams.get('state'));
      if (!entry) return redirect('/sign-in?error=expired');
      interactions.delete(entry[0]);
      const login = url.searchParams.get('code');
      const person = members[login];
      if (!person) return redirect('/sign-in?error=not-invited');
      const sid = randomBytes(32).toString('base64url');
      sessions.set(sid, { person: { login, ...person }, authTime: Date.now() });
      return redirect(entry[1].return, { 'set-cookie': `${COOKIE}=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/` });
    }
    if (p === '/oauth/revoke' && req.method === 'POST') {
      if (cookie) sessions.delete(cookie);
      return send(200, {}, { 'set-cookie': `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` });
    }

    if (p.startsWith('/v1/')) {
      if (!session) return problem(401, 'unauthenticated', 'sign in first');
      const who = session.person;
      const mine = passkeys.get(who.id) ?? [];
      const stepped = () => { const t = req.headers['x-step-up']; const s = t && stepUps.get(t); if (!s || s.person !== who.id || s.expires < Date.now()) return false; stepUps.delete(t); return true; };
      const challenge = (kind) => { const c = b64u(randomBytes(32)); challenges.set(c, { kind, person: who.id, expires: Date.now() + 2 * 60_000 }); return c; };
      /** The client data a browser signed: its type, a live single-use challenge of this kind, and exactly this origin. */
      const clientData = (cred, kind, type) => {
        let cd;
        try { cd = JSON.parse(Buffer.from(cred?.response?.clientDataJSON ?? '', 'base64url').toString()); } catch { return 'unreadable client data'; }
        const c = challenges.get(cd.challenge);
        if (cd.type !== type) return 'wrong ceremony';
        if (!c || c.kind !== kind || c.person !== who.id || c.expires < Date.now()) return 'that challenge is unknown, used or expired';
        challenges.delete(cd.challenge);
        if (cd.origin !== origin) return 'an assertion from another origin';
        return null;
      };
      const rpOk = (authData) => authData && authData.subarray(0, 32).equals(createHash('sha256').update(new URL(origin).hostname).digest());
      const verified = (authData) => (authData[32] & 0x05) === 0x05; // user present and user verified

      // The emails API of kit #101, in memory: the same paths, bodies and refusals as apps/server/server.mjs.
      const em = /^\/v1\/teams\/([^/]+)\/emails(?:\/([^/]+)(\/verify)?)?$/.exec(p);
      if (em) {
        const [, team, sid, verify] = em;
        if (!teams.has(team)) return problem(404, 'not-found', `no team ${team}`);
        const kinds = () => Object.entries(KINDS).map(([id, k]) => ({ id, label: k.label, breakthrough: k.breakthrough, suggested: SUGGESTED.includes(id) }));
        const view = (e) => ({ id: e.id, email: e.email, verified: e.verified, kinds: e.kinds, createdAt: e.createdAt });
        const own = emails.filter((e) => e.team === team && e.person === who.id);
        if (!sid && req.method === 'GET') return send(200, { teamName: team === 'sample-app' ? 'Sample app' : team, ready: mail.sink, kinds: kinds(), emails: own.map(view) });
        if (!sid && req.method === 'POST') {
          const address = String((await read()).email ?? '').trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return problem(400, 'bad-request', 'send { email } with one email address');
          let e = own.find((x) => x.email === address);
          if (e?.verified) return send(201, { id: e.id, email: address, verified: true, sent: false, reason: 'this address is already verified' });
          if (!e) { e = { id: rid('eml_'), team, person: who.id, email: address, verified: false, kinds: [], createdAt: new Date().toISOString() }; emails.push(e); }
          e.code = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
          e.tries = 0;
          if (!mail.sink) return send(201, { id: e.id, email: address, verified: false, sent: false, reason: 'this team has no email sink yet' });
          codes.push({ email: address, code: e.code });
          return send(201, { id: e.id, email: address, verified: false, sent: true });
        }
        const e = own.find((x) => x.id === sid);
        if (!e) return problem(404, 'not-found', 'no such email address');
        if (verify && req.method === 'POST') {
          if (e.verified) return send(200, { id: e.id, verified: true });
          if (!e.code || e.tries >= 5) return problem(410, 'gone', 'too many tries or no code: ask for a new code');
          if (String((await read()).code ?? '').trim() !== e.code) { e.tries++; return problem(400, 'bad-request', 'that code is not right'); }
          e.verified = true; e.code = null;
          return send(200, { id: e.id, verified: true });
        }
        if (!verify && req.method === 'PATCH') {
          const body = await read();
          const list = Array.isArray(body.kinds) ? [...new Set(body.kinds.map(String))] : null;
          if (!list || list.some((k) => !KINDS[k])) return problem(400, 'bad-request', `send { kinds: [...] } from ${Object.keys(KINDS).join(', ')}`);
          if (!e.verified) return problem(409, 'conflict', 'verify the address with its code first');
          e.kinds = list;
          return send(200, view(e));
        }
        if (!verify && req.method === 'DELETE') { emails.splice(emails.indexOf(e), 1); return send(200, { ok: true }); }
      }

      // The Slack API of kit #110, in memory, with apps/server/slack.mjs's paths, bodies and refusals.
      const sl = /^\/v1\/teams\/([^/]+)\/slack(?:\/(connect|link|me|channels))?(?:\/([^/]+))?$/.exec(p);
      if (sl) {
        const [, team, what, cid] = sl;
        if (!teams.has(team)) return problem(404, 'not-found', `no team ${team}`);
        const admin = (who.workspaces ?? []).some((w) => w.role === 'owner' || w.role === 'admin');
        const kindsOf = (body, fallback) => {
          if (body?.kinds === undefined && fallback) return fallback;
          const list = Array.isArray(body?.kinds) ? [...new Set(body.kinds.map(String))] : null;
          return list && !list.some((k) => !KINDS[k]) ? list : null;
        };
        const linkView = (l) => (l ? { linked: true, id: l.id, name: l.name, kinds: l.kinds } : { linked: false, kinds: [] });
        const mineLink = slack.links.get(`${team}:${who.id}`);
        if (!what && req.method === 'GET') {
          return send(200, {
            connected: slack.connected, ready: slack.connected && slack.ready, canLink: slack.connected && slack.ready && slack.canLink,
            health: !slack.connected ? null : slack.failingSince ? { status: 'failing', since: slack.failingSince, error: 'channel_not_found' } : { status: slack.ready ? 'working' : 'waiting for its token' },
            kinds: Object.entries(KINDS).map(([id, k]) => ({ id, label: k.label, suggested: SUGGESTED.includes(id), channelDefault: CHANNEL_DEFAULT_KINDS.includes(id) })),
            me: linkView(mineLink),
          });
        }
        if (what === 'connect' && req.method === 'POST') {
          if (!slack.connected) return problem(409, 'conflict', "Slack isn't connected for this team yet. Ask an owner to add it.");
          const state = rid('sls_');
          slack.states.set(state, { team, person: who.id, expires: Date.now() + 10 * 60_000 });
          const u = new URL('https://slack.com/openid/connect/authorize');
          for (const [k, v] of Object.entries({ response_type: 'code', scope: 'openid profile', client_id: '123.456', state, redirect_uri: `${origin}/slack/callback` })) u.searchParams.set(k, v);
          return send(200, { url: u.href });
        }
        if (what === 'link' && req.method === 'POST') {
          const body = await read();
          const s = slack.states.get(body.state);
          if (!s || s.team !== team || s.person !== who.id) return problem(400, 'bad-request', 'this sign-in with Slack was not started here; start again');
          if (s.expires < Date.now()) return problem(410, 'gone', 'the sign-in with Slack took too long; start again');
          slack.states.delete(body.state);
          if (slack.user.workspace !== slack.workspace) return problem(409, 'conflict', `sign in to the ${slack.workspace} Slack workspace, the one this team is connected to`);
          const kinds = kindsOf(body, []);
          const l = { id: mineLink?.id ?? rid('slk_'), name: slack.user.name, kinds: body.kinds === undefined && mineLink ? mineLink.kinds : kinds };
          slack.links.set(`${team}:${who.id}`, l);
          return send(201, { ...linkView(l), welcomed: false });
        }
        if (what === 'me' && req.method === 'PATCH') {
          const kinds = kindsOf(await read());
          if (!kinds) return problem(400, 'bad-request', 'send { kinds: [...] }');
          if (!mineLink) return problem(404, 'not-found', 'connect Slack first');
          mineLink.kinds = kinds;
          return send(200, linkView(mineLink));
        }
        if (what === 'me' && req.method === 'DELETE') {
          if (!mineLink) return problem(404, 'not-found', 'Slack is not connected for you');
          slack.links.delete(`${team}:${who.id}`);
          return send(200, { ok: true });
        }
        if (what === 'channels') {
          if (!admin) return problem(403, 'forbidden', 'only an owner or admin picks channels');
          const view = (c) => ({ id: c.id, channel: c.channel, name: c.name, kinds: c.kinds, addedBy: c.addedBy, createdAt: c.createdAt });
          if (!cid && req.method === 'GET') return send(200, { channels: slack.channels.filter((c) => c.team === team).map(view) });
          if (!cid && req.method === 'POST') {
            const body = await read();
            const channel = String(body.channel ?? ''), name = String(body.name ?? '').replace(/^#/, '').toLowerCase();
            if (!/^[CG][A-Z0-9]{2,20}$/.test(channel) || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(name)) return problem(400, 'bad-request', 'send { channel, name } with the Slack channel id (like C0123ABCD) and its name');
            const kinds = kindsOf(body, CHANNEL_DEFAULT_KINDS);
            if (!kinds) return problem(400, 'bad-request', 'send { kinds: [...] }');
            if (slack.channels.some((c) => c.team === team && c.channel === channel)) return problem(409, 'conflict', 'this channel is already picked; change its kinds instead');
            const c = { id: rid('slc_'), team, channel, name, kinds, addedBy: who.name, createdAt: new Date().toISOString() };
            slack.channels.push(c);
            return send(201, { ...view(c), posted: !slack.failingSince, ...(slack.failingSince ? { reason: 'not_in_channel' } : {}) });
          }
          const c = slack.channels.find((x) => x.team === team && x.id === cid);
          if (!c) return problem(404, 'not-found', 'no such channel');
          if (req.method === 'PATCH') { const kinds = kindsOf(await read()); if (!kinds) return problem(400, 'bad-request', 'send { kinds: [...] }'); c.kinds = kinds; return send(200, view(c)); }
          if (req.method === 'DELETE') { slack.channels.splice(slack.channels.indexOf(c), 1); return send(200, { ok: true }); }
        }
      }

      if (p === '/v1/me' && req.method === 'GET') return send(200, { id: who.id, login: who.login, name: who.name, workspaces: who.workspaces, passkeys: mine.length, authTime: new Date(session.authTime).toISOString(), notices: [...(notices.get(who.id) ?? [])].reverse() });
      if (p === '/v1/me/passkeys' && req.method === 'GET') return send(200, { passkeys: mine });
      if (p === '/v1/me/passkeys/options' && req.method === 'GET') {
        return send(200, {
          challenge: challenge('create'), rp: { id: new URL(origin).hostname, name: 'Agent Team Studio' },
          user: { id: b64u(who.id), name: who.login, displayName: who.name ?? who.login },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }], timeout: 120_000, attestation: 'none',
          excludeCredentials: mine.map((k) => ({ type: 'public-key', id: k.id })),
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        });
      }
      if (p === '/v1/me/passkeys' && req.method === 'POST') {
        const body = await read();
        // The first passkey needs only a sign-in under 5 minutes old; every other one needs step-up (section 3).
        if (mine.length ? !stepped() : Date.now() - session.authTime > 5 * 60_000) return problem(401, 'step-up-required', 'Adding a passkey needs a fresh step-up');
        const bad = clientData(body.credential, 'create', 'webauthn.create');
        if (bad) return problem(400, 'webauthn', bad);
        const auth = authDataOf(Buffer.from(body.credential.response.attestationObject ?? '', 'base64url'));
        if (!rpOk(auth)) return problem(400, 'webauthn', 'the passkey is for another site');
        if (!verified(auth)) return problem(400, 'webauthn', 'the passkey did not verify the person');
        const k = { id: body.credential.id, name: String(body.name ?? 'Passkey').slice(0, 60), createdAt: new Date().toISOString(), lastUsed: null };
        passkeys.set(who.id, [...mine, k]);
        notices.set(who.id, [...(notices.get(who.id) ?? []), { action: 'passkey.added', at: new Date().toISOString(), passkey: k.id, name: k.name }]);
        return send(201, k);
      }
      const del = /^\/v1\/me\/passkeys\/([^/]+)$/.exec(p);
      if (del && req.method === 'DELETE') {
        if (!stepped()) return problem(401, 'step-up-required', 'Removing a passkey needs a fresh step-up');
        const gone = mine.find((k) => k.id === decodeURIComponent(del[1]));
        passkeys.set(who.id, mine.filter((k) => k.id !== decodeURIComponent(del[1])));
        if (gone) notices.set(who.id, [...(notices.get(who.id) ?? []), { action: 'passkey.removed', at: new Date(Date.now() + 1).toISOString(), passkey: gone.id, name: gone.name }]);
        return send(200, {});
      }
      if (p === '/v1/auth/step-up/challenge' && req.method === 'GET') {
        if (!mine.length) return problem(409, 'no-passkey', 'add a passkey first');
        return send(200, { challenge: challenge('get'), rpId: new URL(origin).hostname, timeout: 120_000, userVerification: 'required', allowCredentials: mine.map((k) => ({ type: 'public-key', id: k.id })) });
      }
      if (p === '/v1/auth/step-up' && req.method === 'POST') {
        const recent = (failures.get(who.id) ?? []).filter((t) => t > Date.now() - 15 * 60_000);
        if (recent.length >= 5) return problem(429, 'locked', 'too many tries');
        const body = await read();
        const fail = (why) => { failures.set(who.id, [...recent, Date.now()]); return problem(401, 'step-up-failed', why); };
        if (body.secret !== undefined) return fail('the step-up secret is for local mode only');
        const cred = body.webauthn;
        const key = mine.find((k) => k.id === cred?.id);
        if (!key) return fail('that passkey is not yours');
        const bad = clientData(cred, 'get', 'webauthn.get');
        if (bad) return fail(bad);
        const auth = Buffer.from(cred.response.authenticatorData ?? '', 'base64url');
        if (!rpOk(auth)) return fail('the passkey is for another site');
        if (!verified(auth)) return fail('the passkey did not verify the person');
        key.lastUsed = new Date().toISOString();
        const token = rid('su_');
        stepUps.set(token, { person: who.id, expires: Date.now() + 5 * 60_000 });
        return send(201, { token, expires: new Date(Date.now() + 5 * 60_000).toISOString() });
      }
      return problem(404, 'not-found', `stub issuer: no ${req.method} ${p}`);
    }

    // The Studio's static pages, as the hosted deployment serves them.
    const name = p === '/' ? 'account.html' : p === '/sign-in' ? 'sign-in.html' : p === '/account' ? 'account.html' : /^\/teams\/[^/]+\/notifications$/.test(p) ? 'notifications.html' : p === '/slack/callback' ? 'slack-callback.html' : p.slice(1);
    const file = normalize(join(PUBLIC, name));
    if (req.method !== 'GET' || !file.startsWith(PUBLIC) || !existsSync(file)) return send(404, { error: 'not found' });
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // localhost, not 127.0.0.1: WebAuthn needs a domain for rpId, and browsers treat localhost as a secure context.
  origin = `http://localhost:${server.address().port}`;
  return {
    origin, upstream, sessions, passkeys, stepUps, log, emails, codes, mail, teams, slack,
    /** Ages every session's sign-in, as if it happened `ms` ago. */
    age(ms) { for (const s of sessions.values()) s.authTime -= ms; },
    close: () => { server.closeAllConnections?.(); server.close(); },
  };
}
