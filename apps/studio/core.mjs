// The Studio's shared core (docs/specs/studio-embed.md section 2): the same code in every mode turns a team's read set
// and a TeamSpec into what a publish changes. Sync is never run in a working tree: the read set is written into a
// fresh temp dir, the compiled layer goes on top, sync runs there, and the result is compared with the read set. So a
// local publish and a publish through GitHub write byte-identical files by construction.
//
// A read is { files: [{ path, content, mode }], base } where mode is '100644' or '100755' and base is the commit it was
// read at (or null for a working tree with no commits).
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { DEFAULT_KIT_SPEC, initExtras, KIT, sync, VERSION } from '../../bin/agent-team.mjs';
import { compileLayer, importLayer, resolveSpec, TEMPLATE_SCHEMA, templateCard, templateSpec, validate, withoutBlock } from '../../packages/team-model/index.mjs';
import { loadKit, loadTemplates, readLayer, writeLayer } from '../../packages/team-model/node.mjs';
import { parseBrief } from '../../tools/briefs.mjs';
import { graphFrom } from '../../tools/roster-graph.mjs';
import { foldersOf, ownershipFromText, suggestAreasFrom, suggestChecksFrom } from './suggest.mjs';

/** What build and sync read and write, so also everything a publish may change (E5). */
export const READ_SET = ['.agent-team/', 'docs/team/', 'scripts/agent-team/', '.claude/', 'AGENTS.md', '.gitignore'];
export const inReadSet = (p) => typeof p === 'string' && !p.split('/').some((s) => s === '' || s === '.' || s === '..')
  && READ_SET.some((r) => (r.endsWith('/') ? p.startsWith(r) : p === r));
/** Files `agent-team init` writes once besides the layer; a first publish adds them too. */
export const INIT_FILES = ['.agent-team/config.sh', '.agent-team/roles/README.md', 'docs/team/ownership.md', 'docs/team/lanes/_template.md'];
const MAX_FILE = 1024 * 1024;
const MODES = new Set(['100644', '100755']);

export class CoreError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); } }

const semver = (v) => String(v ?? '').split('.').map((n) => Number.parseInt(n, 10) || 0);
const compare = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };

/** A read set's files as a map, checked: paths inside the read set, known modes, text only. */
function filesOf(read) {
  const map = new Map();
  for (const f of read?.files ?? []) {
    if (!inReadSet(f.path)) throw new CoreError(500, `the read set has a path outside it: ${String(f.path).slice(0, 200)}`);
    map.set(f.path, { content: String(f.content), mode: MODES.has(f.mode) ? f.mode : '100644' });
  }
  return map;
}

/** Writes a read set into `dir` (made 0700 by mkdtemp), with its modes. */
export function materialize(dir, files) {
  for (const [path, f] of files) {
    const p = join(dir, ...path.split('/'));
    if (!p.startsWith(dir + sep)) throw new CoreError(500, `refusing ${path}`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
    if (f.mode === '100755') chmodSync(p, 0o755);
  }
}

/** The read set as it is in `dir`: regular files only (no symlinks), with sync's executable bit. */
export function readDir(dir) {
  const out = new Map();
  const walk = (rel) => {
    const abs = join(dir, ...rel.split('/').filter(Boolean));
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && inReadSet(p)) out.set(p, { content: readFileSync(join(dir, ...p.split('/')), 'utf8'), mode: statSync(join(dir, ...p.split('/'))).mode & 0o111 ? '100755' : '100644' });
    }
  };
  for (const r of READ_SET) {
    if (r.endsWith('/')) walk(r.slice(0, -1));
    else { const p = join(dir, r); if (existsSync(p) && lstatSync(p).isFile()) out.set(r, { content: readFileSync(p, 'utf8'), mode: statSync(p).mode & 0o111 ? '100755' : '100644' }); }
  }
  return out;
}

/**
 * Runs `fn(dir)` in a fresh temp dir holding the read set, and always removes it. `tmpRoot` puts it under a folder of
 * its own (hosted mode keeps one per customer, S3); it is made 0700 when missing.
 */
