// What "start a run" sends the control plane: the team as it is published in the repository, never the unsaved
// canvas. A run is frozen on its roster (docs/product/m3-design.md, runs.roster), so the Studio sends exactly what the
// last publish committed: the commit, where the repository lives, and for each role its manager, the paths it writes,
// its model and its brief as sync rendered it.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ownsPaths } from '../../packages/team-model/index.mjs';
import { parseBrief } from '../../tools/briefs.mjs';

const BRIEF_MAX = 20_000; // bytes: the control plane refuses a longer brief
const SUMMARY_MAX = 2_000;

/** Cuts text to at most `max` UTF-8 bytes, on a character boundary, saying so at the end. */
function cut(text, max, note) {
  if (Buffer.byteLength(text) <= max) return text;
  let s = Buffer.from(text).subarray(0, max - Buffer.byteLength(note)).toString('utf8');
  while (Buffer.byteLength(s + note) > max || s.endsWith('\uFFFD')) s = s.slice(0, -1);
  return s + note;
}
const git = (root, ...args) => { try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { return ''; } };

export class RunRefused extends Error { constructor(message) { super(message); this.status = 409; } }

/** A remote URL without its user name or password, so a token in a clone URL never leaves this machine. */
export function publicRepoUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    u.username = ''; u.password = '';
    return u.toString();
  } catch {
    // scp-like git@host:owner/repo.git carries no secret; nor does a path to a repository on this machine.
    if (/^[\w.-]+@[\w.-]+:[\w./-]+$/.test(raw)) return raw;
    return raw.startsWith('/') ? `file://${raw}` : null;
  }
}

/**
 * The RunCreate body for the team published in `root`: { mode, team: { version, repo: { url, ref }, summary, roles } }.
 * Field names agreed with backend-dev for the runner's roster (issue #28, 2b): summary is text up to 2,000 characters,
 * each brief is its text up to 20 KB, repo.url never carries credentials.
 * Refuses (409) when the team's files have changes nobody published, or when the roster could not start a run.
 */
export function runRequest(root, { dirty = [] } = {}) {
  if (!git(root, 'rev-parse', '--git-dir')) throw new RunRefused(`${root} is not a git repository, so there is no published team to run`);
  if (dirty.length) throw new RunRefused(`publish first: the team's files have changes nobody published (${dirty.slice(0, 3).join(', ')})`);
  const version = git(root, 'rev-parse', 'HEAD');
  if (!version) throw new RunRefused('publish first: this repository has no commits yet');
  const dir = join(root, 'docs/team/roles');
  const files = git(root, 'ls-tree', '--name-only', 'HEAD', 'docs/team/roles/').split('\n').filter((p) => /\/[a-z0-9-]+\.md$/.test(p) && !/README\.md$/.test(p));
  if (!files.length) throw new RunRefused('publish first: there are no role briefs in docs/team/roles');
  const ownership = existsSync(join(root, '.agent-team/ownership.json')) ? JSON.parse(readFileSync(join(root, '.agent-team/ownership.json'), 'utf8')).rows ?? [] : null;
  const roles = files.map((p) => {
    const slug = p.slice(p.lastIndexOf('/') + 1, -3);
    const md = readFileSync(join(dir, `${slug}.md`), 'utf8');
    const b = parseBrief(slug, md);
    const areas = ownership ? ownership.filter((r) => r.writer === slug).flatMap((r) => String(r.path).split(/,\s*/)) : ownsPaths(md).paths.filter((x) => x.mode === 'writes').map((x) => x.path);
    return { slug, reportsTo: b.reportsTo, areas: [...new Set(areas.map((a) => a.replace(/`/g, '').trim()).filter(Boolean))], ...(b.model ? { model: b.model } : {}), status: b.status, brief: cut(md, BRIEF_MAX, '\n\n(cut to fit a run)') };
  });
  const slugs = new Set(roles.map((r) => r.slug));
  for (const r of roles) if (!r.reportsTo) throw new RunRefused(`${r.slug}'s brief does not say who it reports to`);
  for (const r of roles) if (r.reportsTo !== 'owner' && !slugs.has(r.reportsTo)) throw new RunRefused(`${r.slug} reports to ${r.reportsTo}, which is not in the published team`);
  const doors = roles.filter((r) => r.reportsTo === 'owner');
  if (doors.length !== 1) throw new RunRefused(`exactly one role must report to the owner; the published team has ${doors.length}${doors.length ? ` (${doors.map((r) => r.slug).join(', ')})` : ''}`);
  const team = existsSync(join(root, '.agent-team/team.json')) ? JSON.parse(readFileSync(join(root, '.agent-team/team.json'), 'utf8')) : {};
  const name = team.values?.PROJECT_NAME ?? 'This team';
  const active = roles.filter((r) => r.status !== 'dormant').length;
  const summary = `${name}: ${roles.length} roles (${active} active), ${doors[0].slug} reports to the owner. Published at ${version.slice(0, 12)}${team.kit ? ` with ${team.kit}` : ''}.`;
  // Sessions check out the repository from its remote, so the run must be pinned to a commit the remote has: publish
  // commits but does not push. HEAD must be what the upstream branch is, as far as this clone last fetched or pushed.
  const upstream = git(root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}');
  if (!upstream) throw new RunRefused(`push first: branch ${git(root, 'branch', '--show-current') || '(detached)'} has no upstream, so the team's sessions could not check out ${version.slice(0, 12)}`);
  const remote = upstream.split('/')[0];
  if (git(root, 'rev-parse', '@{upstream}') !== version) {
    const ahead = git(root, 'rev-list', '--count', '@{upstream}..HEAD');
    throw new RunRefused(`push first: ${ahead && ahead !== '0' ? `${ahead} published commit${ahead === '1' ? ' is' : 's are'} not on ${upstream}` : `HEAD is not ${upstream}`}, so the team would run an older team or none`);
  }
  const url = publicRepoUrl(git(root, 'remote', 'get-url', remote));
  if (!url) throw new RunRefused(`the remote ${remote} has no URL the team's sessions could use`);
  const ref = upstream.slice(remote.length + 1);
  return {
    mode: 'runner',
    team: {
      version,
      repo: { url, ref },
      summary: cut(summary, SUMMARY_MAX, '…'),
      roles,
    },
  };
}
