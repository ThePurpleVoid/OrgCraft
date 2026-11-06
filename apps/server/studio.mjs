// The deployment's own Studio page: hosted mode (docs/specs/studio-embed.md section 1, the third row). The same
// handler as a mounted host's, served under /v1/teams/{team}/studio/, signed in by this deployment (ADR 0007) and
// publishing with the deployment's M4 GitHub App. Off until the app exists: every route then answers "the GitHub App
// is not connected yet".
//
// The app's private key mints tokens for every installation, that is every customer, so a token is only ever minted
// for an installation this tenant has proven it owns (S9), looked up fresh from GitHub before every write, and scoped
// to the one repository with contents, pull requests and metadata. Each customer gets its own blob cache and its own
// temp folder for planning (S3).
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioHandler } from '../studio/handler.mjs';
import { githubApp, InstallationError } from '../../packages/github-app/index.mjs';
import { blobCache } from '../studio/github.mjs';
import { atLeast } from './roles.mjs';

const PERMISSIONS = { contents: 'write', pull_requests: 'write', metadata: 'read' };
const STUDIO_ROLE = { read: 'viewer', publish: 'editor', 'publish-code': 'admin' };
// Delegated publish (studio-embed.md section 6): per host, across all its users (security D4, C5). One instance keeps
// these in memory; a deployment with several instances multiplies them by its instance count.
const HOST_LIMITS = { publish: { limit: 10, windowMs: 10 * 60_000 }, work: { limit: 60, windowMs: 60_000 } };

const HOST_WORK = /\/v1\/team\/(preview|suggestions|graph|from-template)$/;
/** The host's own user, as its server says (x-agent-team-host-user): shown in the PR and the audit, never trusted. */
const hostUserOf = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) : '') || null;

class StudioRefusal extends Error {
  constructor(status, message, type = null) { super(message); this.status = status; this.type = type; }
}

/**
 * opts: { appId, privateKey, teamRepo(tenant, team) → 'owner/name' | null, boundInstallations(tenant) → [ids],
 * origin (this deployment's page origin), api, fetch, tmpRoot, audit(row) (the deployment's audit table),
 * logger(entry), limiter, hosts: { consented(host, person), nameOf(host) } (delegated publish) }. Returns { enabled, handle(req, who, team, rawBody), tokenFor }.
 */
