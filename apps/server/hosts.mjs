// One Studio inside your own app, step 2 (docs/specs/studio-embed.md section 6, issue #123): the control plane's
// side of a host, a customer's own site that mounts the Studio.
//
//   POST   /v1/hosts                         admin + step-up: register a host as a confidential OIDC client of this
//                                            issuer. The client secret is shown once and kept sealed (the issuer
//                                            compares it in plain). Its tokens are DPoP-bound like the apps'.
//   GET    /v1/hosts, DELETE /v1/hosts/{id}  admin: list, revoke (every token the host holds is revoked with it)
//   POST   /v1/teams/{team}/stream-tickets   viewer: a single-use, 60-second, read-only ticket for one team's live
//                                            stream (S8), so the host's page opens the stream here directly
//   GET    /v1/teams/{team}/events/stream?ticket=…   the stream, with the ticket as its only credential; CORS for the
//                                            minting host's own origins only, never with credentials
//
// Nothing here is reachable by an agent: sessions have no person token, and the routes are a person's (roles.mjs).
import { createHash, randomBytes } from 'node:crypto';
import { seal, unseal } from './vault.mjs';
import { Problem } from './store.mjs';

export const TICKET_SECONDS = 60;
const MAX_URIS = 5;
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const rid = (p, n) => `${p}${randomBytes(n).toString('base64url')}`;
const SEAL_TENANT = '_host';
export const HOST_ID = /^host_[A-Za-z0-9_-]{8,64}$/;

/** An https URL with no user, password or fragment, as the spec's redirect URIs must be. */
function httpsUrl(u) {
  if (typeof u !== 'string' || u.length > 500 || /\s/.test(u)) return null;
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:' || x.username || x.password || x.hash || u.includes('#')) return null;
    return x;
  } catch { return null; }
}

/** An exact https origin, as a browser sends it in Origin: scheme, host and an optional port, nothing else. */
const isOrigin = (o) => { const x = httpsUrl(o); return !!x && x.origin === o; };

export function checkHost(body, { self = null } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const problems = [];
  const name = typeof b.name === 'string' ? b.name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 100) : '';
  if (!name) problems.push('name is the host\'s name, such as "Admin at shop.example"');
  const list = (k) => (Array.isArray(b[k]) && b[k].length >= 1 && b[k].length <= MAX_URIS ? [...new Set(b[k])] : null);
  const origins = list('origins');
  if (!origins || !origins.every(isOrigin)) problems.push(`origins is a list of 1 to ${MAX_URIS} https origins, such as https://shop.example (no path)`);
  else if (self && origins.includes(self)) problems.push('a host is another site: this deployment\'s own origin cannot be one');
  const redirectUris = list('redirectUris');
  if (!redirectUris || !redirectUris.every((u) => httpsUrl(u))) problems.push(`redirectUris is a list of 1 to ${MAX_URIS} https URLs with no fragment`);
  else if (origins && !redirectUris.every((u) => origins.includes(new URL(u).origin))) problems.push('every redirect URI must be on one of the host\'s origins');
  if (problems.length) throw new Problem(400, problems.join('; '), { body: { problems } });
  return { name, origins, redirectUris };
}

const view = (r) => ({ id: r.id, clientId: r.id, name: r.name, origins: r.origins, redirectUris: r.redirect_uris, createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString(), ...(r.revoked_at ? { revokedAt: new Date(r.revoked_at).toISOString() } : {}) });

