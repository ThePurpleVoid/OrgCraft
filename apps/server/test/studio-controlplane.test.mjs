// The Studio mounted in a host's own app, in control-plane mode (docs/specs/studio-embed.md section 6): the kit's
// handler on the host keeps the host's sign-in and browser checks, and the deployment (this server, in process) reads
// the repository and opens the pull request, for the host's DPoP-bound token and the host's own user. Offline: GitHub
// is the kit's fake over a real bare repository, and the sign-in is the test issuer's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORIGIN, issuer } from './sign-in-helpers.mjs';
import { HOST, SHOP, hostSignIn, ownerWithPasskey } from './host-helpers.mjs';
import { createStudioHandler } from '../../studio/handler.mjs';
import { fakeGitHub } from '../../../tests/fake-github.mjs';

const KIT = new URL('../../../', import.meta.url).pathname;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });
const BASE = '/api/agent-team/studio';

function bareTeam() {
  const seed = mkdtempSync(join(tmpdir(), 'cp-studio-seed-'));
  const git = (...a) => execFileSync('git', ['-C', seed, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 's@example.com'); git('config', 'user.name', 'Seed'); git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(seed, 'README.md'), '# Shop\n');
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Shop', '--owner', 'Sam', '--timezone', 'UTC', '--dir', seed], { stdio: 'ignore' });
  git('add', '-A'); git('commit', '-q', '-m', 'start');
  const bare = mkdtempSync(join(tmpdir(), 'cp-studio-bare-'));
  execFileSync('git', ['clone', '-q', '--bare', seed, bare]);
  return bare;
}

