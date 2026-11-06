// The deployment's own Studio page (hosted mode, studio.mjs): the kit's handler under /v1/teams/{team}/studio/, with
// the M4 app on an installation this workspace has proven it owns (S9), looked up fresh before every write, one
// cache and temp folder per customer (S3), publishes idempotent and in the audit table. GitHub is the kit's fake,
// backed by a real bare git repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plane, ADMIN } from './helpers.mjs';
import { createHostedStudio } from '../studio.mjs';
import { fakeGitHub } from '../../../tests/fake-github.mjs';

const KIT = new URL('../../../', import.meta.url).pathname;
const ORIGIN = 'https://cp.example';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });

function bareTeam() {
  const seed = mkdtempSync(join(tmpdir(), 'hosted-studio-seed-'));
  const git = (...a) => execFileSync('git', ['-C', seed, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 's@example.com'); git('config', 'user.name', 'Seed'); git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(seed, 'README.md'), '# Shop\n');
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Shop', '--owner', 'Sam', '--timezone', 'UTC', '--dir', seed], { stdio: 'ignore' });
  git('add', '-A'); git('commit', '-q', '-m', 'start');
  const bare = mkdtempSync(join(tmpdir(), 'hosted-studio-bare-'));
  execFileSync('git', ['clone', '-q', '--bare', seed, bare]);
  return bare;
}

const studioHeaders = (extra = {}) => ({ authorization: `Bearer ${ADMIN}`, 'x-agent-team-studio': '1', ...extra });
const writeHeaders = (extra = {}) => studioHeaders({ origin: ORIGIN, 'content-type': 'application/json', ...extra });

test('off until the M4 app is set up: every Studio route says so, and nothing else changes', async () => {
  await plane(async ({ call }) => {
    await call('POST', '/teams', { id: 'shop' });
    const r = await call('GET', '/teams/shop/studio/v1/team', undefined, studioHeaders());
    assert.deepEqual([r.status, r.body.error], [503, 'the GitHub App is not connected yet']);
    assert.equal((await call('GET', '/teams/shop/board')).status, 200);
    // A large team's publish (over the server's usual 2 MB, under the Studio's 5 MB) reaches the Studio.
    const big = await call('POST', '/teams/shop/studio/v1/team/preview', { pad: 'x'.repeat(3 * 1024 * 1024) }, writeHeaders());
    assert.equal(big.status, 503);
  }, { publicUrl: ORIGIN });
});

test('read, preview and publish through the M4 app on a bound installation; a retried publish opens one pull request; the audit table has it', async () => {
  const gh = await fakeGitHub({ bare: bareTeam(), installation: 77 });
  try {
    await plane(async ({ call, db }) => {
      await call('POST', '/teams', { id: 'shop' });
      const read = await call('GET', '/teams/shop/studio/v1/team', undefined, studioHeaders());
      assert.equal(read.status, 200, JSON.stringify(read.body));
      const { spec, base } = read.body;
      assert.match(base, /^[0-9a-f]{40}$/);
      assert.equal(read.body.features.publish, true);
      spec.values = { ...spec.values, PROJECT_NAME: 'Shop online' };
      const pre = await call('POST', '/teams/shop/studio/v1/team/preview', { spec, base }, writeHeaders());
      assert.equal(pre.status, 200, JSON.stringify(pre.body));
      assert.ok(pre.body.changes.length > 0);
      const key = { 'idempotency-key': 'publish-1' };
      const first = await call('POST', '/teams/shop/studio/v1/team/publish', { spec, base, message: 'Rename the project' }, writeHeaders(key));
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.match(first.body.branch, /^agent-team\//);
      const again = await call('POST', '/teams/shop/studio/v1/team/publish', { spec, base, message: 'Rename the project' }, writeHeaders(key));
      assert.equal(again.headers.get('idempotent-replayed'), 'true');
      assert.deepEqual(again.body, first.body);
      assert.equal(gh.pulls.length, 1, 'one pull request');
      // The token was minted for this repository only, with the three permissions, on installation 77.
      assert.deepEqual(gh.minted.map((m) => [m.installation, m.body]), [['77', { repositories: ['shop'], permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } }]]);
      const rows = await db.system("select action, decision, target, detail from audit where tenant = 'acme' and action = 'publish'");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].decision, 'allowed');
      assert.equal(rows[0].target, first.body.branch);
      // The deployment's bearer never reached GitHub.
      assert.ok(gh.calls.every((c) => !c.auth.includes(ADMIN)));
    }, { publicUrl: ORIGIN, studio: { appId: 1, privateKey: PEM, api: gh.url, teamRepo: async () => 'acme/shop', boundInstallations: async () => ['77'] } });
  } finally { await gh.close(); }
});

