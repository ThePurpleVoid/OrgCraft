// Signing in (docs/specs/m4-sign-in.md sections 2 and 4, ADR 0007): the deployment is its own OIDC issuer, and
// GitHub is the upstream it signs people in with. The protocol is oidc-provider's, an OpenID-Certified library
// (K1); this file is its storage adapter, its policy and the two legs of our own: the GitHub upstream and the web
// client's cookie session.
//
//   GET  /oauth/authorize?client_id=agent-team-web&return=<path>   the web start: a cookie session? → return. Else
//                                                                  the issuer's own authorize, with PKCE kept here
//   GET  /oauth/authorize?response_type=code&…                      apps and the CLI (oidc-provider), PKCE S256
//   (no session)                                                   → /sign-in?interaction=<uid> (the Studio page)
//   GET  /oauth/interaction/<uid>/github                           → GitHub, with our own state and PKCE
//   GET  /oauth/callback/github                                    member, invitee or the first owner? sign in : not-invited
//   GET  /oauth/web/done                                           the web leg's code, consumed here: sets the cookie
//   POST /oauth/token, /oauth/revoke, GET /oauth/jwks, /oauth/userinfo, /.well-known/openid-configuration (oidc-provider)
//   POST /oauth/revoke (JSON, with the cookie)                     sign out
//
// The person's GitHub token is used once, to read who they are, and never stored. Off unless the deployment
// configures it (bin.mjs: GITHUB_APP_CLIENT_ID and an https AGENT_TEAM_PUBLIC_URL), so local mode is unchanged.
import { createHash, createHmac, generateKeyPairSync, randomBytes, timingSafeEqual } from 'node:crypto';
import Provider, { interactionPolicy } from 'oidc-provider';
import { safeReturn } from '../studio/public/auth.js';
import { seal, unseal } from './vault.mjs';
import { Problem } from './store.mjs';

export { safeReturn };
export const WEB_CLIENT = 'agent-team-web';
export const COOKIE = '__Host-agent-team';
const LOGIN_COOKIE = '__Host-agent-team-login';
const UPSTREAM_COOKIE = '__Host-agent-team-upstream';
const IDLE_MS = 12 * 3600_000;
const ABSOLUTE_MS = 7 * 86400_000;
const KEY_ROTATE_MS = 90 * 86400_000;
const KEY_OVERLAP_MS = 86400_000;
const FLOW_SECONDS = 600;
const UID = /^[A-Za-z0-9_-]{1,128}$/;
const ROLES = new Set(['owner', 'admin', 'editor', 'viewer', 'approver']);

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const s256 = (v) => createHash('sha256').update(v).digest('base64url');
const rid = (p, n = 18) => `${p}${randomBytes(n).toString('base64url')}`;
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const epoch = () => Math.floor(Date.now() / 1000);

