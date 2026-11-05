#!/usr/bin/env node
// The same as sync.sh, for machines without bash (Windows): regenerates this repository's agent team from
// .agent-team/ with the Agent Team Kit version pinned in .agent-team/team.json ("kit").
//
//   node scripts/agent-team/sync.mjs [sync|check|roles|doctor]
//
// AGENT_TEAM_KIT_DIR=/path/to/a/kit/checkout uses a local copy of the kit instead of npx.
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let root = process.cwd();
try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || root; } catch { /* not a git checkout */ }
const args = process.argv.slice(2);
if (!args.length) args.push('sync');
const local = process.env.AGENT_TEAM_KIT_DIR;
const kit = local ? null : JSON.parse(readFileSync(join(root, '.agent-team/team.json'), 'utf8')).kit;
const [cmd, ...rest] = local ? [process.execPath, join(local, 'bin/agent-team.mjs')] : ['npx', '--yes', kit];
const r = spawnSync(cmd, [...rest, ...args], { cwd: root, stdio: 'inherit', shell: !local && process.platform === 'win32' });
process.exitCode = r.status ?? 1;