test('S9: an installation this workspace has not proven is refused and audited, and a moved installation is caught before the write', async () => {
  const gh = await fakeGitHub({ bare: bareTeam(), installation: 77 });
  try {
    await plane(async ({ call, db }) => {
      await call('POST', '/teams', { id: 'shop' });
      const r = await call('GET', '/teams/shop/studio/v1/team', undefined, studioHeaders());
      assert.deepEqual([r.status, r.body.type], [403, 'installation']);
      assert.equal(gh.minted.length, 0, 'no token was minted');
      const rows = await db.system("select decision, rule, team, actor_kind, actor_id from audit where tenant = 'acme' and action = 'publish'");
      assert.deepEqual(rows.map((x) => [x.decision, x.rule, x.team, x.actor_kind]), [['refused', 'installation', 'shop', 'person']]);
      assert.notEqual(rows[0].actor_id, 'control-plane', 'the refusal names who asked');
    }, { publicUrl: ORIGIN, studio: { appId: 1, privateKey: PEM, api: gh.url, teamRepo: async () => 'acme/shop', boundInstallations: async () => ['12'] } });

    await plane(async ({ call }) => {
      await call('POST', '/teams', { id: 'shop' });
      const { spec, base } = (await call('GET', '/teams/shop/studio/v1/team', undefined, studioHeaders())).body;
      // The repository moves to an installation someone else owns: the cached read lookup is not trusted for a write.
      gh.setInstallation(88);
      const pub = await call('POST', '/teams/shop/studio/v1/team/publish', { spec, base, message: 'x' }, writeHeaders());
      assert.deepEqual([pub.status, pub.body.type], [403, 'installation']);
      assert.equal(gh.pulls.length, 0);
    }, { publicUrl: ORIGIN, studio: { appId: 1, privateKey: PEM, api: gh.url, teamRepo: async () => 'acme/shop', boundInstallations: async () => ['77'] } });
  } finally { await gh.close(); }
});

test('a team with no repository connected says so', async () => {
  await plane(async ({ call }) => {
    await call('POST', '/teams', { id: 'shop' });
    const r = await call('GET', '/teams/shop/studio/v1/team', undefined, studioHeaders());
    assert.deepEqual([r.status, r.body.type], [409, 'no-repo']);
  }, { publicUrl: ORIGIN, studio: { appId: 1, privateKey: PEM, teamRepo: async () => null, boundInstallations: async () => [] } });
});

test('roles: a viewer reads, an editor publishes, only an admin changes commands; cross-site writes are refused', async () => {
  const gh = await fakeGitHub({ bare: bareTeam(), installation: 77 });
  try {
    const hosted = createHostedStudio({ origin: ORIGIN, appId: 1, privateKey: PEM, api: gh.url, teamRepo: async () => 'acme/shop', boundInstallations: async () => ['77'], audit: () => {} });
    const req = (method, path, headers = {}) => ({ method, url: `/v1/teams/shop/studio${path}`, headers: { 'x-agent-team-studio': '1', ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}), ...headers } });
    const as = (role) => ({ tenant: 'acme', role, principal: `p-${role}`, session: { name: role } });
    const body = (o) => Buffer.from(JSON.stringify(o));
    const read = await hosted.handle(req('GET', '/v1/team'), as('viewer'), 'shop');
    assert.equal(read.status, 200);
    const { spec, base } = JSON.parse(read.body.toString());
    const gated = structuredClone(spec);
    gated.gates = { ...(gated.gates ?? {}), targets: { web: [{ name: 'lint', run: 'npm run lint', pool: '' }] } };
    assert.equal((await hosted.handle(req('POST', '/v1/team/publish'), as('viewer'), 'shop', body({ spec, base }))).status, 403, 'a viewer cannot publish');
    const code = await hosted.handle(req('POST', '/v1/team/publish'), as('editor'), 'shop', body({ spec: gated, base, message: 'gate' }));
    assert.equal(code.status, 403, 'an editor cannot change commands');
    assert.match(JSON.parse(code.body.toString()).error, /commands/);
    const ok = await hosted.handle(req('POST', '/v1/team/publish'), as('admin'), 'shop', body({ spec: gated, base, message: 'gate' }));
    assert.equal(ok.status, 200, ok.body.toString());
    assert.match(gh.git(['log', '-1', '--format=%B', JSON.parse(ok.body.toString()).commit]), /Published-by: admin \(p-admin\) via Agent Team Studio/);
    const evil = await hosted.handle(req('POST', '/v1/team/preview', { origin: 'https://evil.example' }), as('admin'), 'shop', body({ spec, base }));
    assert.equal(evil.status, 403);
    // The cookie and bearer of the deployment are never passed on.
    await hosted.handle(req('GET', '/v1/team', { cookie: 'session=secret', authorization: 'Bearer secret' }), as('viewer'), 'shop');
    assert.ok(gh.calls.every((c) => !c.auth.includes('secret')));
  } finally { await gh.close(); }
});

