// A GitHub App, with node:crypto only, for every part of the kit that writes to a repository as an app: the runner's
// merger app (apps/runner/proposals.mjs) and the hosted Studio (apps/studio). One set of rules for both (#28,
// studio-embed S9, security requirement 4):
//
//   - The repository's installation is looked up with the app's JWT (GET /repos/{owner}/{repo}/installation),
//     fresh before every write; a read may use a lookup up to five minutes old.
//   - It must be one of the installations the server has bound to the tenant (`bound`, proven by the server). If it
//     is not, or nothing is bound, or the app is not installed: an InstallationError (reason `installation`), and no
//     other installation is ever tried. The caller audits it.
//   - A token is for that one repository and exactly the permissions asked, cached by repository, installation and
//     permissions until five minutes before it expires.
//
//   import { githubApp } from 'agent-team-kit/github-app';
//   const app = githubApp({ appId, privateKey });
//   const { token } = await app.tokenFor('acme/shop', [12345], { permissions: { contents: 'write' } });
import { createPrivateKey, createSign } from 'node:crypto';

const b64url = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
export const READ_LOOKUP_MS = 5 * 60_000;

/** The app's JWT (RS256, ten minutes, issued a minute in the past for clock drift). Takes \n-escaped PEMs too. */
export function appJwt(appId, privateKey, now = Date.now()) {
  const iat = Math.floor(now / 1000) - 60;
  const head = b64url({ alg: 'RS256', typ: 'JWT' });
  const body = b64url({ iat, exp: iat + 600, iss: String(appId) });
  const key = createPrivateKey(String(privateKey).replace(/\\n/g, '\n'));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

/** A refusal because the repository's installation is not bound to the tenant (or there is none). */
export class InstallationError extends Error {
  constructor(message) { super(message); this.reason = 'installation'; }
}

/** The installation ids a server sent, as positive integers only (anything else does not count as bound). */
export const boundIds = (bound) => (Array.isArray(bound) ? bound.filter((i) => Number.isSafeInteger(i) && i > 0) : []);

export function githubApp({ appId, privateKey, api = 'https://api.github.com', fetch = globalThis.fetch, userAgent = 'agent-team-kit' } = {}) {
  if (!appId || !privateKey) throw new Error('the GitHub App needs an app id and a private key');
  const base = api.replace(/\/+$/, '');
  const tokens = new Map(); // slug#installation#permissions -> { value, until }
  const lookups = new Map(); // slug -> { id, at }
  async function call(path, { token, ...init } = {}) {
    const res = await fetch(`${base}${path}`, { ...init, headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': userAgent, authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }
  const jwt = () => appJwt(appId, privateKey);

  /** The repository's installation id, if it is bound; `fresh` (every write) never uses an earlier lookup. */
  async function installationFor(slug, bound, { fresh = true } = {}) {
    const ids = boundIds(bound);
    if (!ids.length) throw new InstallationError(`no GitHub App installation is bound to this tenant, so nothing is written to or read from ${slug}; connect the GitHub App for this repository first`);
    const seen = lookups.get(slug);
    let id = !fresh && seen && Date.now() - seen.at < READ_LOOKUP_MS ? seen.id : null;
    if (id === null) {
      const r = await call(`/repos/${slug}/installation`, { token: jwt() });
      if (r.status === 404) { lookups.delete(slug); throw new InstallationError(`the GitHub App is not installed on ${slug}`); }
      if (r.status !== 200 || !Number.isSafeInteger(r.body?.id)) { lookups.delete(slug); throw new Error(`the installation of ${slug} could not be read (${r.status})`); }
      id = r.body.id;
      lookups.set(slug, { id, at: Date.now() });
    }
    if (!ids.includes(id)) throw new InstallationError(`${slug} is under GitHub App installation ${id}, which is not bound to this tenant; refused, and no other installation is tried`);
    return id;
  }

  /** { token, installation, permissions, repositories } for one repository; `fresh` defaults to true (a write). */
  async function tokenFor(slug, bound, { permissions, fresh = true } = {}) {
    if (!permissions || !Object.keys(permissions).length) throw new Error('say which permissions the token needs');
    const id = await installationFor(slug, bound, { fresh });
    const key = `${slug}#${id}#${Object.entries(permissions).map(([k, v]) => `${k}:${v}`).sort().join(',')}`;
    const t = tokens.get(key);
    if (t && t.until > Date.now()) return t.value;
    const r = await call(`/app/installations/${id}/access_tokens`, { token: jwt(), method: 'POST', body: JSON.stringify({ repositories: [slug.split('/')[1]], permissions }) });
    if (r.status !== 201 || !r.body.token) throw new Error(`no installation token for ${slug} (${r.status})`);
    const value = { token: r.body.token, installation: id, permissions: r.body.permissions ?? permissions, repositories: (r.body.repositories ?? []).map((x) => x.full_name) };
    tokens.set(key, { value, until: (Date.parse(r.body.expires_at) || Date.now() + 55 * 60_000) - 5 * 60_000 });
    return value;
  }

  return { call, installationFor, tokenFor, liveTokens: () => [...tokens.values()].map((t) => t.value.token) };
}
