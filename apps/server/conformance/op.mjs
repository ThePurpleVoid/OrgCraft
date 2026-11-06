// The OpenID conformance harness (CI job `oidc-conformance`): the server's real issuer (identity.mjs) on https, with
// a stand-in GitHub, so the OpenID Foundation's suite can run its Basic OP plan against it. Not a server mode: the
// deployment never runs this file.
//
// What differs from a deployment, and why:
// - The suite registers its own confidential clients (dynamic registration, the path the suite's own CI uses for
//   oidc-provider). A deployment has fixed first-party clients only, so registration is switched on here alone.
// - PKCE is required for public clients (every client a deployment has) but not for the suite's confidential ones,
//   because the Basic OP plan sends most requests without it. The plan's PKCE module still checks a valid S256 pair.
// - Registered clients get the refresh_token grant by default, so the refresh rotation module runs.
// - The Studio's /sign-in page is a one-button page here, and the stand-in GitHub signs the owner in at once, so the
//   suite's browser clicks once per sign-in (and takes its screenshot there for prompt=login and max_age).
// - Error pages are wrapped in HTML for the suite's browser.
// - Rate limits key on each request: the suite is one caller making hundreds of requests (limits have unit tests).
//
// Env: OP_ISSUER (https://op.agent-team.test:3000), OP_GITHUB_URL (the stand-in GitHub as the suite's browser
// reaches it), OP_CERT and OP_KEY (PEM files), TEST_DATABASE_URL (optional; PGlite in memory otherwise).
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { randomUUID } from 'node:crypto';
import { fresh, key, ADMIN, verifier } from '../test/helpers.mjs';
import { stubGitHub, owner, OWNER } from '../test/sign-in-helpers.mjs';
import * as store from '../store.mjs';
import { createHandler } from '../server.mjs';
import { createIdentity, githubUpstream } from '../identity.mjs';

const ISSUER = process.env.OP_ISSUER ?? 'https://op.agent-team.test:3000';
const port = Number(new URL(ISSUER).port || 443);
const ghUrl = process.env.OP_GITHUB_URL ?? 'http://op.agent-team.test:3001';

const db = await fresh();
await store.ensureTenant(db, 'acme');
const gh = await stubGitHub({ host: '0.0.0.0', port: Number(new URL(ghUrl).port), url: ghUrl });
gh.as = { ...owner, emails: [] };
const upstream = githubUpstream({ clientId: 'Iv1.test', clientSecret: 'gh-secret', url: ghUrl, apiUrl: ghUrl });

const identity = await createIdentity({
  db, key, publicUrl: ISSUER, tenant: 'acme', ownerGithub: OWNER, upstream,
  clientIp: () => randomUUID(),
  configure: (config) => ({
    ...config,
    clientDefaults: { ...config.clientDefaults, grant_types: ['authorization_code', 'refresh_token'] },
    pkce: { ...config.pkce, required: (_ctx, client) => client.clientAuthMethod === 'none' },
    features: { ...config.features, registration: { enabled: true }, registrationManagement: { enabled: true } },
    // The suite's browser reads pages as HTML; the deployment's error answer is the same text as plain text.
    async renderError(ctx, out, error) {
      await config.renderError(ctx, out, error);
      ctx.type = 'text/html; charset=utf-8';
      ctx.body = `<!doctype html><title>Sign-in failed</title><p id="error">${ctx.body}</p>`;
    },
  }),
});
const handler = createHandler({ db, key, tenant: 'acme', adminToken: ADMIN, publicUrl: ISSUER, identity, stepUpVerifier: verifier });

const server = createServer({ cert: readFileSync(process.env.OP_CERT), key: readFileSync(process.env.OP_KEY) }, (req, res) => {
  const url = new URL(req.url, ISSUER);
  // The Studio's sign-in page, reduced to its one button: "Continue with GitHub" (the suite's browser clicks it).
  if (url.pathname === '/sign-in' && /^[A-Za-z0-9_-]{1,100}$/.test(url.searchParams.get('interaction') ?? '')) {
    const go = `/oauth/interaction/${url.searchParams.get('interaction')}/github`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(`<!doctype html><title>Sign in</title><h1>Sign in to Agent Team</h1><a id="continue" href="${go}">Continue with GitHub</a>`);
  }
  return handler(req, res);
});
server.listen(port, '0.0.0.0', () => console.log(`conformance OP on ${ISSUER} (GitHub stand-in on ${ghUrl})`));
