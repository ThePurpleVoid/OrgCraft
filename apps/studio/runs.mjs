// What "start a run" sends the control plane: the team as it is published in the repository, never the unsaved
// canvas. A run is frozen on its roster (docs/product/m3-design.md, runs.roster), so the Studio sends exactly what the
// last publish committed: the commit, where the repository lives, and for each role its manager, the paths it writes,
// its model and its brief as sync rendered it.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { meetingAttendees, ownsPaths } from '../../packages/team-model/index.mjs';
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
  const files = git(root, 'ls-tree', '--name-only', 'HEAD', 'docs/team/roles/').split('\n');
  // The briefs and ownership as on disk (equal to HEAD: nothing is unpublished), meetings.json as committed.
  const read = (path) => (path === '.agent-team/meetings.json' ? git(root, 'show', `HEAD:${path}`) || null : existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null);
  const roster = teamFrom({ version, paths: files, read });
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
  return { mode: 'runner', team: { version: roster.version, repo: { url, ref }, summary: roster.summary, roles: roster.roles, ...(roster.meetings ? { meetings: roster.meetings } : {}) } };
}

/**
 * Where a managed team's work lands (ADR 0012): this checkout's upstream, as { url, ref }. The team itself is not read
 * from here (the control plane builds the roster from its accepted version), so nothing in .agent-team/ here counts.
 */
export function workRepoOf(root) {
  if (!git(root, 'rev-parse', '--git-dir')) throw new RunRefused(`${root} is not a git repository, so the team's work has nowhere to land`);
  const upstream = git(root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}');
  if (!upstream) throw new RunRefused(`push first: branch ${git(root, 'branch', '--show-current') || '(detached)'} has no upstream for the team's work`);
  const remote = upstream.split('/')[0];
  const url = publicRepoUrl(git(root, 'remote', 'get-url', remote));
  if (!url) throw new RunRefused(`the remote ${remote} has no URL the team's sessions could use`);
  return { url, ref: upstream.slice(remote.length + 1) };
}

/**
 * The roster a run is frozen on, from a published version's files: the one parser for a team in a repository (above)
 * and a managed team (ADR 0012; the control plane reads the accepted main from its own store). `paths` are the
 * version's paths (only docs/team/roles/<slug>.md count), `read(path)` a file's text or null. Returns
 * { version, summary, roles, meetings? }, or throws RunRefused when the roster could not start a run.
 */
export function teamFrom({ version, paths, read }) {
  const slugsOf = paths.filter((p) => /^docs\/team\/roles\/[a-z0-9-]+\.md$/.test(p) && !/README\.md$/.test(p)).map((p) => p.slice(p.lastIndexOf('/') + 1, -3));
  if (!slugsOf.length) throw new RunRefused('publish first: there are no role briefs in docs/team/roles');
  // A missing file is null; one that does not parse refuses the run, as before the shared parser (code review L31w).
  const json = (path) => { const t = read(path); if (t === null || t === undefined) return null; try { return JSON.parse(t); } catch { throw new RunRefused(`${path} in the published team is not valid JSON; fix it and publish again`); } };
  const own = json('.agent-team/ownership.json');
  const ownership = own ? own.rows ?? [] : null;
  const mds = slugsOf.map((slug) => ({ slug, md: read(`docs/team/roles/${slug}.md`) ?? '' }));
  const roles = mds.map(({ slug, md }) => {
    const b = parseBrief(slug, md);
    const areas = ownership ? ownership.filter((r) => r.writer === slug).flatMap((r) => String(r.path).split(/,\s*/)) : ownsPaths(md).paths.filter((x) => x.mode === 'writes').map((x) => x.path);
    return { slug, reportsTo: b.reportsTo, areas: [...new Set(areas.map((a) => a.replace(/`/g, '').trim()).filter(Boolean))], ...(b.model ? { model: b.model } : {}), status: b.status, brief: cut(md, BRIEF_MAX, '\n\n(cut to fit a run)') };
  });
  const slugs = new Set(roles.map((r) => r.slug));
  for (const r of roles) if (!r.reportsTo) throw new RunRefused(`${r.slug}'s brief does not say who it reports to`);
  for (const r of roles) if (r.reportsTo !== 'owner' && !slugs.has(r.reportsTo)) throw new RunRefused(`${r.slug} reports to ${r.reportsTo}, which is not in the published team`);
  const doors = roles.filter((r) => r.reportsTo === 'owner');
  if (doors.length !== 1) throw new RunRefused(`exactly one role must report to the owner; the published team has ${doors.length}${doors.length ? ` (${doors.map((r) => r.slug).join(', ')})` : ''}`);
  const team = json('.agent-team/team.json') ?? {};
  const name = team.values?.PROJECT_NAME ?? 'This team';
  const active = roles.filter((r) => r.status !== 'dormant').length;
  const summary = `${name}: ${roles.length} roles (${active} active), ${doors[0].slug} reports to the owner. Published at ${version.slice(0, 12)}${team.kit ? ` with ${team.kit}` : ''}.`;
  const m = meetingsFrom(json('.agent-team/meetings.json'), mds);
  return { version, summary: cut(summary, SUMMARY_MAX, '…'), roles, ...(m.length ? { meetings: m } : {}) };
}

/**
 * The team's meetings for a run (RunCreate.team.meetings): each meetings.json entry as published, with its attendees
 * resolved here, where the briefs are, in meetingAttendees' order and without the facilitator. The control plane only
 * adds the roles the worked-since-last rule finds at start.
 */
export function meetings(root, roles) {
  let raw;
  try { raw = JSON.parse(git(root, 'show', 'HEAD:.agent-team/meetings.json') || 'null'); } catch { return []; }
  return meetingsFrom(raw, roles);
}

/** meetings() on a parsed meetings.json. */
function meetingsFrom(raw, roles) {
  const list = Array.isArray(raw?.meetings) ? raw.meetings : [];
  return list.map((m) => {
    const who = meetingAttendees(m, roles).roles.filter((s) => s !== m.facilitator);
    const { attendees, when, skipIfQuiet, ...rest } = m;
    return { ...rest, attendees: who, ...(attendees?.rule ? { rule: attendees.rule } : {}) };
  // A meeting with nobody to meet would refuse the whole run; it stays a definition until it has attendees.
  }).filter((m) => m.attendees.length || m.rule);
}