export function createHostedStudio(opts = null) {
  const enabled = Boolean(opts?.appId && opts?.privateKey && opts?.teamRepo && opts?.boundInstallations && opts?.origin);
  const api = String(opts?.api ?? 'https://api.github.com').replace(/\/+$/, '');
  const fetchImpl = opts?.fetch ?? globalThis.fetch;
  const audit = async (row) => { try { await (opts?.audit ?? ((e) => console.info(JSON.stringify(e))))(row); } catch (e) { console.error(`studio audit: ${e.message}`); } };
  const root = opts?.tmpRoot ?? join(tmpdir(), 'agent-team-hosted-studio');
  const handlers = new Map();
  const caches = new Map();
  const windows = new Map();
  const limits = { ...HOST_LIMITS, ...(opts?.hostLimits ?? {}) };
  /** A sliding window per host and kind; true when this call fits. */
  const fits = (key, { limit, windowMs }) => {
    const t = Date.now();
    const hits = (windows.get(key) ?? []).filter((x) => t - x < windowMs);
    if (hits.length >= limit) { windows.set(key, hits); return false; }
    hits.push(t); windows.set(key, hits);
    if (windows.size > 10_000) windows.delete(windows.keys().next().value);
    return true;
  };

  // The installation lookup, the S9 check and the scoped, cached token: the kit's one GitHub App (packages/github-app),
  // the same rules as the runner's merger app.
  const app = enabled ? githubApp({ appId: opts.appId, privateKey: opts.privateKey, api, fetch: fetchImpl, userAgent: 'agent-team-studio' }) : null;

  /**
   * A token for one repository of this tenant, or a refusal that names why (S9): the installation is looked up fresh
   * for a write and at most five minutes old for a read, and one not bound to the tenant is refused and audited.
   */
  async function tokenFor(tenant, slug, { write, actor = null, team = null }) {
    const bound = (await opts.boundInstallations(tenant)).map(Number);
    try {
      return await app.tokenFor(slug, bound, { permissions: PERMISSIONS, fresh: write });
    } catch (e) {
      if (e instanceof InstallationError) {
        await audit({ tenant, team, actorId: actor, action: 'publish', target: slug, decision: 'refused', rule: 'installation', detail: { reason: e.message } });
        throw new StudioRefusal(403, `the GitHub App installation that holds ${slug} is not connected to this workspace`, 'installation');
      }
      throw new StudioRefusal(502, `GitHub did not give the app a token for ${slug}`);
    }
  }

  /** One handler per tenant, team and repository, each with that tenant's cache and temp folder (S3). */
  function handlerFor(tenant, team, slug) {
    const k = `${tenant}\u0000${team}\u0000${slug}`;
    if (handlers.has(k)) return handlers.get(k);
    if (!caches.has(tenant)) caches.set(tenant, blobCache());
    const customer = createHash('sha256').update(String(tenant)).digest('hex').slice(0, 32);
    // Who is asking, per request, from the deployment's own sign-in (set in handle()).
    const callers = new WeakMap();
    const handler = createStudioHandler({
      repo: slug,
      basePath: `/v1/teams/${encodeURIComponent(team)}/studio`,
      allowedOrigins: [opts.origin],
      authorize: async (request, action) => {
        const who = callers.get(request);
        if (!who || !atLeast(who.role, STUDIO_ROLE[action])) return null;
        // A host's token never carries step-up, so a change to commands the team runs is never published through one,
        // whatever the person's role: it needs this deployment's own Studio (CTO and security, D2).
        if (who.via === 'host' && action === 'publish-code') return null;
        return { id: String(who.principal), name: who.session?.name || who.session?.login || 'a workspace admin', ...(who.via === 'host' ? { via: { host: who.hostName ?? who.client, user: who.hostUser, hostId: who.client } } : {}) };
      },
      // handle() already checked the installation (fresh for a write), so the lookup and token here are that one's.
      getInstallationToken: async () => tokenFor(tenant, slug, { write: false }),
      // Only the blob cache's key (one cache per tenant already); the installation itself is checked in tokenFor().
      installationId: String(tenant),
      cache: caches.get(tenant),
      tmpRoot: join(root, customer),
      limiter: opts.limiter ?? null,
      // The publish line (E9) goes to the deployment's audit table, with the other audit rows.
      logger: (e) => {
        if (e?.event === 'agent-team-studio.publish') return audit({ tenant, team, actorId: e.user, action: 'publish', target: e.branch, decision: 'allowed', detail: { repo: slug, commit: e.commit, pr: e.pr, files: e.files, ...(e.via ? { host: e.via.hostId, hostName: e.via.host, hostUser: e.via.user ?? null } : {}) } });
        return (opts.logger ?? ((x) => console.info(JSON.stringify(x))))({ ...e, tenant, team });
      },
      api,
      fetch: fetchImpl,
    });
    const entry = { handler, callers };
    handlers.set(k, entry);
    return entry;
  }

  const answer = (status, error, type) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: Buffer.from(JSON.stringify({ error, ...(type ? { type } : {}) })) });

  /**
   * One request under /v1/teams/{team}/studio/ for a signed-in member `who` (the route's role already checked), with
   * its body already read. Returns { status, headers, body } for the server to send (inside idempotent() for writes).
   */
  async function handle(req, who, team, rawBody = null) {
    if (!enabled) return answer(503, 'the GitHub App is not connected yet');
    let slug;
    try { slug = await opts.teamRepo(who.tenant, team); } catch { slug = null; }
    if (!slug || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(slug)) return answer(409, 'this team has no GitHub repository connected yet', 'no-repo');
    const url = new URL(req.url, opts.origin);
    const writes = req.method === 'POST' && url.pathname.endsWith('/v1/team/publish');
    const viaHost = who.via === 'host';
    if (viaHost) {
      const refuse = async (status, message, type, rule) => {
        await audit({ tenant: who.tenant, team, actorId: String(who.principal), action: writes ? 'publish' : 'studio', target: slug, decision: 'refused', rule, detail: { host: who.client } });
        return { ...answer(status, message, type), ...(status === 429 ? { headers: { ...answer(status, message, type).headers, 'retry-after': '60' } } : {}) };
      };
      // C2: publishing needs the person's yes on the consent text that says the host can open pull requests.
      if (writes && !(await opts.hosts?.consented?.(who.client, who.principal))) return refuse(403, 'allow this site to open pull requests for you first: sign in through it again and say yes on the consent page', 'consent', 'consent');
      if (writes && !fits(`publish:${who.client}`, limits.publish)) return refuse(429, 'this site published 10 times in 10 minutes; try again later', 'rate', 'rate');
      if (req.method === 'POST' && HOST_WORK.test(url.pathname) && !fits(`work:${who.client}`, limits.work)) return refuse(429, 'this site asked for 60 previews in a minute; try again later', 'rate', 'rate');
    }
    try {
      // Before every request, which installation holds the repository and is it this tenant's (S9): asked fresh
      // for a write, at most five minutes old for a read. The refusal keeps its reason, so the page can say it.
      await tokenFor(who.tenant, slug, { write: writes, actor: who.principal ? String(who.principal) : null, team });
    } catch (e) {
      if (e instanceof StudioRefusal) return answer(e.status, e.message, e.type);
      throw e;
    }
    const { handler, callers } = handlerFor(who.tenant, team, slug);
    const headers = new Headers();
    // The deployment's cookie and bearer never reach the handler, or GitHub.
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && k !== 'cookie' && k !== 'authorization' && k !== 'dpop' && k !== 'x-agent-team-host-user') headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    // A host's server calls with its DPoP-bound token and no cookie (security C1): no browser is on this request, so
    // the handler's cross-site checks (E2) stand for the host's own, which its proxy already made. A cookie caller,
    // even on a host's token, keeps every E2 check.
    if (viaHost && !req.headers.cookie && /^DPoP /i.test(req.headers.authorization ?? '') && req.headers.dpop) {
      headers.delete('sec-fetch-site');
      headers.set('origin', opts.origin);
      headers.set('x-agent-team-studio', '1');
    }
    if (viaHost) {
      who = { ...who, hostName: (await opts.hosts?.nameOf?.(who.client)) ?? who.client, hostUser: hostUserOf(req.headers['x-agent-team-host-user']) };
    }
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const request = new Request(url, { method: req.method, headers, body: hasBody ? (rawBody ?? Buffer.alloc(0)) : undefined });
    callers.set(request, who);
    const response = await handler(request);
    return { status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) };
  }

  return { enabled, handle, tokenFor };
}
