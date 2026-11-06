// The merge gate and hardware locks without bash (tools/merge-gate.mjs, tools/with-lock.mjs): the same arguments,
// summary, logs, lock folders and exit codes as merge-gate.sh and with-lock.sh, checked on both paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { KIT } from '../bin/agent-team.mjs';
import { claim, poolSlots } from '../tools/with-lock.mjs';

const cli = join(KIT, 'bin/agent-team.mjs');
const GATES = {
  all: ['good'], pools: { one: 1, backend: 1 },
  targets: {
    good: [{ name: 'true', run: 'true' }, { name: 'locked', run: 'echo locked-ran', pool: 'backend' }],
    bad: [{ name: 'false', run: 'exit 3' }],
  },
};

function repo() {
  const tmp = mkdtempSync(join(tmpdir(), 'gates-'));
  const root = join(tmp, 'r');
  mkdirSync(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const env = { ...process.env, HOME: join(tmp, 'home'), AGENT_TEAM_HOME: join(tmp, 'state'), AGENT_TEAM_ROOT: root };
  for (const k of ['TEAM_REPORT_URL', 'TEAM_REPORT_TOKEN', 'AGENT_TEAM_POOLS', 'AGENT_TEAM_GATES_ALL', 'AGENT_TEAM_ROLE']) delete env[k];
  execFileSync(process.execPath, [cli, 'init', '--preset', 'minimal', '--project', 'Gates', '--dir', root], { stdio: 'ignore', env });
  writeFileSync(join(root, '.agent-team/gates.json'), JSON.stringify(GATES, null, 2) + '\n');
  writeFileSync(join(root, '.agent-team/config.sh'), `${readFileSync(join(root, '.agent-team/config.sh'), 'utf8')}\ngate_shonly() { run "shonly: ok" true; }\n`);
  execFileSync(process.execPath, [cli, 'sync', '--dir', root], { stdio: 'ignore', env });
  return { root, env, s: join(root, 'scripts/agent-team') };
}

const PATHS = {
  bash: (s) => ['bash', [join(s, 'merge-gate.sh')]],
  node: (s) => [process.execPath, [join(s, 'merge-gate.mjs')]],
};
const gate = (r, path, args, env = r.env) => {
  const [cmd, pre] = PATHS[path](r.s);
  const p = spawnSync(cmd, [...pre, ...args], { cwd: r.root, env, encoding: 'utf8' });
  return { code: p.status, out: p.stdout, err: p.stderr };
};
// The summary without the commit and branch, which both paths print the same way.
const summary = (out) => out.replace(/@ \S+ on \S+/, '@ X on Y').replace(/-\d{8}-\d{6}\.log/g, '-STAMP.log');

test('merge gate: both paths give the same summary and exit codes', () => {
  const r = repo();
  for (const [args, code] of [[['all'], 0], [['good'], 0], [['good', 'bad'], 1], [['bad'], 1], [['missing'], 64], [[], 64], [['--list'], 0]]) {
    const b = gate(r, 'bash', args);
    const n = gate(r, 'node', args);
    assert.equal(b.code, code, `bash ${args}: ${b.err}`);
    assert.equal(n.code, code, `node ${args}: ${n.err}`);
    assert.equal(summary(n.out), summary(b.out), `node and bash differ for ${args}`);
  }
  const n = gate(r, 'node', ['good', 'bad']);
  assert.match(n.out, /== good: true\n== good: locked\n== bad: false\n\nmerge-gate \(good bad\) @ \S+ on \S+\n {2}PASS good: true\n {2}PASS good: locked\n {2}FAIL bad: false \(\.merge-gate\/bad-\d{8}-\d{6}\.log\)\n$/);
  const logs = readdirSync(join(r.root, '.merge-gate'));
  const goodLog = readFileSync(join(r.root, '.merge-gate', logs.filter((f) => f.startsWith('good-')).sort().at(-1)), 'utf8');
  assert.match(goodLog, /locked-ran/);
  assert.match(goodLog, /with-lock: backend slot-1 -> echo locked-ran/);
  assert.match(gate(r, 'node', ['missing']).err, /no gate_missing in \.agent-team\/config\.sh \(targets: backend bad good shonly web \)/);
  assert.match(gate(r, 'node', ['--list']).err, /bash only, in \.agent-team\/config\.sh: .*shonly/);
});

test('merge gate: a config.sh-only target goes to merge-gate.sh with bash, and is refused clearly without it', () => {
  const r = repo();
  const withBash = gate(r, 'node', ['shonly']);
  assert.equal(withBash.code, 0);
  assert.match(withBash.err, /shonly is a bash function in \.agent-team\/config\.sh; running merge-gate\.sh/);
  assert.match(withBash.out, /PASS shonly: ok/);
  // No bash on the PATH: only node's own folder (git is not needed, AGENT_TEAM_ROOT names the repository).
  const noBash = { ...r.env, PATH: dirname(process.execPath) };
  if (spawnSync('bash', ['-c', 'exit 0'], { env: noBash }).status === 0) return; // node and bash share a folder here
  const refused = gate(r, 'node', ['shonly'], noBash);
  assert.equal(refused.code, 64);
  assert.match(refused.err, /this machine has no bash\. Move it into \.agent-team\/gates\.json/);
  // gates.json targets still run without bash, through the system shell.
  const ran = gate(r, 'node', ['good'], noBash);
  assert.equal(ran.code, 0, ran.err);
  assert.match(ran.out, /PASS good: locked/);
});

const lockRun = (r, path, pool, cmd, env = r.env) => {
  const script = join(r.s, path === 'bash' ? 'with-lock.sh' : 'with-lock.mjs');
  return path === 'bash' ? ['bash', [script, pool, '--', ...cmd], env] : [process.execPath, [script, pool, '--', ...cmd], env];
};

test('with-lock: same usage and exit codes on both paths, and one pool shared between them', async () => {
  const r = repo();
  for (const path of ['bash', 'node']) {
    const [c, a] = lockRun(r, path, 'backend', ['echo', 'hi']);
    const ok = spawnSync(c, a, { env: r.env, encoding: 'utf8' });
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout, 'hi\n');
    const [c2, a2] = lockRun(r, path, 'nope', ['true']);
    assert.equal(spawnSync(c2, a2, { env: r.env }).status, 64, path);
    const [c3, a3] = lockRun(r, path, 'backend', []);
    assert.equal(spawnSync(c3, a3, { env: r.env }).status, 64, `${path} usage`);
    const [c4, a4] = lockRun(r, path, 'backend', ['sh', '-c', 'exit 7']);
    assert.equal(spawnSync(c4, a4, { env: r.env }).status, 7, `${path} passes the exit code on`);
  }
  // A slot held by one path makes the other wait and give up with 75; the pool comes from gates.json ("one": 1).
  const fast = { ...r.env, WITH_LOCK_TIMEOUT: '1', WITH_LOCK_POLL: '1' };
  for (const [holder, waiter] of [['bash', 'node'], ['node', 'bash']]) {
    const [hc, ha] = lockRun(r, holder, 'one', ['sleep', '3']);
    const held = spawn(hc, ha, { env: r.env, stdio: 'ignore' });
    await new Promise((res) => setTimeout(res, 800));
    const [wc, wa] = lockRun(r, waiter, 'one', ['true']);
    const waited = spawnSync(wc, wa, { env: fast, encoding: 'utf8' });
    assert.equal(waited.status, 75, `${waiter} waits for ${holder}: ${waited.stderr}`);
    assert.match(waited.stderr, /no free 'one' slot after 1s \(BLOCKED\)/);
    await new Promise((res) => held.on('exit', res));
    const [ac, aa] = lockRun(r, waiter, 'one', ['true']);
    assert.equal(spawnSync(ac, aa, { env: fast }).status, 0, `${waiter} gets the slot once ${holder} is done`);
  }
});

test('with-lock: a slot whose owner died is reclaimed, and pools parse like with-lock.sh', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'locks-')), 'pool');
  mkdirSync(join(dir, 'slot-1'), { recursive: true });
  writeFileSync(join(dir, 'slot-1/pid'), '999999999\n');
  const slot = claim(dir, 1);
  assert.equal(slot, join(dir, 'slot-1'));
  assert.equal(readFileSync(join(slot, 'pid'), 'utf8'), `${process.pid}\n`);
  assert.equal(claim(dir, 1), null, 'a live owner keeps its slot');
  assert.ok(existsSync(join(dir, 'slot-1')));
  assert.equal(poolSlots('build:2 backend:1', 'backend'), 1);
  assert.equal(poolSlots('build:2 backend:x', 'backend'), 0);
  assert.equal(poolSlots('build:2', 'nope'), 0);
});
