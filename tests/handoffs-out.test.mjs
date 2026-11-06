// handoffs/ is the kit team's mailbox with the products that use the kit. It is not part of the kit: it never ships in
// the package, never reaches a team through init or sync, and no product name appears in anything that ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const KIT = new URL('../', import.meta.url).pathname;
const products = () => readdirSync(join(KIT, 'handoffs'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name.toLowerCase());

test('the package ships no handoffs/ and names no product the kit team has a mailbox with', () => {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: KIT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const paths = pack.files.map((f) => f.path);
  assert.ok(paths.length > 50, 'npm pack listed the package');
  assert.deepEqual(paths.filter((p) => p.startsWith('handoffs/')), []);
  const names = products();
  assert.ok(names.length > 0);
  const named = paths.filter((p) => { const t = readFileSync(join(KIT, p), 'utf8').toLowerCase(); return names.some((n) => t.includes(n)); });
  assert.deepEqual(named, [], 'product names in shipped files');
});

test('init writes nothing from handoffs/ into a team', () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoffs-init-'));
  writeFileSync(join(dir, 'README.md'), '# X\n');
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'X', '--owner', 'Y', '--timezone', 'UTC', '--dir', dir], { stdio: 'ignore' });
  const all = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else all.push(relative(dir, p)); } };
  walk(dir);
  assert.ok(all.length > 10);
  assert.deepEqual(all.filter((p) => p.includes('handoffs')), []);
  const names = products();
  assert.deepEqual(all.filter((p) => { const t = readFileSync(join(dir, p), 'utf8').toLowerCase(); return t.includes('handoffs/') || names.some((n) => t.includes(n)); }), []);
});
