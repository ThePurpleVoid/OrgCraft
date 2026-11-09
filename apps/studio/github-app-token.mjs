// An installation token for the host's own GitHub App (docs/specs/studio-embed.md section 7), with node:crypto only.
// It always asks for this one repository and exactly contents: write, pull_requests: write and metadata: read (S7),
// and keeps the token in memory until five minutes before it expires (E3). Hosts may use @octokit/auth-app instead.
//
//   import { githubAppToken } from 'orgcraft/studio/github-app-token';
//   const getInstallationToken = githubAppToken({ appId, installationId, privateKey: process.env.AGENT_TEAM_GITHUB_APP_KEY });
import { createPrivateKey, createSign } from 'node:crypto';

const PERMISSIONS = { contents: 'write', pull_requests: 'write', metadata: 'read' };
const b64url = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');

/** The app's JWT (RS256, ten minutes, issued a minute in the past for clock drift). */
export function appJwt(appId, privateKey, now = Date.now()) {
  const iat = Math.floor(now / 1000) - 60;
  const head = b64url({ alg: 'RS256', typ: 'JWT' });
  const body = b64url({ iat, exp: iat + 600, iss: String(appId) });
  const key = createPrivateKey(String(privateKey).replace(/\\n/g, '\n'));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

/**
 * Returns getInstallationToken({ repo }) for createStudioHandler. Throws a plain error (never with the key or the
 * token in it) when the app is not set up.
 */
export function githubAppToken({ appId, installationId, privateKey, api = 'https://api.github.com', fetch: fetchImpl = globalThis.fetch } = {}) {
  let cached = null;
  return async ({ repo }) => {
    if (!appId || !installationId || !privateKey) throw new Error('the GitHub App is not connected yet');
    if (cached && cached.repo === repo && cached.expires - Date.now() > 5 * 60_000) return cached.value;
    let jwt;
    try { jwt = appJwt(appId, privateKey); } catch { throw new Error('the GitHub App private key could not be read'); }
    const res = await fetchImpl(`${api.replace(/\/+$/, '')}/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'agent-team-studio', 'x-github-api-version': '2022-11-28' },
      body: JSON.stringify({ repositories: [String(repo).split('/')[1]], permissions: PERMISSIONS }),
    }).catch(() => null);
    if (!res?.ok) throw new Error(`GitHub did not give the app a token (${res ? res.status : 'not reached'}); check the app id, the installation id and that it is installed on ${repo}`);
    const body = await res.json();
    const value = { token: body.token, permissions: body.permissions ?? {}, repositories: (body.repositories ?? []).map((r) => r.full_name) };
    cached = { repo, value, expires: Date.parse(body.expires_at) || Date.now() + 50 * 60_000 };
    return value;
  };
}