/** `tenant` is the deployment's workspace (sign-in is single-workspace); `key` the master key; `publicUrl` its origin. */
export function createHosts({ db, key, tenant, publicUrl, now = () => new Date() }) {
  const base = String(publicUrl ?? '').replace(/\/+$/, '');

  /** The issuer's view of a host (identity.mjs adapter, model Client): live hosts of this workspace only. */
  async function clientMetadata(id) {
    if (!HOST_ID.test(String(id))) return undefined;
    const [r] = await db.system('select id, secret_sealed, redirect_uris from host_clients where id = $1 and tenant = $2 and revoked_at is null', [id, tenant]);
    if (!r) return undefined;
    return {
      client_id: r.id, client_secret: unseal(key, SEAL_TENANT, r.id, r.secret_sealed), token_endpoint_auth_method: 'client_secret_basic',
      redirect_uris: r.redirect_uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], application_type: 'web',
      // Sender-constrained like the apps' tokens: the host's server holds a DPoP key, so a leaked token alone is useless.
      dpop_bound_access_tokens: true, id_token_signed_response_alg: 'ES256',
    };
  }

  return {
    clientMetadata,

    async list(t) {
      return { hosts: (await db.system('select * from host_clients where tenant = $1 order by created_at, id', [t])).map(view) };
    },

    async create(t, by, body) {
      const h = checkHost(body, { self: base ? new URL(base).origin : null });
      const id = rid('host_', 16);
      const secret = rid('hs_', 32);
      const [r] = await db.system('insert into host_clients(id, tenant, name, secret_sealed, redirect_uris, origins, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning *',
        [id, t, h.name, seal(key, SEAL_TENANT, id, secret), h.redirectUris, h.origins, by]);
      await db.system('insert into identity_audit(person, action, detail) values ($1, $2, $3)', [by, 'host.created', { host: id, name: h.name, origins: h.origins }]);
      return { ...view(r), clientSecret: secret, issuer: base, tokenAuth: 'client_secret_basic', dpop: true };
    },

    /** For the consent page: the host's name and origins, if it is live. */
    async describe(id) {
      if (!HOST_ID.test(String(id))) return null;
      const [r] = await db.system('select id, name, origins from host_clients where id = $1 and tenant = $2 and revoked_at is null', [id, tenant]);
      return r ?? null;
    },
    async linked(host, person) {
      return !!(await db.system('select 1 from host_links where host = $1 and person = $2 and revoked_at is null', [host, person])).length;
    },
    async link(host, person) {
      await db.system('insert into host_links(host, person) values ($1, $2) on conflict (host, person) do update set linked_at = now(), revoked_at = null', [host, person]);
    },
    /** GET /v1/me/hosts: the sites this person allowed. */
    async myLinks(person) {
      const rows = await db.system(`select h.id, h.name, h.origins, l.linked_at from host_links l join host_clients h on h.id = l.host
        where l.person = $1 and l.revoked_at is null and h.revoked_at is null and h.tenant = $2 order by l.linked_at, h.id`, [person, tenant]);
      return { hosts: rows.map((r) => ({ id: r.id, name: r.name, origins: r.origins, linkedAt: new Date(r.linked_at).toISOString() })) };
    },
    /** DELETE /v1/me/hosts/{host}: the person unlinks a site; its tokens and grant for them end now. */
    async unlink(person, host) {
      const [r] = await db.system('update host_links set revoked_at = now() where host = $1 and person = $2 and revoked_at is null returning host', [host, person]);
      if (!r) throw new Problem(404, 'that site is not linked to you');
      await db.system('update oauth_tokens set revoked_at = now() where client = $1 and person = $2 and revoked_at is null', [host, person]);
      await db.system("delete from oidc_store where model = 'Grant' and payload->>'clientId' = $1 and payload->>'accountId' = $2", [host, person]);
      await db.system('delete from stream_tickets where client = $1 and person = $2', [host, person]);
      await db.system('insert into identity_audit(person, action, detail) values ($1, $2, $3)', [person, 'host.unlinked', { host }]);
      return { ok: true };
    },

    async revoke(t, id, by) {
      const [r] = await db.system('update host_clients set revoked_at = coalesce(revoked_at, now()) where id = $1 and tenant = $2 returning *', [id, t]);
      if (!r) throw new Problem(404, 'no such host');
      // Everything the host holds stops working now, not when it next refreshes.
      await db.system('update oauth_tokens set revoked_at = now() where client = $1 and revoked_at is null', [id]);
      await db.system('delete from stream_tickets where client = $1', [id]);
      await db.system('insert into identity_audit(person, action, detail) values ($1, $2, $3)', [by, 'host.revoked', { host: id }]);
      return view(r);
    },

    /** POST /v1/teams/{team}/stream-tickets, for a person who may read the team (viewer and above). */
    async mintTicket(t, team, who) {
      if (who.via === 'admin') throw new Problem(400, 'a stream ticket is a signed-in person\'s; the admin token streams directly');
      const ticket = rid('stk_', 32);
      const client = who.via === 'host' ? who.client : null;
      await db.system('delete from stream_tickets where expires_at < now() - interval \'1 hour\'');
      await db.system('insert into stream_tickets(hash, tenant, team, person, client, expires_at) values ($1, $2, $3, $4, $5, $6)',
        [sha(ticket), t, team, who.principal, client, new Date(now().getTime() + TICKET_SECONDS * 1000)]);
      return { ticket, url: `${base}/v1/teams/${encodeURIComponent(team)}/events/stream?ticket=${ticket}`, expiresIn: TICKET_SECONDS };
    },

    /**
     * The stream's door (S8). Checks the Origin before the ticket is spent, then spends it: single use. Returns
     * { tenant, team, person, allowOrigin } or throws 401 or 403. `origin` is the request's Origin header, or null.
     */
    async redeem(ticket, team, origin) {
      if (typeof ticket !== 'string' || !/^stk_[A-Za-z0-9_-]{20,80}$/.test(ticket)) throw new Problem(401, 'this stream needs a fresh ticket: POST /v1/teams/{team}/stream-tickets', { type: 'unauthenticated' });
      const [peek] = await db.system('select tenant, team, client from stream_tickets where hash = $1', [sha(ticket)]);
      let allowOrigin = null;
      if (peek && origin) {
        const [h] = peek.client ? await db.system('select origins from host_clients where id = $1 and revoked_at is null', [peek.client]) : [];
        if (!h || !h.origins.includes(origin)) throw new Problem(403, 'this origin may not open the stream', { type: 'forbidden' });
        allowOrigin = origin;
      }
      const [r] = await db.system('update stream_tickets set used_at = now() where hash = $1 and used_at is null and expires_at > now() returning tenant, team, person, client', [sha(ticket)]);
      if (!r) throw new Problem(401, 'this ticket is used or expired: ask for a new one', { type: 'unauthenticated' });
      if (r.team !== team) throw new Problem(403, 'this ticket is for another team', { type: 'forbidden' });
      if (!(await this.stillMember(r.tenant, r.person, r.client))) throw new Problem(403, 'you are no longer a member of this workspace', { type: 'forbidden' });
      return { tenant: r.tenant, team: r.team, person: r.person, client: r.client, allowOrigin };
    },

    /** Whether the person still belongs to the workspace (and, for a host's ticket, the host is still live). */
    async stillMember(t, person, client = null) {
      const [m] = await db.system('select 1 from members where tenant = $1 and person = $2 and removed_at is null', [t, person]);
      if (!m) return false;
      if (client) return !!(await db.system('select 1 from host_clients h join host_links l on l.host = h.id and l.person = $2 and l.revoked_at is null where h.id = $1 and h.revoked_at is null', [client, person])).length;
      return true;
    },
  };
}