test('delegated publish: a host server reads, previews and publishes for its user; C1 to C5 and no publish-code through a host', async () => {
  const gh = await fakeGitHub({ bare: bareTeam(), installation: 77 });
  try {
    let consented = true;
    const rows = [];
    const hosted = createHostedStudio({ origin: ORIGIN, appId: 1, privateKey: PEM, api: gh.url, teamRepo: async () => 'acme/shop', boundInstallations: async () => ['77'],
      audit: (r) => rows.push(r), hosts: { consented: async () => consented, nameOf: async () => 'Shop @admin' }, hostLimits: { publish: { limit: 2, windowMs: 60_000 }, work: { limit: 3, windowMs: 60_000 } } });
    // The host's server: DPoP-bound token, no cookie, no browser headers (C1).
    const server = (method, path, extra = {}) => ({ method, url: `/v1/teams/shop/studio${path}`, headers: { authorization: 'DPoP tok', dpop: 'proof', 'sec-fetch-site': 'cross-site', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...extra } });
    const host = (role) => ({ tenant: 'acme', role, principal: `p-${role}`, via: 'host', client: 'host_shop12345', session: { name: role } });
    const body = (o) => Buffer.from(JSON.stringify(o));
    const read = await hosted.handle(server('GET', '/v1/team'), host('editor'), 'shop');
    assert.equal(read.status, 200, read.body.toString());
    const { spec, base } = JSON.parse(read.body.toString());
    assert.equal((await hosted.handle(server('POST', '/v1/team/preview'), host('editor'), 'shop', body({ spec, base }))).status, 200);
    // C1: a cookie caller on the host path keeps every browser check: no Origin, refused.
    const browser = { method: 'POST', url: '/v1/teams/shop/studio/v1/team/graph', headers: { cookie: 'agent_team_session=x', 'x-agent-team-studio': '1', 'content-type': 'application/json' } };
    assert.equal((await hosted.handle(browser, host('editor'), 'shop', body({ spec }))).status, 403);

    // C2: no publish until the person said yes to the text that says the host opens pull requests. Reads still work.
    consented = false;
    spec.values = { ...spec.values, PROJECT_NAME: 'Shop via host' };
    const no = await hosted.handle(server('POST', '/v1/team/publish'), host('editor'), 'shop', body({ spec, base, message: 'Rename' }));
    assert.deepEqual([no.status, JSON.parse(no.body.toString()).type], [403, 'consent']);
    assert.equal((await hosted.handle(server('GET', '/v1/team'), host('editor'), 'shop')).status, 200);
    consented = true;

    // C3, C4: the person is the actor and the trailer; the host and its user only in the PR body and the audit detail.
    const pub = await hosted.handle(server('POST', '/v1/team/publish', { 'x-agent-team-host-user': 'ana `x`\t@bob' }), host('editor'), 'shop', body({ spec, base, message: 'Rename' }));
    assert.equal(pub.status, 200, pub.body.toString());
    const out = JSON.parse(pub.body.toString());
    const pr = gh.pulls.at(-1);
    assert.match(pr.body, /Published through Shop &#64;admin for `ana x &#64;bob`\./);
    assert.ok(!/@/.test(pr.body.split('Published through')[1].split('\n')[0]), 'no @ from the host');
    const msg = gh.git(['log', '-1', '--format=%B', out.commit]);
    assert.match(msg, /Published-by: editor \(p-editor\) via Agent Team Studio/);
    assert.ok(!/ana|Shop/.test(msg.split('Published-by:')[1]), 'the trailer is our person only');
    const audited = rows.find((r) => r.action === 'publish' && r.decision === 'allowed');
    assert.equal(audited.actorId, 'p-editor');
    assert.deepEqual([audited.detail.host, audited.detail.hostName, audited.detail.hostUser], ['host_shop12345', 'Shop &#64;admin', 'ana x &#64;bob']);

    // D2: a change to commands the team runs is never published through a host, even by an admin.
    const gated = structuredClone(spec);
    gated.gates = { ...(gated.gates ?? {}), targets: { web: [{ name: 'lint', run: 'npm run lint', pool: '' }] } };
    const code = await hosted.handle(server('POST', '/v1/team/publish'), host('admin'), 'shop', body({ spec: gated, base: out.commit ? JSON.parse((await hosted.handle(server('GET', '/v1/team'), host('admin'), 'shop')).body.toString()).base : base, message: 'gate' }));
    assert.equal(code.status, 403, code.body.toString());

    // D4: per host, publishes (2 in this test's window: one above, one refused for commands, then the limit).
    const over = await hosted.handle(server('POST', '/v1/team/publish'), host('admin'), 'shop', body({ spec, base, message: 'again' }));
    assert.deepEqual([over.status, JSON.parse(over.body.toString()).type, over.headers['retry-after']], [429, 'rate', '60']);
    assert.ok(rows.some((r) => r.decision === 'refused' && r.rule === 'rate' && r.detail.host === 'host_shop12345'));
    // C5: previews too (3 in this window: the preview and the cookie call above, then one more).
    for (let i = 0; i < 1; i++) assert.equal((await hosted.handle(server('POST', '/v1/team/preview'), host('editor'), 'shop', body({ spec, base }))).status, 200);
    assert.equal((await hosted.handle(server('POST', '/v1/team/preview'), host('editor'), 'shop', body({ spec, base }))).status, 429);

  } finally { await gh.close(); }
});
