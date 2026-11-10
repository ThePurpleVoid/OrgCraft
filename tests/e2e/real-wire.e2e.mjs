// The real-wire harness (tools/real-wire/run.mjs), run here with the model stubbed and a fake GitHub (tests/fake-github.mjs,
// backed by a bare repository), so the owner's run on ThePurpleVoid/orgcraft-sandbox is only the real wire. Every row
// of the table must pass: SSH clone, push, a pull request by the app, an accept card bound to the head, no merge
// without the passphrase, the merge after it, and a loud BLOCKED with the read-only key.
//
//   npm ci --prefix apps/server && npm ci --prefix apps/runner && node --test tests/e2e/real-wire.e2e.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT } from '../../bin/agent-team.mjs';
import { onlySandbox, realWire, SANDBOX } from '../../tools/real-wire/run.mjs';

const deps = existsSync(join(KIT, 'apps/server/node_modules/@electric-sql/pglite')) && existsSync(join(KIT, 'apps/runner/node_modules/ws'));
if (process.env.CI && !deps) throw new Error('CI is set but npm ci --prefix apps/server and apps/runner were not run');
const skip = !deps && 'run npm ci --prefix apps/server and npm ci --prefix apps/runner first';

test('it refuses every repository but the sandbox, in any spelling, before anything starts', async () => {
  for (const ok of [`git@github.com:${SANDBOX}.git`, `https://github.com/${SANDBOX}`, 'ssh://git@github.com/thepurplevoid/orgcraft-sandbox.git']) assert.equal(onlySandbox(ok), SANDBOX);
  for (const bad of ['git@github.com:ThePurpleVoid/OrgCraft.git', 'git@github.com:ThePurpleVoid/CoachSpotter.git', 'https://github.com/ThePurpleVoid/orgcraft-sandbox-2',
    'git@github.com:Other/orgcraft-sandbox.git', 'https://evil.example/ThePurpleVoid/orgcraft-sandbox', '/tmp/orgcraft-sandbox.git', '', null]) {
    assert.throws(() => onlySandbox(bad), /runs only on ThePurpleVoid\/orgcraft-sandbox/, String(bad));
  }
  await assert.rejects(realWire({ mode: 'fake', repo: 'git@github.com:ThePurpleVoid/OrgCraft.git', evidence: false, log: () => {} }), /runs only on/);
});

test('the whole wire against a fake GitHub with a stubbed model: every row passes, and the table is written', { skip, timeout: 240_000 }, async () => {
  const out = mkdtempSync(join(tmpdir(), 'real-wire-evidence-'));
  const lines = [];
  try {
    const r = await realWire({ mode: 'fake', evidence: out, log: (l) => lines.push(l) });
    assert.ok(r.ok, `${r.table}\n${lines.join('\n')}`);
    const names = r.rows.map((x) => x.check).join('\n');
    for (const want of [/SSH clone/, /pull request opened by the merger app/, /accept card bound to the pushed head/, /no merge without/, /merge after/, /read-only key: a loud BLOCKED/, /under the \$0\.50 cap/]) assert.match(names, want);
    assert.match(readFileSync(r.evidence, 'utf8'), /Result: \*\*PASS\*\*/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});
