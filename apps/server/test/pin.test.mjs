// F-B5 (reviews/F-B5-design.md): AGENT_TEAM_GITHUB_INSTALLATION_ID is for local mode only. The server refuses to
// start with it beside a database or sign-in, on the same predicate that turns sign-in on (security), and records it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installationPin, signInOn } from '../pin.mjs';
import { openDb } from '../db.mjs';

const BIN = fileURLToPath(new URL('../bin.mjs', import.meta.url));
const CLEAN = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DATABASE_URL|TEST_DATABASE_URL|GITHUB_|AGENT_TEAM_|HOST|PORT$)/.test(k)));

/** Runs bin.mjs until it exits, or until `until` matches its stdout (then stops it); returns { code, out, err }. */
function run(env, args = [], until = null) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...CLEAN, ...env } });
    let out = '', err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), 30_000);
    p.stdout.on('data', (d) => { out += d; if (until && until.test(out)) p.kill('SIGTERM'); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

test('the pin is refused beside a database, beside sign-in, and when it is not an installation id', async () => {
  const pin = { AGENT_TEAM_GITHUB_INSTALLATION_ID: '5687048' };
  for (const env of [{ DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' }, { GITHUB_APP_CLIENT_ID: 'Iv1.x', GITHUB_APP_CLIENT_SECRET: 'x' }]) {
    const r = await run({ ...pin, ...env });
    assert.equal(r.code, 2, JSON.stringify(env));
    assert.match(r.err, /for local mode only/);
  }
  for (const env of [{ AGENT_TEAM_GITHUB_INSTALLATION_ID: '12ab' }, { AGENT_TEAM_GITHUB_INSTALLATION_ID: '0' }, { ...pin, AGENT_TEAM_GITHUB_REPOS: 'not a repo' }, { AGENT_TEAM_GITHUB_REPOS: 'a/b' }]) {
    const r = await run(env);
    assert.equal(r.code, 2, JSON.stringify(env));
  }
});

test('the guard uses the predicate that turns sign-in on, for every identity input bin.mjs reads', () => {
  // Every env that makes identity on must make signInOn true; the pin's guard refuses on it.
  for (const env of [{ GITHUB_APP_CLIENT_ID: 'Iv1.x' }]) {
    assert.ok(signInOn(env));
    assert.throws(() => installationPin({ ...env, AGENT_TEAM_GITHUB_INSTALLATION_ID: '1' }), /local mode only/);
  }
  assert.ok(!signInOn({}));
  assert.equal(installationPin({}), null);
});

test('installationsFor: the pinned id for this tenant\'s repositories, narrowed by AGENT_TEAM_GITHUB_REPOS', async () => {
  const all = installationPin({ AGENT_TEAM_GITHUB_INSTALLATION_ID: '42' }, { tenant: 'local' });
  assert.deepEqual(await all.installationsFor('local', 'git@github.com:Acme/Shop.git'), [42]);
  assert.deepEqual(await all.installationsFor('other', 'git@github.com:Acme/Shop.git'), []);
  assert.deepEqual(await all.installationsFor('local', 'https://gitlab.com/acme/shop.git'), []);
  const some = installationPin({ AGENT_TEAM_GITHUB_INSTALLATION_ID: '42', AGENT_TEAM_GITHUB_REPOS: 'acme/shop, acme/docs' }, { tenant: 'local' });
  assert.deepEqual(some.repos, ['acme/docs', 'acme/shop']);
  assert.deepEqual(await some.installationsFor('local', 'https://github.com/ACME/shop'), [42]);
  assert.deepEqual(await some.installationsFor('local', 'https://github.com/acme/admin.git'), []);
  // Loopback is quiet but for the "selected repositories" advice; another host warns.
  assert.equal(all.warnings.length, 1);
  assert.match(installationPin({ AGENT_TEAM_GITHUB_INSTALLATION_ID: '42' }, { host: '0.0.0.0' }).warnings.join('\n'), /not loopback/);
});

test('in local mode the server starts with the pin, logs it, warns off loopback and records it in identity_audit', async () => {
  const data = mkdtempSync(join(tmpdir(), 'pin-'));
  try {
    const r = await run({ AGENT_TEAM_GITHUB_INSTALLATION_ID: '5687048', AGENT_TEAM_GITHUB_REPOS: 'acme/shop' }, ['--data', data, '--port', '0', '--host', '0.0.0.0'], /GitHub installation/);
    assert.match(r.out, /GitHub installation \(set by the operator\): 5687048, for acme\/shop/);
    assert.match(r.err, /not loopback/);
    assert.match(r.err, /selected repositories only/);
    const db = await openDb({ dataDir: join(data, 'db') });
    const rows = await db.system("select action, detail from identity_audit where action = 'installation-pinned'");
    await db.close();
    assert.deepEqual(rows.map((x) => x.detail), [{ tenant: 'local', installation: 5687048, repos: ['acme/shop'], host: '0.0.0.0' }]);
  } finally { rmSync(data, { recursive: true, force: true }); }
});
