// The Studio's template gallery, server side (templates story criteria 5 to 10): a repository with no team gets the
// gallery, a template becomes a draft, and publishing it writes what `agent-team init --template` writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { KIT } from '../bin/agent-team.mjs';
import { createStudio } from '../apps/studio/server.mjs';

const cli = join(KIT, 'bin/agent-team.mjs');
const git = (root, ...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();

function emptyRepo(name = 'shop') {
  const root = join(mkdtempSync(join(tmpdir(), 'studio-tpl-')), name);
  execFileSync('git', ['init', '-q', root]);
  for (const [k, v] of [['user.email', 'studio@example.com'], ['user.name', 'Studio Test'], ['commit.gpgsign', 'false']]) git(root, 'config', k, v);
  git(root, 'commit', '-q', '--allow-empty', '-m', 'start');
  return root;
}

/** Every file in the repository except .git, as path → text. */
function tree(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      if (e === '.git') continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p); else out[relative(root, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(root);
  return out;
}

async function serve(root, fn) {
  const server = createStudio({ root });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(`${base}/?t=${server.launchToken}`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
  const call = async (path, body) => {
    const res = await fetch(base + path, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try { await fn(call); } finally { server.close(); }
}

test('a repository with no team gets the gallery: every kit template as a card, nothing written', async () => {
  const root = emptyRepo();
  await serve(root, async (call) => {
    const s = await call('/v1/team');
    assert.equal(s.status, 200);
    assert.equal(s.body.noTeam, true);
    assert.equal(s.body.spec, null);
    const ids = s.body.templates.map((t) => t.id);
    for (const id of ['startup-product-team', 'customer-support-team', 'content-studio']) assert.ok(ids.includes(id), id);
    const support = s.body.templates.find((t) => t.id === 'customer-support-team');
    assert.equal(support.groupTitle, 'Run a business function');
    assert.ok(support.on > 0 && support.systems.length > 0);
    const made = await call('/v1/team/from-template', { id: 'customer-support-team', project: 'Shop', owner: 'Dana', timezone: 'Europe/Lisbon' });
    assert.equal(made.status, 200);
    assert.equal(made.body.spec.values.PROJECT_NAME, 'Shop');
    assert.equal(made.body.spec.values.TIMEZONE, 'Europe/Lisbon');
    assert.match(made.body.spec.options.from, /^customer-support-team@/);
    assert.deepEqual(readdirSync(root), ['.git'], 'nothing is written before publish (D31)');
  });
});

test('publishing a template writes the same files as agent-team init --template (criterion 9)', async () => {
  const studio = emptyRepo('shop');
  const cli1 = emptyRepo('shop');
  execFileSync(process.execPath, [cli, 'init', '--template', 'content-studio', '--project', 'Shop', '--owner', 'Dana', '--timezone', 'Europe/Lisbon', '--dir', cli1], { stdio: 'ignore' });
  await serve(studio, async (call) => {
    const { body: { spec } } = await call('/v1/team/from-template', { id: 'content-studio', project: 'Shop', owner: 'Dana', timezone: 'Europe/Lisbon' });
    const pre = await call('/v1/team/preview', { spec });
    assert.equal(pre.status, 200);
    assert.ok(pre.body.changes.some((c) => c.path === '.agent-team/team.json' && c.status === 'added'));
    assert.ok(pre.body.changes.some((c) => c.path === '.agent-team/config.sh'), 'the preview lists the files init writes once');
    const pub = await call('/v1/team/publish', { spec, branch: 'team', message: 'Start the team' });
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    assert.ok(pub.body.commit);
    assert.equal(git(studio, 'status', '--porcelain'), '', 'everything it wrote is committed');
    const after = await call('/v1/team');
    assert.equal(after.body.noTeam, undefined);
    assert.equal(after.body.spec.values.PROJECT_NAME, 'Shop');
    const again = await call('/v1/team/from-template', { id: 'content-studio' });
    assert.equal(again.status, 409, 'a team that exists is never replaced by a template (D32)');
  });
  assert.deepEqual(tree(studio), tree(cli1));
});

test('Start almost empty is a chief of staff only, with no check errors', async () => {
  const root = emptyRepo();
  await serve(root, async (call) => {
    const { status, body } = await call('/v1/team/from-template', { id: 'almost-empty', project: 'Shop' });
    assert.equal(status, 200);
    const on = Object.entries(body.spec.roles).filter(([, r]) => r.enabled).map(([s]) => s);
    assert.deepEqual(on, ['chief-of-staff']);
    assert.equal(body.spec.options.from, undefined);
    const pre = await call('/v1/team/preview', { spec: body.spec });
    assert.deepEqual(pre.body.issues.filter((i) => i.level === 'error'), []);
  });
});

test('a gallery card counts dormant roles only when there are some (D33)', async () => {
  const { rolesLine, matches } = await import('../apps/studio/public/gallery.js');
  assert.equal(rolesLine({ on: 28, dormant: [] }), '28 roles on');
  assert.equal(rolesLine({ on: 28, dormant: ['a', 'b', 'c', 'd', 'e', 'f'] }), '28 roles on · 6 dormant');
  assert.equal(rolesLine({ on: 1, dormant: [] }), '1 role on');
  const card = { title: 'Customer support team', summary: 'Answer customers well', groupTitle: 'Run a business function', systems: [{ name: 'Help articles' }] };
  assert.ok(matches(card, 'help ARTICLES'));
  assert.ok(!matches(card, 'payroll'));
});

test('a first publish that fails leaves the repository as it was, and the retry is still the first (review of #114)', async () => {
  const root = emptyRepo('shop');
  const { writeFileSync, chmodSync, existsSync } = await import('node:fs');
  // A pre-commit hook that refuses the first commit only.
  const hook = join(root, '.git/hooks/pre-commit');
  writeFileSync(hook, `#!/bin/sh\nif [ ! -f "${join(root, '.git/once')}" ]; then touch "${join(root, '.git/once')}"; echo refused >&2; exit 1; fi\n`);
  chmodSync(hook, 0o755);
  await serve(root, async (call) => {
    const { body: { spec } } = await call('/v1/team/from-template', { id: 'customer-support-team', project: 'Shop' });
    const first = await call('/v1/team/publish', { spec, message: 'Start the team' });
    assert.ok(first.status >= 400, 'the hook refused the commit');
    assert.deepEqual(readdirSync(root), ['.git'], 'nothing is left behind');
    assert.equal((await call('/v1/team')).body.noTeam, true, 'the Studio is still at the gallery');
    const second = await call('/v1/team/publish', { spec, message: 'Start the team' });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.ok(second.body.files.includes('.gitignore'), 'the retry commits .gitignore, as a first publish');
    assert.equal(git(root, 'status', '--porcelain'), '');
    assert.ok(existsSync(join(root, '.agent-team/team.json')));
  });
});

test('the shared rules line names the packs in plain words (neutral protocols criterion 5)', async () => {
  const { rulesLine } = await import('../apps/studio/public/gallery.js');
  assert.equal(rulesLine([]), 'Shared rules: the core only');
  assert.equal(rulesLine(['engineering']), 'Shared rules: the core and engineering (pull requests, the merge gate, going live)');
  assert.equal(rulesLine(['legal']), 'Shared rules: the core and legal');
});

test('a first publish commits an untracked .gitignore with the team\'s lines (review of #119, note 1)', async () => {
  const root = emptyRepo('shop');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  await serve(root, async (call) => {
    const { body: { spec } } = await call('/v1/team/from-template', { id: 'customer-support-team', project: 'Shop' });
    const res = await call('/v1/team/publish', { spec, message: 'Start the team' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.files.includes('.gitignore'));
    assert.match(git(root, 'show', 'HEAD:.gitignore'), /^node_modules\/\n/);
    assert.equal(git(root, 'status', '--porcelain'), '');
  });
});

test('uncommitted edits to the repository\'s own AGENTS.md block a publish only when the team writes AGENTS.md (review of #119, note 2)', async () => {
  const root = emptyRepo('shop');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(root, 'AGENTS.md'), '# Shop\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'agents');
  await serve(root, async (call) => {
    const { body: { spec } } = await call('/v1/team/from-template', { id: 'customer-support-team', project: 'Shop' });
    writeFileSync(join(root, 'AGENTS.md'), '# Shop\n\nWork in progress.\n');
    const off = await call('/v1/team/publish', { spec, message: 'Start the team' });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.ok(!off.body.files.includes('AGENTS.md'), 'the owner\'s edit is not committed');
    assert.equal(git(root, 'status', '--porcelain'), 'M AGENTS.md');
    const on = await call('/v1/team/publish', { spec: { ...spec, options: { ...spec.options, targets: ['claude-code', 'agents-md'] } }, message: 'AGENTS.md too' });
    assert.equal(on.status, 409);
    assert.match(on.body.error, /AGENTS\.md/);
  });
});

test('a failed first publish leaves the repository\'s own untracked AGENTS.md alone (review of #119, sev 2)', async () => {
  const root = emptyRepo('shop');
  const { writeFileSync, chmodSync } = await import('node:fs');
  writeFileSync(join(root, 'AGENTS.md'), '# Shop\n\nHand-written.\n');
  const hook = join(root, '.git/hooks/pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho refused >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  await serve(root, async (call) => {
    const { body: { spec } } = await call('/v1/team/from-template', { id: 'customer-support-team', project: 'Shop' });
    const res = await call('/v1/team/publish', { spec, message: 'Start the team' });
    assert.ok(res.status >= 400, 'the hook refused the commit');
    assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), '# Shop\n\nHand-written.\n');
    assert.deepEqual(readdirSync(root).sort(), ['.git', 'AGENTS.md']);
  });
});

test('a template\'s "off" roles start switched off but listed, and switching one on is a one-file change (demo step 13)', async () => {
  const { templateSpec, compileLayer, importLayer, checkTemplate } = await import('../packages/team-model/index.mjs');
  const { loadKit } = await import('../packages/team-model/node.mjs');
  const kit = loadKit();
  const files = { 'template.json': readFileSync(join(KIT, 'team/templates/startup-product-team/template.json'), 'utf8') };
  assert.deepEqual(checkTemplate(files, kit).filter((i) => i.level === 'error'), []);
  const spec = templateSpec(files, kit, { project: 'Acme' });
  assert.equal(spec.roles['performance-tester'].enabled, false);
  const out = compileLayer(spec, kit);
  assert.deepEqual(JSON.parse(out['team.json']).exclude, ['performance-tester']);
  const on = importLayer(out, kit);
  on.roles['performance-tester'].enabled = true;
  const after = compileLayer(on, kit);
  assert.deepEqual(Object.keys({ ...out, ...after }).filter((k) => out[k] !== after[k]), ['team.json']);
  assert.ok(checkTemplate({ 'template.json': files['template.json'].replace('"off": ["performance-tester"]', '"off": ["no-such-role"]') }, kit).some((i) => /off lists "no-such-role"/.test(i.message)));
});