function scratch(files, fn, tmpRoot = null) {
  if (tmpRoot) mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(tmpRoot ?? tmpdir(), 'agent-team-studio-'));
  try { materialize(dir, files); return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const hasTeam = (files) => files.has('.agent-team/team.json');

/** The kit version that last synced this read set, and what that means for a publish (section 2, "Kit version"). */
export function kitVersionOf(files) {
  let synced = null;
  try { synced = JSON.parse(files.get('.agent-team/kit.lock.json')?.content ?? 'null')?.version ?? null; } catch { /* unreadable lock: treat as never synced */ }
  const cmp = synced ? compare(synced, VERSION) : -1;
  if (synced && cmp > 0) throw new CoreError(409, `this repository was synced by kit ${synced}; update the Studio to ${synced} or later`, { type: 'kit-newer' });
  return { synced, studio: VERSION, upgrade: synced && cmp < 0 ? `this also moves the team from kit ${synced} to ${VERSION}` : null };
}

/** Everything the page needs to start, from a read set (the same shape the local Studio always answered). */
export function state(read) {
  const kit = loadKit(KIT);
  const files = filesOf(read);
  if (!hasTeam(files)) return { kitVersion: VERSION, spec: null, noTeam: true, kit, kitRoles: null, base: read.base ?? null };
  const kitInfo = kitVersionOf(files);
  let kitRoles = null;
  try { kitRoles = JSON.parse(files.get('.agent-team/kit.lock.json')?.content ?? 'null')?.kitRoles ?? null; } catch { /* never synced */ }
  const spec = scratch(new Map([...files].filter(([p]) => p.startsWith('.agent-team/'))), (dir) => importLayer(readLayer(dir), kit));
  return { kitVersion: VERSION, spec, kit, kitRoles, base: read.base ?? null, kitUpgrade: kitInfo.upgrade };
}

/** The files init writes once (config.sh, the roles README, ownership.md, the lane template, .gitignore). */
function extras(dir, layer) {
  const values = JSON.parse(layer['team.json']).values ?? {};
  const slug = String(values.PROJECT_NAME ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  initExtras(dir, slug, values, { ownership: !layer['ownership.json'], quiet: true });
}

/**
 * What publishing `spec` changes in the read set: [{ path, content (null = delete), mode, before }], sorted by path.
 * Throws a CoreError when the spec has errors, sync fails or a change breaks a limit.
 */
export function plan(read, spec, { strict = true, tmpRoot = null } = {}) {
  const kit = loadKit(KIT);
  const files = filesOf(read);
  kitVersionOf(files);
  let issues, layer;
  // A malformed team from the page is the page's mistake (422), not a server failure.
  try { issues = validate(spec, kit); layer = compileLayer(spec, kit); } catch (e) { throw new CoreError(422, `the team could not be read: ${String(e?.message ?? e).slice(0, 200)}`); }
  const after = scratch(files, (dir) => {
    writeLayer(dir, layer);
    if (!hasTeam(files)) extras(dir, layer);
    let rc;
    try { rc = sync(dir, { quiet: true }); } catch (e) { throw new CoreError(422, e.message, { issues }); }
    if (rc !== 0 && strict) throw new CoreError(422, 'sync reported roster errors; nothing would be published', { issues });
    return readDir(dir);
  }, tmpRoot);
  const changes = [];
  for (const path of new Set([...files.keys(), ...after.keys()])) {
    const a = files.get(path), b = after.get(path);
    if (a && b && a.content === b.content && a.mode === b.mode) continue;
    if (!inReadSet(path)) throw new CoreError(500, `a change outside the read set: ${path}`);
    if (b && Buffer.byteLength(b.content) > MAX_FILE) throw new CoreError(413, `${path} would be larger than 1 MB`);
    changes.push({ path, content: b ? b.content : null, mode: b ? b.mode : (a?.mode ?? '100644'), before: a ? a.content : null });
  }
  changes.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return { changes, issues, ...code(changes) };
}

/** Files whose change changes what runs: gates, systems, config.sh, and any script (S1 a). */
export const isCodePath = (c) => c.path === '.agent-team/gates.json' || c.path === '.agent-team/resources.json' || c.path === '.agent-team/config.sh'
  || c.path.endsWith('.sh') || c.mode === '100755'
  // Claude Code's hooks run commands, and anything under scripts/agent-team/ is run by the team (review V3).
  || /^\.claude\/settings[^/]*\.json$/.test(c.path) || c.path.startsWith('scripts/agent-team/');
const isJsonCommands = (path) => path === '.agent-team/gates.json' || path === '.agent-team/resources.json' || /^\.claude\/settings[^/]*\.json$/.test(path);

/**
 * Whether a set of changes needs the publish-code permission, and the commands it adds or changes, verbatim (S1 a, b):
 * each gate's `run` that is new or different, and each new or changed line of a script or config.sh.
 */
export function code(changes) {
  const commands = [];
  const lines = (s) => new Set(String(s ?? '').split('\n'));
  for (const c of changes.filter(isCodePath)) {
    if (isJsonCommands(c.path)) {
      const runs = (text) => { const out = []; const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { if ((k === 'run' || k === 'command') && typeof v === 'string') out.push(v); else walk(v); } }; try { walk(JSON.parse(text ?? 'null')); } catch { /* not JSON */ } return out; };
      const old = new Set(runs(c.before));
      for (const r of runs(c.content)) if (!old.has(r)) commands.push({ path: c.path, line: r });
    } else if (c.content !== null) {
      const old = lines(c.before);
      for (const l of String(c.content).split('\n')) if (l.trim() && !l.trim().startsWith('#') && !old.has(l)) commands.push({ path: c.path, line: l });
    }
  }
  return { needsCode: changes.some(isCodePath), commands };
}

/** The preview the page shows: [{ path, status, before, after }], the issues, the commands and the kit upgrade. */
export function preview(read, spec, { tmpRoot = null } = {}) {
  const files = filesOf(read);
  const p = plan(read, spec, { strict: false, tmpRoot });
  return {
    changes: p.changes.map((c) => ({ path: c.path, status: c.before === null ? 'added' : c.content === null ? 'removed' : 'changed', before: c.before, after: c.content })),
    issues: p.issues, commands: p.commands, needsCode: p.needsCode, kitUpgrade: kitVersionOf(files).upgrade,
  };
}

/** The "Commands this PR adds or changes" section (S1 b), or '' when there are none. */
export function commandsSection(commands) {
  if (!commands.length) return '';
  // A backtick fence longer than any backtick run in the commands, so no command can close it (review V1).
  const longest = Math.max(0, ...commands.map((c) => Math.max(0, ...(c.line.match(/`+/g) ?? []).map((r) => r.length))));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `### Commands this PR adds or changes\n\n${fence}\n${commands.map((c) => `${c.line}    # ${c.path}`).join('\n')}\n${fence}`;
}

/** `name` as it may appear in a trailer: no control characters, at most 100 characters (S5). */
export const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'someone';

/**
 * The commit message: the user's text without forged trailers, then `Published-by:` last (S5). Only a display name and
 * the host's user id, never an email address or a token.
 */
export function commitMessage(text, user) {
  const body = String(text ?? '').replace(/\r/g, '').split('\n').filter((l) => !/^\s*(published-by|co-authored-by)\s*:/i.test(l)).join('\n').trim() || 'Update the agent team (OrgCraft Studio)';
  return user ? `${body}\n\nPublished-by: ${cleanName(user.name)} (${cleanName(user.id)}) via OrgCraft Studio` : body;
}

/**
 * Another site the deployment published for (studio-embed.md section 6, security C3): its name and its own user, both
 * host-controlled text, so cleaned like a trailer name, with `@` defused and backticks gone. Never a trailer.
 */
export const cleanVia = (v) => {
  const t = (s) => cleanName(String(s ?? '').replace(/`/g, '')).replace(/@/g, '&#64;');
  return { host: t(v?.host), ...(v?.user ? { user: t(v.user) } : {}), ...(v?.hostId ? { hostId: cleanName(v.hostId) } : {}) };
};

/** The pull request's title and body: the user's text quoted, with `@` defused so it pings nobody (S5), and the commands. */
export function pullRequestBody(text, { commands = [], kitUpgrade = null, commit = null, via = null } = {}) {
  const [first, ...rest] = String(text ?? '').replace(/\r/g, '').split('\n').filter((l) => !/^\s*(published-by|co-authored-by)\s*:/i.test(l));
  const defuse = (s) => s.replace(/@/g, '&#64;');
  const title = cleanName(defuse(first ?? '')).slice(0, 100) || 'Update the agent team (OrgCraft Studio)';
  const quoted = rest.join('\n').trim();
  return {
    title,
    body: [quoted ? quoted.split('\n').map((l) => `> ${defuse(l)}`).join('\n') : '', kitUpgrade ? `This also moves the team to kit ${VERSION}.` : '', commandsSection(commands),
      via ? (({ host, user }) => `Published through ${host}${user ? ` for \`${user}\`` : ''}.`)(cleanVia(via)) : '',
      `Published from OrgCraft Studio${commit ? ` (commit ${commit.slice(0, 12)})` : ''}. Review it like any change to the team's rules: a person with write access merges it.`].filter(Boolean).join('\n\n'),
  };
}

/** "Start almost empty" (D32): a chief of staff only, as a template the gallery does not list. */
export const ALMOST_EMPTY = { schema: TEMPLATE_SCHEMA, id: 'almost-empty', title: 'Almost empty', summary: 'A chief of staff only.', group: 'product', preset: 'minimal', roles: ['chief-of-staff'] };

/**
 * The TeamSpec a template makes for the create form's answers (D31): the same spec `agent-team init --template`
 * compiles, so a publish writes the same files (criterion 9). Refused once the repository has a team (D32).
 */
export function templateDraft({ id, project, owner, timezone } = {}, { hasTeam: team = false, fallbackProject = 'the product' } = {}) {
  if (team) throw new CoreError(409, 'this repository already has a team; open it instead');
  const kit = loadKit(KIT);
  const files = id === ALMOST_EMPTY.id ? { 'template.json': JSON.stringify(ALMOST_EMPTY) } : loadTemplates(KIT)[id];
  if (!files) throw new CoreError(404, `no template "${String(id).slice(0, 80)}"`);
  const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const spec = templateSpec(files, kit, { project: text(project, 80) ?? fallbackProject, owner: text(owner, 80) ?? 'the owner', timezone: text(timezone, 64) ?? 'UTC', kitVersion: VERSION, kitSpec: DEFAULT_KIT_SPEC });
  if (id === ALMOST_EMPTY.id) delete spec.options.from;
  return { spec, card: id === ALMOST_EMPTY.id ? null : templateCard(files, kit) };
}

/** The kit's templates as the gallery shows them (D31, D33), each with nothing written. */
export const templateCards = (kit = loadKit(KIT)) => Object.values(loadTemplates(KIT)).map((files) => templateCard(files, kit));

/** Who hands work to whom, for the Flow view: the dashboard's graph of the team as the spec resolves it. */
export function graph(spec) {
  const { roles } = resolveSpec(spec, loadKit(KIT));
  const g = graphFrom(roles.map((r) => parseBrief(r.slug, r.md)));
  return { edges: g.edges, unresolved: g.unresolved };
}

/**
 * Owned areas and checks a repository suggests, from its paths: `paths` (every file), `read(path)` for a root build
 * file's text, and the read set (for a hand-written ownership.md).
 */
export function suggestionsFrom(spec, { paths, read: readFile = () => null, team: files = new Map() }) {
  const kit = loadKit(KIT);
  const { roles } = resolveSpec(spec, kit);
  const team = new Set(roles.map((r) => r.slug));
  const titles = new Map(roles.map((r) => [parseBrief(r.slug, r.md).title.toLowerCase(), r.slug]));
  const root = new Set(paths.filter((p) => !p.includes('/')));
  const md = files instanceof Map ? files.get('docs/team/ownership.md')?.content : undefined;
  return { areas: suggestAreasFrom(foldersOf(paths), spec.ownership?.rows ?? [], team), checks: suggestChecksFrom((p) => root.has(p), readFile), fromMarkdown: spec.ownership ? [] : ownershipFromText(md, titles) };
}

export { DEFAULT_KIT_SPEC, VERSION, withoutBlock, filesOf };
