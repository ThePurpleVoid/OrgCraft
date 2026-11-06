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
    const name = p === '/' ? 'account.html' : p === '/sign-in' ? 'sign-in.html' : p === '/account' ? 'account.html' : p.slice(1);
    const file = normalize(join(PUBLIC, name));
    if (req.method !== 'GET' || !file.startsWith(PUBLIC) || !existsSync(file)) return send(404, { error: 'not found' });
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // localhost, not 127.0.0.1: WebAuthn needs a domain for rpId, and browsers treat localhost as a secure context.
  origin = `http://localhost:${server.address().port}`;
  return {
    origin, upstream, sessions, passkeys, stepUps, log,
    /** Ages every session's sign-in, as if it happened `ms` ago. */
    age(ms) { for (const s of sessions.values()) s.authTime -= ms; },
    close: () => { server.closeAllConnections?.(); server.close(); },
  };
}