/** The host's page calling its own server, with the host's session cookie (which must never leave the host). */
const page = (handler) => async (method, path, body) => {
  const res = await handler(new Request(`${SHOP}${BASE}${path}`, {
    method,
    headers: { 'x-agent-team-studio': '1', 'sec-fetch-site': 'same-origin', cookie: 'shop_session=host-secret', ...(body ? { origin: SHOP, 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: res.status, body: await res.json(), headers: res.headers };
};

test('control-plane mode: read, preview and publish through the deployment for the host\'s user; publish-code goes to the deployment\'s Studio', async () => {
  const github = await fakeGitHub({ bare: bareTeam(), installation: 77 });
  try {
    await issuer(async (p) => {
      const { b, su } = await ownerWithPasskey(p.gh, p.browser);
      const host = (await b.call('POST', '/hosts', HOST, { 'x-step-up': await su() })).body;
      assert.equal((await b.call('POST', '/teams', { id: 'shop' })).status, 201);
      const signedIn = await hostSignIn(p, host);
      assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));

      // The host's own sign-in decides who may do what on its page; the deployment decides again for the token's person.
      let canPublish = true;
      const sent = [];
      const via = (token) => createStudioHandler({
        basePath: BASE, allowedOrigins: [SHOP],
        authorize: async (_request, action) => (action === 'read' || (action === 'publish' && canPublish) ? { id: 'u-7', name: 'Ana' } : null),
        controlPlane: {
          url: ORIGIN, team: 'shop', hostToken: token, dpopKey: signedIn.key,
          // The deployment's public origin is ORIGIN; in this test it listens on a local port.
          fetch: (url, init) => { sent.push({ url, headers: init.headers }); return fetch(url.replace(ORIGIN, p.local), init); },
        },
      });
      const call = page(via(async ({ user }) => { assert.equal(user.id, 'u-7'); return signedIn.token; }));

      const read = await call('GET', '/v1/team');
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.match(read.body.base, /^[0-9a-f]{40}$/);
      assert.deepEqual([read.body.features.publish, read.body.features.publishCode, read.body.features.studio], [true, false, `${ORIGIN}/teams/shop`]);
      // What went to the deployment: its Studio route, this site's DPoP token and a proof, the host's user, no cookie.
      assert.equal(sent[0].url, `${ORIGIN}/v1/teams/shop/studio/v1/team`);
      assert.match(sent[0].headers.authorization, /^DPoP /);
      assert.ok(sent[0].headers.dpop.split('.').length === 3);
      assert.equal(sent[0].headers['x-agent-team-host-user'], 'Ana (u-7)');
      assert.ok(sent.every((s) => !JSON.stringify(s.headers).includes('host-secret')), 'the host\'s cookie never leaves it');

      const { spec, base } = read.body;
      spec.values = { ...spec.values, PROJECT_NAME: 'Shop through the admin' };
      const pre = await call('POST', '/v1/team/preview', { spec, base });
      assert.equal(pre.status, 200, JSON.stringify(pre.body));
      assert.ok(pre.body.changes.length > 0);

      // The host's own refusal comes first: no publish permission on the host, nothing is sent.
      canPublish = false;
      const before = sent.length;
      const no = await call('POST', '/v1/team/publish', { spec, base, message: 'Rename' });
      assert.deepEqual([no.status, sent.length], [403, before]);
      canPublish = true;

      const pub = await call('POST', '/v1/team/publish', { spec, base, message: 'Rename the project' });
      assert.equal(pub.status, 200, JSON.stringify(pub.body));
      assert.match(pub.body.pr.url, /^https:\/\//);
      const pr = github.pulls.at(-1);
      assert.match(pr.body, /Published through Admin at shop\.example for `Ana \(u-7\)`/);
      assert.match(github.git(['log', '-1', '--format=%B', pub.body.commit]), /Published-by: Octo Cat \(.+\) via Agent Team Studio/, 'the actor is the token\'s person');
      const status = await call('GET', `/v1/team/pr?branch=${encodeURIComponent(pub.body.branch)}`);
      assert.equal(status.status, 200, JSON.stringify(status.body));

      // A change to the commands the team runs: never through a host; the page is sent to the deployment's Studio.
      const fresh = (await call('GET', '/v1/team')).body;
      const gated = structuredClone(fresh.spec);
      gated.gates = { ...(gated.gates ?? {}), targets: { web: [{ name: 'lint', run: 'npm run lint', pool: '' }] } };
      const code = await call('POST', '/v1/team/publish', { spec: gated, base: fresh.base, message: 'Add a lint gate' });
      assert.deepEqual([code.status, code.body.type, code.body.studio], [403, 'publish-code', `${ORIGIN}/teams/shop`], JSON.stringify(code.body));
      assert.match(code.body.error, /team's own Studio/);
      assert.equal(github.pulls.length, 1, 'no second pull request');

      // A token the deployment does not know: the page is told to sign in through it again.
      const stale = await page(via('not-a-real-token'))('GET', '/v1/team');
      assert.deepEqual([stale.status, stale.body.type], [502, 'host-sign-in']);
      // No token yet: not signed in to the deployment.
      assert.equal((await page(via(async () => null))('GET', '/v1/team')).status, 503);
    }, { studio: { appId: 1, privateKey: PEM, api: github.url, teamRepo: async () => 'acme/shop', boundInstallations: async () => ['77'] } });
  } finally { await github.close(); }
});

test('control-plane mode: options are checked when the handler is made', () => {
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const make = (cp) => () => createStudioHandler({ basePath: BASE, allowedOrigins: [SHOP], authorize: async () => null, controlPlane: { url: 'https://teams.example', team: 'shop', hostToken: 't', dpopKey: key, ...cp } });
  assert.doesNotThrow(make({}), 'no repo or getInstallationToken needed');
  assert.doesNotThrow(make({ dpopKey: key.export({ format: 'jwk' }) }), 'a JWK works too');
  assert.doesNotThrow(make({ dpopKey: generateKeyPairSync('ed25519').privateKey }), 'Ed25519 works too');
  assert.throws(make({ url: 'http://teams.example' }), /origin/, 'https only, except localhost');
  assert.throws(make({ url: 'https://teams.example/api' }), /origin/);
  assert.throws(make({ team: '../x' }), /team/);
  assert.throws(make({ hostToken: undefined }), /hostToken/);
  assert.throws(make({ dpopKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }), /dpopKey/);
  assert.throws(make({ dpopKey: generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey }), /dpopKey/);
});
