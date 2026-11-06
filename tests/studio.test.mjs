// Agent Team Studio's server: state, preview and publish, over HTTP, against a throwaway repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT } from '../bin/agent-team.mjs';
import { addAgent, draftRole, setEnabled, setField } from '../packages/team-model/index.mjs';
import { createStudio } from '../apps/studio/server.mjs';

const cli = join(KIT, 'bin/agent-team.mjs');
const git = (root, ...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'studio-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'studio@example.com');
  git(root, 'config', 'user.name', 'Studio Test');
  execFileSync(process.execPath, [cli, 'init', '--preset', 'minimal', '--project', 'Studio', '--dir', root], { stdio: 'ignore' });
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

async function serve(root, fn) {
  const server = createStudio({ root });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body, headers = {}) => {
    const res = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) });
    return { status: res.status, type: res.headers.get('content-type'), body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
  };
  try { await fn(call); } finally { server.close(); }
}

test('serves the page, the team model and the team as a TeamSpec', async () => {
  const root = repo();
  await serve(root, async (call) => {
    const page = await call('/');
    assert.equal(page.status, 200);
    assert.match(page.body, /Agent Team Studio/);
    const model = await call('/team-model.mjs');
    assert.match(model.type, /javascript/);
    assert.match(model.body, /export function validate/);
    assert.equal((await call('/../server.mjs')).status, 404);
    const { status, body } = await call('/v1/team');
    assert.equal(status, 200);
    assert.equal(body.spec.schema, 'agent-team/team-spec@1');
    assert.equal(body.spec.values.PROJECT_NAME, 'Studio');
    assert.ok(body.kit.roles['chief-of-staff']);
    assert.deepEqual(body.git.dirty, []);
  });
});

test('previews a change without touching the repository', async () => {
  const root = repo();
  await serve(root, async (call) => {
    const { spec } = (await call('/v1/team')).body;
    setField(spec, 'web-dev', 'Model', 'deep');
    const { status, body } = await call('/v1/team/preview', { spec });
    assert.equal(status, 200);
    const paths = body.changes.map((c) => c.path);
    assert.ok(paths.includes('.agent-team/roles/web-dev.extend.md'), paths.join(', '));
    assert.ok(paths.includes('docs/team/roles/web-dev.md'));
    const brief = body.changes.find((c) => c.path === 'docs/team/roles/web-dev.md');
    assert.match(brief.after, /\*\*Model:\*\* deep/);
    assert.equal(existsSync(join(root, '.agent-team/roles/web-dev.extend.md')), false);
    assert.equal(git(root, 'status', '--porcelain'), '');
    const same = await call('/v1/team/preview', { spec: (await call('/v1/team')).body.spec });
    assert.deepEqual(same.body.changes, []);
  });
});