/** The request's cookies; the first of a repeated name wins. */
export function cookies(req) {
  const out = new Map();
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at < 1) continue;
    const k = part.slice(0, at).trim();
    if (!out.has(k)) out.set(k, part.slice(at + 1).trim());
  }
  return out;
}
const setCookie = (name, value, maxAge) => `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;

/** oidc-provider's storage: access and refresh tokens in oauth_tokens, everything else in oidc_store, all by hash. */
function adapterFor(db) {
  const TOKENS = { AccessToken: 'access', RefreshToken: 'refresh' };
  return class Adapter {
    constructor(name) { this.name = name; this.kind = TOKENS[name]; }

    async upsert(id, payload, expiresIn) {
      const exp = new Date(Date.now() + (expiresIn ?? 3600) * 1000);
      if (this.kind) {
        await db.system(`insert into oauth_tokens(hash, kind, person, client, session, family, device, payload, expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          on conflict (hash) do update set payload = excluded.payload, expires_at = excluded.expires_at`,
        [sha(id), this.kind, payload.accountId ?? null, payload.clientId ?? '', payload.sessionUid ?? null, payload.grantId ?? null, payload.jkt ?? null, payload, exp]);
        return;
      }
      await db.system(`insert into oidc_store(model, id_hash, payload, grant_id, uid, expires_at) values ($1, $2, $3, $4, $5, $6)
        on conflict (model, id_hash) do update set payload = excluded.payload, grant_id = excluded.grant_id, uid = excluded.uid, expires_at = excluded.expires_at`,
      [this.name, sha(id), payload, payload.grantId ?? null, payload.uid ?? null, exp]);
    }

    async find(id) {
      const [r] = this.kind
        ? await db.system('select payload, used_at as consumed from oauth_tokens where hash = $1 and revoked_at is null and expires_at > now()', [sha(id)])
        : await db.system('select payload, consumed_at as consumed from oidc_store where model = $1 and id_hash = $2 and (expires_at is null or expires_at > now())', [this.name, sha(id)]);
      return r ? { ...r.payload, ...(r.consumed ? { consumed: Math.floor(new Date(r.consumed).getTime() / 1000) } : {}) } : undefined;
    }

    async findByUid(uid) {
      const [r] = await db.system('select payload, consumed_at as consumed from oidc_store where model = $1 and uid = $2 and (expires_at is null or expires_at > now())', [this.name, uid]);
      return r ? { ...r.payload, ...(r.consumed ? { consumed: Math.floor(new Date(r.consumed).getTime() / 1000) } : {}) } : undefined;
    }

    async findByUserCode() { return undefined; }

    async consume(id) {
      if (this.kind) await db.system('update oauth_tokens set used_at = now() where hash = $1 and used_at is null', [sha(id)]);
      else await db.system('update oidc_store set consumed_at = now() where model = $1 and id_hash = $2 and consumed_at is null', [this.name, sha(id)]);
    }

    async destroy(id) {
      // A token row stays, revoked, so a reuse can still be recognised and audited.
      if (this.kind) await db.system('update oauth_tokens set revoked_at = coalesce(revoked_at, now()) where hash = $1', [sha(id)]);
      else await db.system('delete from oidc_store where model = $1 and id_hash = $2', [this.name, sha(id)]);
    }

    async revokeByGrantId(grantId) {
      if (this.kind) await db.system('update oauth_tokens set revoked_at = now() where family = $1 and kind = $2 and revoked_at is null', [grantId, this.kind]);
      else await db.system('delete from oidc_store where model = $1 and grant_id = $2', [this.name, grantId]);
    }
  };
}

/** The issuer's signing keys: made on first start, sealed in the vault, rotated every 90 days, the old one kept a day. */
export async function issuerKeys(db, key, now = () => new Date()) {
  return db.systemTx(async ({ q }) => {
    await q('select pg_advisory_xact_lock(4852)');
    const t = now().getTime();
    let rows = await q('select kid, sealed, created_at, retired_at from issuer_keys where retired_at is null or retired_at > $1 order by created_at desc', [new Date(t - KEY_OVERLAP_MS)]);
    const current = rows.find((r) => !r.retired_at);
    if (!current || t - new Date(current.created_at).getTime() > KEY_ROTATE_MS) {
      const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const kid = rid('k_', 12);
      const jwk = { ...privateKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' };
      await q('update issuer_keys set retired_at = $1 where retired_at is null', [new Date(t)]);
      await q('insert into issuer_keys(kid, sealed, created_at) values ($1, $2, $3)', [kid, seal(key, '_issuer', kid, JSON.stringify(jwk)), new Date(t)]);
      rows = await q('select kid, sealed, created_at, retired_at from issuer_keys where retired_at is null or retired_at > $1 order by created_at desc', [new Date(t - KEY_OVERLAP_MS)]);
    }
    return rows.map((r) => JSON.parse(unseal(key, '_issuer', r.kid, r.sealed)));
  });
}

/** GitHub as the upstream: the deployment's GitHub App's user authorization flow, identity only (no scope). */
export function githubUpstream({ clientId, clientSecret, url = 'https://github.com', apiUrl = 'https://api.github.com', fetch = globalThis.fetch }) {
  if (!clientId || !clientSecret) throw new Error('GitHub sign-in needs GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET');
  const base = url.replace(/\/+$/, ''), api = apiUrl.replace(/\/+$/, '');
  return {
    authorizeUrl({ state, challenge, redirectUri }) {
      const u = new URL(`${base}/login/oauth/authorize`);
      for (const [k, v] of Object.entries({ client_id: clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256', allow_signup: 'false' })) u.searchParams.set(k, v);
      return u.href;
    },
    /** A GitHub login or numeric id → { subject, login }, or null when GitHub has no such user. Public data only. */
    async lookup(who) {
      const path = /^[0-9]+$/.test(who) ? `user/${who}` : `users/${encodeURIComponent(who)}`;
      const r = await fetch(`${api}/${path}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'agent-team-server' }, signal: AbortSignal.timeout(10_000) });
      if (r.status === 404) return null;
      const u = await r.json().catch(() => ({}));
      if (!r.ok || !Number.isSafeInteger(u.id) || u.id <= 0 || typeof u.login !== 'string') throw new Problem(502, 'GitHub did not answer the user lookup; try again');
      return { subject: String(u.id), login: u.login.slice(0, 100) };
    },
    /** Trades the code for a token, reads who the person is, and drops the token. */
    async identify({ code, verifier, redirectUri }) {
      const signal = AbortSignal.timeout(10_000);
      const r = await fetch(`${base}/login/oauth/access_token`, { method: 'POST', signal, headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, code_verifier: verifier }) });
      const tok = await r.json().catch(() => ({}));
      if (!r.ok || typeof tok.access_token !== 'string') throw new Error('GitHub did not accept the code');
      const headers = { authorization: `Bearer ${tok.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'agent-team-server' };
      const ur = await fetch(`${api}/user`, { headers, signal });
      const u = await ur.json().catch(() => ({}));
      if (!ur.ok || !Number.isSafeInteger(u.id) || u.id <= 0 || typeof u.login !== 'string') throw new Error('GitHub did not say who signed in');
      let email = null;
      try {
        const er = await fetch(`${api}/user/emails`, { headers, signal });
        if (er.ok) {
          const list = await er.json();
          const primary = Array.isArray(list) ? list.find((e) => e?.primary === true && e?.verified === true && typeof e.email === 'string') : null;
          email = primary ? primary.email.toLowerCase() : null;
        }
      } catch { /* no email permission: invitations by user id still work */ }
      return { provider: 'github', subject: String(u.id), login: u.login.slice(0, 100), name: typeof u.name === 'string' ? u.name.slice(0, 200) : null, email };
    },
  };
}

/**
 * The apps and the CLI, with their exact redirect URIs (S4): the phone apps on Universal Links and App Links on the
 * deployment's own host, never custom schemes; the CLI on a loopback redirect (RFC 8252, any port).
 */
export const nativeClients = (origin) => [
  { client_id: 'agent-team-ios', redirect_uris: [`${origin}/app/ios/callback`] },
  { client_id: 'agent-team-android', redirect_uris: [`${origin}/app/android/callback`] },
  { client_id: 'agent-team-cli', redirect_uris: ['http://127.0.0.1/callback'] },
];

/** The library's prompts, less the consent screen it forces on native apps: every client here is the deployment's own. */
function firstPartyPolicy() {
  const policy = interactionPolicy.base();
  policy.get('consent').checks.remove('native_client_prompt');
  return policy;
}

/**
 * Who is calling, for rate limits, from what our own proxies say and nothing a client can write.
 *
 * x-forwarded-for is read from the right: each proxy we run appends the peer it saw, so with `hops` proxies in front
 * of the server (Fly's is 1), the entry `hops` from the right is the real peer. A request that also carries the edge
 * secret came through our Vercel rewrite, whose own entry sits one further left, so that is the caller. Anything a
 * client puts in the header lands to the left of those and is never read. With no hops configured, the socket address.
 */
/** Whether a request came through our edge: it carries the edge secret (constant-time compared). */
export const viaEdge = (req, { hops = 0, edgeSecret = null, edgeHeader = 'x-agent-team-edge' } = {}) => !!edgeSecret && hops > 0 && same(req.headers[edgeHeader] ?? '', edgeSecret);

export function callerIp(req, proxy = {}) {
  const { hops = 0 } = proxy;
  const list = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const n = hops > 0 ? hops + (viaEdge(req, proxy) ? 1 : 0) : 0;
  const ip = n > 0 && list.length >= n ? list[list.length - n] : '';
  return (ip || req.socket?.remoteAddress || '').slice(0, 64);
}

/** Requests per IP and minute on /oauth/* (S8): authorize 20, everything else 60. */
function limiter(now) {
  const hits = new Map();
  return (ip, bucket, max) => {
    const t = now().getTime(), k = `${bucket}|${ip}`;
    const list = (hits.get(k) ?? []).filter((x) => t - x < 60_000);
    if (list.length >= max) { hits.set(k, list); return true; }
    list.push(t);
    if (!hits.has(k) && hits.size > 50_000) hits.clear();
    hits.set(k, list);
    return false;
  };
}

/**
 * The issuer. `publicUrl` is the issuer and the cookie origin (https). `tenant` is the workspace the first owner is
 * made in. `ownerGithub` is the first owner's numeric GitHub user id, read only while the deployment has no members.
 * `upstream` is githubUpstream(...) (or a stub with the same two methods). `clients` adds apps and the CLI:
 * [{ client_id, redirect_uris, application_type: 'native' }]. `proxy` is { hops, edgeSecret } (callerIp), and
 * `clientIp(req)` names the caller for rate limits. There is no global cap: one would be a bucket anyone could empty for everyone (security review, #73);
 * floods are for the host's concurrency limits and the edge. `configure(config)` returns the library configuration
 * to use instead: only the OpenID conformance harness (conformance/op.mjs) passes it; the server never does.
 */
export async function createIdentity({ db, key, publicUrl, tenant, ownerGithub = null, upstream, clients = null, now = () => new Date(), proxy = {}, clientIp = (req) => callerIp(req, proxy), configure = null }) {
  const issuer = new URL(publicUrl);
  if (issuer.protocol !== 'https:') throw new Error('sign-in needs an https AGENT_TEAM_PUBLIC_URL (the cookie is Secure and __Host-)');
  if (issuer.pathname !== '/' || issuer.search || issuer.hash) throw new Error('AGENT_TEAM_PUBLIC_URL must be an origin with no path for sign-in');
  if (ownerGithub !== null && ownerGithub !== '' && !/^[0-9]{1,20}$/.test(String(ownerGithub))) throw new Error('AGENT_TEAM_OWNER_GITHUB is the numeric GitHub user id (https://api.github.com/users/<login> shows it), not a login');
  const origin = issuer.origin;
  const webRedirect = `${origin}/oauth/web/done`;
  const githubRedirect = `${origin}/oauth/callback/github`;
  const limited = limiter(now);

  async function audit(person, action, detail = {}) {
    await db.system('insert into identity_audit(person, action, detail) values ($1, $2, $3)', [person, action, detail]);
  }

  /** A short-lived record of ours (the web leg, the upstream leg), single use. */
  const flow = {
    put: (model, id, payload) => db.system('insert into oidc_store(model, id_hash, payload, expires_at) values ($1, $2, $3, $4)', [model, sha(id), payload, new Date(Date.now() + FLOW_SECONDS * 1000)]),
    take: async (model, id) => (await db.system('delete from oidc_store where model = $1 and id_hash = $2 and expires_at > now() returning payload', [model, sha(id)]))[0]?.payload ?? null,
  };

  async function activePerson(id) {
    const [p] = await db.system(`select p.id, p.login, p.name from people p where p.id = $1
      and exists (select 1 from members m where m.person = p.id and m.removed_at is null)`, [id]);
    return p ?? null;
  }

  async function loadExistingGrant(ctx) {
    const { oidc } = ctx;
    const grantId = oidc.result?.consent?.grantId || oidc.session.grantIdFor(oidc.client.clientId);
    if (grantId) {
      const found = await oidc.provider.Grant.find(grantId);
      if (found) return found;
    }
    // Every client is first-party: there is no consent screen, the grant is what was asked for (openid, profile,
    // offline_access for apps) and nothing more.
    const grant = new oidc.provider.Grant({ clientId: oidc.client.clientId, accountId: oidc.session.accountId });
    grant.addOIDCScope([...oidc.requestParamOIDCScopes].join(' '));
    await grant.save();
    return grant;
  }

  const web = { client_id: WEB_CLIENT, token_endpoint_auth_method: 'none', redirect_uris: [webRedirect], grant_types: ['authorization_code'], response_types: ['code'] };
  const natives = (clients ?? nativeClients(origin)).map((c) => ({ token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], application_type: 'native', dpop_bound_access_tokens: true, require_auth_time: true, ...c }));
  let provider, callback, kids = '';
  /** (Re)builds the library around the current signing keys: at start, and when the tick rotates them. */
  const build = (keys) => {
    kids = keys.map((k) => k.kid).join(',');
    provider = makeProvider(keys);
    callback = provider.callback();
  };
  const makeProvider = (keys) => {
    const config = {
      adapter: adapterFor(db),
      clients: [web, ...natives],
      // ES256 only: the issuer's key is P-256 (section 2, step 4).
      clientDefaults: { id_token_signed_response_alg: 'ES256', grant_types: ['authorization_code'], response_types: ['code'] },
      enabledJWA: { idTokenSigningAlgValues: ['ES256'], dPoPSigningAlgValues: ['ES256', 'EdDSA'] },
      jwks: { keys },
      cookies: {
        keys: [createHmac('sha256', key).update('agent-team/oidc-cookies/v1').digest('base64url')],
        long: { httpOnly: true, sameSite: 'lax', secure: true },
        short: { httpOnly: true, sameSite: 'lax', secure: true },
      },
      async findAccount(_ctx, sub) {
        const p = await activePerson(sub);
        return p ? { accountId: p.id, claims: () => ({ sub: p.id, name: p.name ?? p.login, preferred_username: p.login }) } : undefined;
      },
      claims: { openid: ['sub'], profile: ['name', 'preferred_username'] },
      scopes: ['openid', 'profile', 'offline_access'],
      responseTypes: ['code'],
      pkce: { required: () => true },
      features: {
        devInteractions: { enabled: false },
        revocation: { enabled: true },
        userinfo: { enabled: true },
        dPoP: { enabled: true },
        rpInitiatedLogout: { enabled: false },
        introspection: { enabled: false },
      },
      // Apps' refresh tokens come with the refresh_token grant (no offline_access dance), rotate on every use, and are
      // bound to the device's DPoP key (S3): a reused one revokes the family, a stolen one without the key is refused.
      issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed('refresh_token'),
      rotateRefreshToken: true,
      ttl: { AccessToken: 900, AuthorizationCode: 60, IdToken: 900, Interaction: FLOW_SECONDS, Session: 12 * 3600, Grant: 30 * 86400, RefreshToken: 30 * 86400 },
      interactions: { policy: firstPartyPolicy(), url: (_ctx, interaction) => `/sign-in?interaction=${interaction.uid}` },
      loadExistingGrant,
      clientBasedCORS: () => false,
      routes: { authorization: '/oauth/authorize', token: '/oauth/token', jwks: '/oauth/jwks', userinfo: '/oauth/userinfo', revocation: '/oauth/revoke', end_session: '/oauth/session/end', introspection: '/oauth/introspect', registration: '/oauth/reg', pushed_authorization_request: '/oauth/par', code_verification: '/oauth/device', device_authorization: '/oauth/device/auth', backchannel_authentication: '/oauth/backchannel', challenge: '/oauth/challenge', credential: '/oauth/credential' },
      async renderError(ctx, out) {
        ctx.type = 'text/plain; charset=utf-8';
        ctx.body = `Sign-in failed: ${String(out.error ?? 'error').replace(/[^\w .,:;'()-]/g, '')}${out.error_description ? ` (${String(out.error_description).replace(/[^\w .,:;'()-]/g, '').slice(0, 300)})` : ''}`;
      },
    };
    const p = new Provider(origin, configure ? configure(config) : config);
    // TLS ends at the deployment's proxy, and the issuer is fixed by config: tell the library the scheme ourselves,
    // and never let a request's forwarded host name the issuer.
    p.proxy = true;
    p.on('grant.revoked', (ctx, grantId) => {
      const reuse = ctx.oidc?.route === 'token' && ctx.oidc?.params?.grant_type === 'refresh_token';
      audit(ctx.oidc?.entities?.Account?.accountId ?? null, reuse ? 'refresh-token.reused' : 'grant.revoked', { grant: grantId, client: ctx.oidc?.client?.clientId ?? null }).catch(() => {});
    });
    return p;
  };
  build(await issuerKeys(db, key, now));

  /** Lets a person in, or not (spec section 2, step 3): a member, an invitee, or the first owner of a fresh deployment. */
  async function admit(who) {
    return db.systemTx(async ({ q }) => {
      await q('select pg_advisory_xact_lock(4851)');
      const at = now();
      const [known] = await q('select id from people where provider = $1 and subject = $2', [who.provider, who.subject]);
      const active = known ? await q('select tenant from members where person = $1 and removed_at is null', [known.id]) : [];
      const invites = await q(`select id, tenant, role from invitations where provider = $1 and accepted_at is null and expires_at > $2
        and (subject = $3 or ($4::text is not null and email is not null and lower(email) = $4)) for update`, [who.provider, at, who.subject, who.email]);
      let owner = false;
      if (!active.length && !invites.length) {
        if (ownerGithub && who.provider === 'github' && who.subject === String(ownerGithub)) owner = Number((await q('select count(*)::int as n from members where removed_at is null'))[0].n) === 0;
        if (!owner) return null;
      }
      const [p] = await q(`insert into people(id, provider, subject, login, name, email) values ($1, $2, $3, $4, $5, $6)
        on conflict (provider, subject) do update set login = excluded.login, name = excluded.name, email = excluded.email returning id`,
      [known?.id ?? rid('per_', 12), who.provider, who.subject, who.login, who.name, who.email]);
      const join = (t, role) => q(`insert into members(id, tenant, person, role) values ($1, $2, $3, $4)
        on conflict (tenant, person) do update set role = excluded.role, removed_at = null, created_at = now() where members.removed_at is not null`, [rid('mem_', 12), t, p.id, role]);
      if (owner) await join(tenant, 'owner');
      for (const inv of invites) {
        if (!ROLES.has(inv.role)) continue;
        await join(inv.tenant, inv.role);
        await q('update invitations set accepted_at = $1, accepted_by = $2 where id = $3', [at, p.id, inv.id]);
      }
      await q('insert into identity_audit(person, action, detail) values ($1, $2, $3)', [p.id, 'sign-in', { owner, invitations: invites.map((i) => i.id) }]);
      return { id: p.id };
    });
  }

  /** The web cookie's session, if it is live: not revoked, under 7 days old, used within 12 hours. */
  async function sessionOf(req) {
    const sid = cookies(req).get(COOKIE);
    if (!sid || sid.length > 128) return null;
    const t = now();
    const [s] = await db.system(`select s.id_hash, s.person, s.auth_time, s.last_seen, p.login, p.name from person_sessions s join people p on p.id = s.person
      where s.id_hash = $1 and s.revoked_at is null and s.expires_at > $2 and s.last_seen > $3`, [sha(sid), t, new Date(t.getTime() - IDLE_MS)]);
    if (!s) return null;
    if (t.getTime() - new Date(s.last_seen).getTime() > 60_000) await db.system('update person_sessions set last_seen = $1 where id_hash = $2', [t, s.id_hash]);
    return { person: s.person, login: s.login, name: s.name, authTime: new Date(s.auth_time).toISOString(), session: s.id_hash };
  }

  /** The workspaces a person is in: the one cross-tenant read, tenant ids and roles only. */
  const workspaces = (person) => db.system('select tenant, role from members where person = $1 and removed_at is null order by tenant', [person]);

  const redirect = (res, to, setCookies = []) => {
    res.writeHead(303, { location: to, 'cache-control': 'no-store', ...(setCookies.length ? { 'set-cookie': setCookies } : {}) });
    res.end();
  };
  const toSignIn = (res, error, setCookies) => redirect(res, `/sign-in?error=${error}`, setCookies);

  /** CSRF for a cookie request (section 2): an unsafe method needs this deployment's Origin and a JSON body. */
  function csrfOk(req) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
    return req.headers.origin === origin && /^application\/json\b/i.test(req.headers['content-type'] ?? '');
  }

  async function webStart(req, res, url) {
    const back = safeReturn(url.searchParams.get('return') ?? '/');
    if (await sessionOf(req)) return redirect(res, back);
    const state = rid('', 24), verifier = randomBytes(32).toString('base64url'), nonce = rid('', 16);
    await flow.put('WebLogin', state, { return: back, verifier, nonce });
    const u = new URL(`${origin}/oauth/authorize`);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: WEB_CLIENT, redirect_uri: webRedirect, scope: 'openid', state, nonce, code_challenge: s256(verifier), code_challenge_method: 'S256' })) u.searchParams.set(k, v);
    return redirect(res, u.pathname + u.search, [setCookie(LOGIN_COOKIE, state, FLOW_SECONDS)]);
  }

  async function upstreamStart(req, res, uid) {
    if (!UID.test(uid)) return toSignIn(res, 'expired');
    const interaction = await provider.Interaction.find(uid);
    if (!interaction) return toSignIn(res, 'expired');
    const state = rid('', 24), verifier = randomBytes(32).toString('base64url');
    await flow.put('Upstream', state, { uid, verifier });
    return redirect(res, upstream.authorizeUrl({ state, challenge: s256(verifier), redirectUri: githubRedirect }), [setCookie(UPSTREAM_COOKIE, state, FLOW_SECONDS)]);
  }

  async function upstreamDone(req, res, url) {
    const clear = [setCookie(UPSTREAM_COOKIE, '', 0)];
    const state = url.searchParams.get('state') ?? '', mine = cookies(req).get(UPSTREAM_COOKIE) ?? '';
    // The browser that started this sign-in must be the one finishing it, and each state works once.
    if (!state || !mine || !same(state, mine)) return toSignIn(res, 'expired', clear);
    const leg = await flow.take('Upstream', state);
    if (!leg) return toSignIn(res, 'expired', clear);
    if (url.searchParams.get('error') || !url.searchParams.get('code')) return toSignIn(res, 'denied', clear);
    const interaction = await provider.Interaction.find(leg.uid);
    if (!interaction) return toSignIn(res, 'expired', clear);
    let who;
    try { who = await upstream.identify({ code: url.searchParams.get('code'), verifier: leg.verifier, redirectUri: githubRedirect }); } catch { return toSignIn(res, 'denied', clear); }
    const person = await admit(who);
    if (!person) {
      await audit(null, 'sign-in.refused', { provider: who.provider, subject: who.subject });
      return toSignIn(res, 'not-invited', clear);
    }
    interaction.result = { login: { accountId: person.id, amr: [who.provider], remember: false } };
    await interaction.save(Math.max(1, interaction.exp - epoch()));
    return redirect(res, interaction.returnTo, clear);
  }

  async function webDone(req, res, url) {
    const clear = [setCookie(LOGIN_COOKIE, '', 0)];
    const state = url.searchParams.get('state') ?? '', mine = cookies(req).get(LOGIN_COOKIE) ?? '';
    if (!state || !mine || !same(state, mine)) return toSignIn(res, 'expired', clear);
    const leg = await flow.take('WebLogin', state);
    if (!leg) return toSignIn(res, 'expired', clear);
    if (url.searchParams.get('error')) return toSignIn(res, url.searchParams.get('error') === 'access_denied' ? 'denied' : 'expired', clear);
    const code = await provider.AuthorizationCode.find(url.searchParams.get('code') ?? '');
    const ok = code && !code.consumed && !code.isExpired && code.clientId === WEB_CLIENT && code.redirectUri === webRedirect
      && code.codeChallengeMethod === 'S256' && typeof code.codeChallenge === 'string' && same(code.codeChallenge, s256(leg.verifier)) && code.nonce === leg.nonce;
    if (!ok) return toSignIn(res, 'expired', clear);
    await code.consume();
    // The web's session is the cookie set below, nothing else: the issuer's own sign-in state and the grant behind
    // this code end here, so an expired or revoked cookie always means signing in through GitHub again.
    const issuerSession = cookies(req).get('_session');
    if (issuerSession) await db.system("delete from oidc_store where model = 'Session' and id_hash = $1", [sha(issuerSession)]);
    if (code.grantId) await provider.Grant.adapter.destroy(code.grantId);
    clear.push('_session=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; secure; httponly; samesite=lax', '_session.sig=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; secure; httponly; samesite=lax');
    const person = await activePerson(code.accountId);
    if (!person) return toSignIn(res, 'not-invited', clear);
    const sid = randomBytes(32).toString('base64url');
    const t = now();
    await db.system('insert into person_sessions(id_hash, person, client, auth_time, amr, created_at, last_seen, expires_at) values ($1, $2, $3, $4, $5, $6, $6, $7)',
      [sha(sid), person.id, WEB_CLIENT, new Date((code.authTime ?? epoch()) * 1000), code.amr ?? [], t, new Date(t.getTime() + ABSOLUTE_MS)]);
    return redirect(res, safeReturn(leg.return), [...clear, setCookie(COOKIE, sid, ABSOLUTE_MS / 1000)]);
  }

  /** Signing out of the web: the cookie's session, and the issuer's own sessions and web grants for the person. */
  async function signOut(req, res) {
    if (!csrfOk(req)) throw new Problem(403, 'cross-site request refused: send this deployment\'s Origin and content-type: application/json');
    const s = await sessionOf(req);
    if (s) await endSessions(s.person, { only: s.session });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': [setCookie(COOKIE, '', 0)] });
    res.end('{}');
  }

  /** Ends a person's web session (or all of them), their sign-in state at the issuer, and (all) their tokens. */
  async function endSessions(person, { only = null } = {}) {
    if (only) await db.system('update person_sessions set revoked_at = now() where id_hash = $1 and revoked_at is null', [only]);
    else {
      await db.system('update person_sessions set revoked_at = now() where person = $1 and revoked_at is null', [person]);
      await db.system('update oauth_tokens set revoked_at = now() where person = $1 and revoked_at is null', [person]);
      // Signed out everywhere (removed from their last workspace, or by request): their team email addresses go in
      // every workspace too, so nothing about a team reaches someone with no way in (security review of #101). They
      // add and verify an address again when they come back.
      await db.system('delete from email_subscriptions where principal = $1', [person]);
    }
    await db.system("delete from oidc_store where model in ('Session', 'Grant') and payload->>'accountId' = $1 and (model = 'Session' or payload->>'clientId' = $2 or $3::boolean)", [person, WEB_CLIENT, !only]);
    await audit(person, only ? 'sign-out' : 'sessions.ended', {});
  }

  /** Handles /oauth/* and /.well-known/openid-configuration; false for anything else. */
  async function handle(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith('/oauth/') && p !== '/.well-known/openid-configuration') return false;
    const authorize = p === '/oauth/authorize';
    if (limited(clientIp(req), authorize ? 'authorize' : 'oauth', authorize ? 20 : 60)) throw new Problem(429, 'too many sign-in requests from here; try again in a minute');
    if (authorize && req.method === 'GET' && url.searchParams.get('client_id') === WEB_CLIENT && !url.searchParams.has('response_type')) { await webStart(req, res, url); return true; }
    const inter = /^\/oauth\/interaction\/([^/]+)\/github$/.exec(p);
    if (inter && req.method === 'GET') { await upstreamStart(req, res, inter[1]); return true; }
    if (p === '/oauth/callback/github' && req.method === 'GET') { await upstreamDone(req, res, url); return true; }
    if (p === '/oauth/web/done' && req.method === 'GET') { await webDone(req, res, url); return true; }
    if (p === '/oauth/revoke' && req.method === 'POST' && /^application\/json\b/i.test(req.headers['content-type'] ?? '')) { await signOut(req, res); return true; }
    req.headers['x-forwarded-proto'] = 'https';
    req.headers.host = issuer.host;
    delete req.headers['x-forwarded-host'];
    await callback(req, res);
    return true;
  }

  /** Forgets expired records (the tick calls it). */
  async function sweep() {
    // Rotation is due every 90 days: a server that runs that long picks up its new key here, and keeps the old one in
    // the JWKS for a day.
    const keys = await issuerKeys(db, key, now);
    if (keys.map((k) => k.kid).join(',') !== kids) build(keys);
    await db.system("delete from oidc_store where expires_at < now() - interval '1 hour'");
    await db.system("delete from oauth_tokens where expires_at < now() - interval '1 day'");
  }

  /** What the deploy smoke check reads (GET /v1/internal/caller): the caller as the limits see it, and the edge. */
  const caller = (req) => ({ ip: clientIp(req), edge: viaEdge(req, proxy) });

  return { get provider() { return provider; }, caller, handle, sessionOf, workspaces, csrfOk, endSessions, sweep, origin, admit, lookup: (who) => upstream.lookup(who) };
}
