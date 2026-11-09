// Kit 0.22 (ADR 0011): sync writes a brief for each teammate, names them in the org tree, and renders Hands to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT, build } from '../bin/agent-team.mjs';

const cli = join(KIT, 'bin/agent-team.mjs');
const sh = (root, args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });

function team(extensions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'members-sync-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  assert.equal(sh(root, ['init', '--preset', 'engineering', '--project', 'Acme', '--kit', 'file:' + KIT]).status, 0);
  mkdirSync(join(root, '.agent-team/roles'), { recursive: true });
  for (const [f, text] of Object.entries(extensions)) writeFileSync(join(root, '.agent-team/roles', f), text);
  return root;
}

const member = (name, extra = '') => `# ${name}\n\n**Based on:** backend-dev\n**Reports to:** cto\n${extra}`;

test('two teammates of one role get two briefs, with their own names and slugs', () => {
  const root = team({ 'backend-dev-2.extend.md': member('Maya'), 'backend-dev-3.extend.md': member('Leo') });
  const { files, warnings } = build(root);
  const maya = files.get('docs/team/roles/backend-dev-2.md');
  const leo = files.get('docs/team/roles/backend-dev-3.md');
  assert.ok(maya && leo, [...files.keys()].filter((k) => k.includes('roles/')).join('\n'));
  assert.match(maya, /^# Maya$/m);
  assert.match(leo, /^# Leo$/m);
  assert.doesNotMatch(maya, /\*\*Based on:\*\*/, 'Based on is a seat setting, not part of the brief');
  assert.match(maya, /roles\/backend-dev-2\.md/, '{{ROLE}} is filled with the teammate\'s own id');
  assert.doesNotMatch(maya, /\{\{ROLE\}\}/);
  assert.ok(!warnings.some((w) => /not installed/.test(w)), warnings.join('\n'));
  const instructions = files.get('docs/team/project-instructions.md');
  assert.match(instructions, /─ Maya \(backend-dev-2\), Backend dev \([^)]*\)\n/);
  assert.match(instructions, /─ Leo \(backend-dev-3\), Backend dev \([^)]*\)\n/);
  assert.match(maya, /^\*\*Type:\*\* Backend dev \(backend-dev\)$/m, 'the header names the role it is based on');
  assert.match(instructions, /├─ backend-dev \([^)]*\)\n/, 'a kit role keeps its plain line');
});

test('Hands to: structured lines name the target, and lines to roles the team lacks are left out', () => {
  const root = team();
  const { files } = build(root);
  const md = files.get('docs/team/roles/backend-dev.md');
  const section = md.split('## Hands to')[1].split('\n## ')[0];
  assert.match(section, /^- [A-Z][^(\n]* \(security-reviewer\): always$/m);
  for (const m of section.matchAll(/\(([a-z0-9-]+)\)/g)) assert.ok(files.has(`docs/team/roles/${m[1]}.md`), `${m[1]} is installed`);
  assert.doesNotMatch(md, /\{\{ROLE\}\}/);
  assert.match(md, /roles\/backend-dev\.md/);
});

test('a team without teammates gets the same org tree as before', () => {
  const { files } = build(team());
  assert.doesNotMatch(files.get('docs/team/project-instructions.md'), /─ [A-Z][^\n]*\([a-z0-9-]+\), /);
});

test('with subagents on, each teammate gets its own agent file, and AGENTS.md lists both', () => {
  const root = team({ 'backend-dev-2.extend.md': member('Maya'), 'backend-dev-3.extend.md': member('Leo') });
  const f = join(root, '.agent-team/team.json');
  const t = JSON.parse(readFileSync(f, 'utf8'));
  t.targets = ['claude-code', 'agents-md'];
  t.subagents = true;
  writeFileSync(f, JSON.stringify(t, null, 2) + '\n');
  const { files } = build(root);
  const agents = [...files.keys()].filter((k) => k.startsWith('.claude/agents/backend-dev'));
  assert.deepEqual(agents.sort(), ['.claude/agents/backend-dev-2.md', '.claude/agents/backend-dev-3.md', '.claude/agents/backend-dev.md']);
  assert.match(files.get('.claude/agents/backend-dev-2.md'), /^name: backend-dev-2$/m);
  assert.match(files.get('AGENTS.md'), /Maya \(backend-dev-2\), Backend dev/);
  assert.match(files.get('AGENTS.md'), /Leo \(backend-dev-3\), Backend dev/);
});