test('publishes to a new branch, and refuses errors, dirty files and cross-site posts', async () => {
  const root = repo();
  await serve(root, async (call) => {
    const { spec } = (await call('/v1/team')).body;
    const start = git(root, 'branch', '--show-current');

    const broken = structuredClone(spec);
    setField(broken, 'web-dev', 'Reports to', 'web-dev');
    assert.equal((await call('/v1/team/publish', { spec: broken, branch: 'team/broken' })).status, 422);

    assert.equal((await call('/v1/team/publish', { spec }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await call('/v1/team/publish', { spec }, { 'content-type': 'text/plain' })).status, 415);

    setEnabled(spec, 'design-director', true);
    const ok = await call('/v1/team/publish', { spec, branch: 'team/add-design', message: 'Add a design director' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.branch, 'team/add-design');
    assert.ok(ok.body.commit);
    assert.equal(git(root, 'log', '-1', '--format=%s'), 'Add a design director');
    assert.ok(existsSync(join(root, 'docs/team/roles/design-director.md')));
    assert.match(readFileSync(join(root, '.agent-team/team.json'), 'utf8'), /design-director/);
    assert.equal(git(root, 'status', '--porcelain'), '');
    execFileSync(process.execPath, [cli, 'check', '--dir', root], { stdio: 'ignore' });

    assert.equal((await call('/v1/team/publish', { spec, branch: start })).status, 409, 'an existing branch is refused');
    writeFileSync(join(root, '.agent-team/roles/web-dev.extend.md'), '**Model:** light\n');
    const dirty = await call('/v1/team/publish', { spec, branch: 'team/next' });
    assert.equal(dirty.status, 409);
    assert.match(dirty.body.error, /uncommitted/);
  });
});

test('a custom agent switched off, published and switched back on gets the identical brief', async () => {
  const root = repo();
  await serve(root, async (call) => {
    const { spec, kit } = (await call('/v1/team')).body;
    addAgent(spec, 'pricing-analyst', draftRole(spec, kit, { title: 'Pricing analyst', slug: 'pricing-analyst', reportsTo: 'chief-of-staff' }));
    const added = await call('/v1/team/publish', { spec, branch: 'team/pricing', message: 'Add a pricing analyst' });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const brief = readFileSync(join(root, 'docs/team/roles/pricing-analyst.md'), 'utf8');
    const source = readFileSync(join(root, '.agent-team/roles/pricing-analyst.md'), 'utf8');

    const off = (await call('/v1/team')).body.spec;
    setEnabled(off, 'pricing-analyst', false);
    const paused = await call('/v1/team/publish', { spec: off, branch: 'team/pricing-off', message: 'Switch the pricing analyst off' });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    assert.equal(readFileSync(join(root, '.agent-team/roles/pricing-analyst.md'), 'utf8'), source, 'the definition is kept');
    assert.ok(JSON.parse(readFileSync(join(root, '.agent-team/team.json'), 'utf8')).exclude.includes('pricing-analyst'));
    assert.equal(existsSync(join(root, 'docs/team/roles/pricing-analyst.md')), false, 'it is not installed');
    execFileSync(process.execPath, [cli, 'check', '--dir', root], { stdio: 'ignore' });

    const on = (await call('/v1/team')).body.spec;
    assert.equal(on.roles['pricing-analyst'].enabled, false);
    setEnabled(on, 'pricing-analyst', true);
    const back = await call('/v1/team/publish', { spec: on, branch: 'team/pricing-on', message: 'Switch the pricing analyst on' });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(readFileSync(join(root, 'docs/team/roles/pricing-analyst.md'), 'utf8'), brief);
    assert.ok(!JSON.parse(readFileSync(join(root, '.agent-team/team.json'), 'utf8')).exclude.includes('pricing-analyst'));
  });
});

test('graph gives the hand-offs, and suggestions read folders and build files', async () => {
  const root = repo();
  for (const d of ['apps/web/src', 'supabase/migrations', 'e2e', 'node_modules/x', 'docs/team/extra']) execFileSync('mkdir', ['-p', join(root, d)]);
  for (const f of ['apps/web/src/main.ts', 'supabase/migrations/1.sql', 'e2e/a.spec.ts']) writeFileSync(join(root, f), '');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest', build: 'vite build', e2e: 'playwright test' } }));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'app');
  await serve(root, async (call) => {
    const { spec } = (await call('/v1/team')).body;
    const g = await call('/v1/team/graph', { spec });
    assert.equal(g.status, 200);
    assert.ok(g.body.edges.length > 0);
    assert.ok(g.body.edges.every((e) => spec.roles[e.from]?.enabled && spec.roles[e.to]?.enabled));

    const s = (await call('/v1/team/suggestions', { spec })).body;
    const area = (p) => s.areas.find((a) => a.path === p);
    assert.equal(area('apps/web/')?.writer, 'web-dev');
    assert.equal(area('supabase/')?.writer, 'backend-dev');
    assert.ok(area('e2e/'));
    assert.ok(!s.areas.some((a) => /^(node_modules|docs\/team)/.test(a.path)), 'generated and vendored folders are never suggested');
    assert.deepEqual(s.checks.map((c) => c.run), ['npm run lint', 'npm test', 'npm run build', 'npm run e2e']);
    assert.equal(s.checks.find((c) => c.name === 'e2e').pool, 'browser');
    assert.ok(s.fromMarkdown.length > 0, 'a hand-written ownership.md is offered as a start');

    // Accepting them publishes ownership.json and gates.json that the kit's own checks pass.
    spec.ownership = { rows: s.areas.filter((a) => a.writer).map((a) => ({ path: a.path, writer: a.writer, notes: '' })) };
    spec.gates = { all: ['web'], pools: { build: 1, browser: 2 }, targets: { web: s.checks.map((c) => (c.pool ? { name: c.name, run: c.run, pool: c.pool } : { name: c.name, run: c.run })) } };
    spec.resources = { resources: [{ id: 'db', type: 'database', name: 'Supabase', config: {}, secrets: ['SUPABASE_URL'] }], bindings: [{ role: 'web-dev', resource: 'db', permission: 'read' }] };
    const ok = await call('/v1/team/publish', { spec, branch: 'team/areas' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.match(readFileSync(join(root, 'docs/team/ownership.md'), 'utf8'), /apps\/web\//);
    assert.match(readFileSync(join(root, 'scripts/agent-team/gates.sh'), 'utf8'), /npm run e2e/);
    assert.match(readFileSync(join(root, 'docs/team/roles/web-dev.md'), 'utf8'), /Supabase/);
    execFileSync(process.execPath, [cli, 'check', '--dir', root], { stdio: 'ignore' });
  });
});

test('the live board comes from the local event log, and the stream says when it changes', async () => {
  const root = repo();
  const home = mkdtempSync(join(tmpdir(), 'studio-home-'));
  const env = { ...process.env, AGENT_TEAM_HOME: home, AGENT_TEAM_ROOT: root };
  delete env.AGENT_TEAM_SERVER;
  const server = createStudio({ root, env });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const report = (...a) => execFileSync('bash', [join(root, 'scripts/agent-team/team-status.sh'), ...a], { env, stdio: 'ignore' });
  try {
    const empty = await (await fetch(`${base}/v1/team/board`)).json();
    assert.equal(empty.source, 'log');
    assert.deepEqual(empty.board.current, []);

    const ctl = new AbortController();
    const res = await fetch(`${base}/v1/team/board/stream`, { signal: ctl.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body.getReader();
    const changed = (async () => {
      const dec = new TextDecoder();
      let buf = '';
      while (!buf.includes('event: changed')) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); }
      return buf.includes('event: changed');
    })();
    await new Promise((r) => setTimeout(r, 200));
    report('web-dev', 'status', 'working', '--task', 'Invoices page');
    assert.ok(await changed, 'a report on this machine reaches the page');
    ctl.abort();

    const { board } = await (await fetch(`${base}/v1/team/board`)).json();
    assert.equal(board.current[0].role, 'web-dev');
    assert.equal(board.current[0].task, 'Invoices page');
  } finally { server.closeAllConnections(); server.close(); }
});
