// The team model: one JSON document (a TeamSpec) that describes a team, and the functions that turn a project
// layer (.agent-team/) into a TeamSpec and back. The CLI, the Studio server and the Studio editor share this module,
// so it is pure: no file system, no Node-only APIs. Callers pass the files and the kit's role library in.
//
//   importLayer(files, kit) → TeamSpec      files: { 'team.json': '...', 'roles/x.extend.md': '...', ... }
//   compileLayer(spec, kit) → files         the smallest .agent-team/ that expresses the spec
//   resolveSpec(spec, kit)  → { roles, warnings }   the briefs the team ends up with, as sync builds them
//
// kit: { roles: { <slug>: <markdown> }, presets: { <name>: [<slug>, ...] } }
//
// The round trip is the contract: building the team from compileLayer(importLayer(layer)) gives the same generated
// files as building it from layer itself. tests/team-model.test.mjs checks it on every layer we know.

export const SCHEMA = 'agent-team/team-spec@1';

/** team.json keys the model handles itself; every other key is kept as it is in spec.options. */
const MODELLED = ['kit', 'preset', 'include', 'exclude', 'values'];
/** Layer files the model reads and writes. Anything else in .agent-team/ (config.sh, kit.lock.json, roles/README.md) is not part of a team spec. */
const RULE_FILES = { protocols: 'protocols.extend.md', instructions: 'instructions.extend.md' };

// ------------------------------------------------------------------------------------------------ briefs

/** Splits a brief or an extension into its header lines and its "## " sections, in order. */
export function splitBrief(md) {
  const lines = md.replace(/\s+$/, '').split('\n');
  const header = [];
  const sections = [];
  for (const l of lines) {
    if (l.startsWith('## ')) sections.push({ heading: l, body: [] });
    else if (sections.length) sections.at(-1).body.push(l);
    else header.push(l);
  }
  return { header, sections };
}

const trimBlank = (a) => { const b = [...a]; while (b.length && !b[0].trim()) b.shift(); while (b.length && !b.at(-1).trim()) b.pop(); return b; };
const sectionName = (heading) => heading.replace(/^##\s+/, '').replace(/\s*\(replace\)\s*$/i, '').trim();

/**
 * An extension file as data: an optional new title, header field overrides in order, and sections in order, each
 * appended to the kit's section of the same name or replacing it. Lines the kit would ignore are dropped.
 */
export function parseExtension(md) {
  const { header, sections } = splitBrief(md);
  const ext = { fields: [], sections: [] };
  for (const line of header) {
    if (/^#\s+/.test(line)) { ext.title = line.replace(/^#\s+/, '').trim(); continue; }
    const m = /^\*\*([^*]+):\*\*\s?(.*)$/.exec(line);
    if (m) ext.fields.push({ name: m[1], value: m[2] });
  }
  for (const s of sections) {
    ext.sections.push({ name: sectionName(s.heading), mode: /\(replace\)\s*$/i.test(s.heading) ? 'replace' : 'append', text: trimBlank(s.body).join('\n') });
  }
  if (ext.title === undefined) delete ext.title;
  return ext;
}

export function formatExtension(ext) {
  const head = [];
  if (ext.title) head.push(`# ${ext.title}`, '');
  for (const f of ext.fields ?? []) head.push(`**${f.name}:** ${f.value}`.trimEnd());
  const parts = [head.join('\n').trim()];
  for (const s of ext.sections ?? []) parts.push(`## ${s.name}${s.mode === 'replace' ? ' (replace)' : ''}\n${s.text}`.trimEnd());
  return parts.filter(Boolean).join('\n\n') + '\n';
}

const emptyExtension = (ext) => !ext || (!ext.title && !(ext.fields ?? []).length && !(ext.sections ?? []).length);

// ------------------------------------------------------------------------------------------------ import

/** A project layer as a TeamSpec. Every kit role appears, switched on or off, so an editor can show the whole library. */
export function importLayer(files, kit) {
  if (!files['team.json']) throw new Error('the layer has no team.json');
  const team = JSON.parse(files['team.json']);
  const preset = team.preset ?? 'engineering';
  if (!kit.presets[preset]) throw new Error(`the kit has no preset "${preset}"`);
  const roleFiles = Object.keys(files).filter((p) => /^roles\/[^/]+\.md$/.test(p) && !/\/(_|README\.md$)/.test(p));
  const own = roleFiles.filter((p) => !p.endsWith('.extend.md')).map((p) => p.slice('roles/'.length, -'.md'.length));
  const extended = roleFiles.filter((p) => p.endsWith('.extend.md')).map((p) => p.slice('roles/'.length, -'.extend.md'.length));

  const wanted = new Set([...kit.presets[preset], ...(team.include ?? [])]);
  // A project role is on unless exclude lists it: that is how a switched-off custom agent keeps its file.
  const excluded = new Set(team.exclude ?? []);
  for (const x of excluded) wanted.delete(x);
  for (const s of own) if (!excluded.has(s)) wanted.add(s);

  const roles = {};
  const slugs = new Set([...Object.keys(kit.roles), ...own, ...extended, ...(team.include ?? [])]);
  for (const slug of [...slugs].sort()) {
    const inKit = slug in kit.roles;
    const role = { source: own.includes(slug) ? (inKit ? 'project-replaces-kit' : 'project') : inKit ? 'kit' : 'missing', enabled: wanted.has(slug) };
    if (own.includes(slug)) role.brief = files[`roles/${slug}.md`];
    if (extended.includes(slug)) { role.extension = parseExtension(files[`roles/${slug}.extend.md`]); role.extensionText = files[`roles/${slug}.extend.md`]; }
    roles[slug] = role;
  }

  const rules = {};
  for (const [k, f] of Object.entries(RULE_FILES)) if (files[f] !== undefined) rules[k] = files[f];
  const options = Object.fromEntries(Object.entries(team).filter(([k]) => !MODELLED.includes(k)));
  const spec = { schema: SCHEMA, preset, values: team.values ?? {}, roles, rules, options };
  for (const [k, f] of Object.entries(DATA_FILES)) if (files[f] !== undefined) spec[k] = JSON.parse(files[f]);
  if (team.kit !== undefined) spec.kit = team.kit;
  // Remember what the file said about include/exclude, so a spec with no changes compiles back to the same team.json.
  spec.layout = { include: team.include ?? [], exclude: team.exclude ?? [] };
  return spec;
}

// ------------------------------------------------------------------------------------------------ compile

/** The project layer for a TeamSpec, as relative path → content. The include/exclude lists are the smallest diff from the preset.
 *  A project role that is switched off keeps its file and is listed in exclude, so switching it back on restores it. */
export function compileLayer(spec, kit) {
  const preset = kit.presets[spec.preset];
  if (!preset) throw new Error(`the kit has no preset "${spec.preset}"`);
  const inPreset = new Set(preset);
  const enabledKit = (slug, r) => r.enabled && (r.source === 'kit' || r.source === 'missing');
  let include = Object.entries(spec.roles).filter(([s, r]) => enabledKit(s, r) && !inPreset.has(s)).map(([s]) => s);
  const isOwn = (r) => r.source === 'project' || r.source === 'project-replaces-kit';
  let exclude = Object.entries(spec.roles).filter(([s, r]) => !r.enabled && (inPreset.has(s) || isOwn(r))).map(([s]) => s);
  // Keep the order the layer had, then add anything new in name order.
  const keepOrder = (list, before = []) => [...before.filter((s) => list.includes(s)), ...list.filter((s) => !before.includes(s)).sort()];
  include = keepOrder(include, spec.layout?.include);
  exclude = keepOrder(exclude, spec.layout?.exclude);

  const team = {};
  if (spec.kit !== undefined) team.kit = spec.kit;
  team.preset = spec.preset;
  team.include = include;
  team.exclude = exclude;
  team.values = spec.values ?? {};
  Object.assign(team, spec.options ?? {});
  const files = { 'team.json': JSON.stringify(team, null, 2) + '\n' };

  for (const [slug, r] of Object.entries(spec.roles)) {
    if (isOwn(r)) {
      files[`roles/${slug}.md`] = r.brief.endsWith('\n') ? r.brief : r.brief + '\n';
    }
    // An unchanged extension keeps its file's own text (blank lines and all), so opening and publishing a team
    // changes nothing it did not edit.
    if (!emptyExtension(r.extension)) files[`roles/${slug}.extend.md`] = r.extensionText !== undefined && JSON.stringify(parseExtension(r.extensionText)) === JSON.stringify(r.extension) ? r.extensionText : formatExtension(r.extension);
  }
  for (const [k, f] of Object.entries(RULE_FILES)) if (spec.rules?.[k] !== undefined) files[f] = spec.rules[k];
  for (const [k, f] of Object.entries(DATA_FILES)) if (spec[k] !== undefined) files[f] = JSON.stringify(spec[k], null, 2) + '\n';
  return files;
}

/** The paths compileLayer owns: a writer deletes files under these that the new layer no longer has. */
export const isLayerPath = (p) => p === 'team.json' || Object.values(RULE_FILES).includes(p) || ['ownership.json', 'gates.json', 'resources.json', 'meetings.json', 'studio.json'].includes(p) || (/^roles\/[^/]+\.md$/.test(p) && !/\/(_|README\.md$)/.test(p));

// ------------------------------------------------------------------------------------------------ editing helpers

const ext = (spec, slug) => (spec.roles[slug].extension ??= { fields: [], sections: [] });

/** Switches a role on or off. */
export function setEnabled(spec, slug, enabled) {
  if (!spec.roles[slug]) throw new Error(`no role "${slug}"`);
  spec.roles[slug].enabled = enabled;
  return spec;
}

/** Sets a header field (Model, Reports to, Status, ...) on a role. A kit role gets it through its extension. */
export function setField(spec, slug, name, value) {
  const r = spec.roles[slug];
  if (!r) throw new Error(`no role "${slug}"`);
  if (r.brief !== undefined && !r.extension) {
    const line = `**${name}:** ${value}`;
    const re = new RegExp(`^\\*\\*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\*\\*.*$`, 'm');
    r.brief = re.test(r.brief) ? r.brief.replace(re, line) : r.brief.replace(/^(#\s+.*\n)/, `$1\n${line}\n`);
    return spec;
  }
  const e = ext(spec, slug);
  const f = e.fields.find((x) => x.name === name);
  if (f) f.value = value; else e.fields.push({ name, value });
  return spec;
}

/** Appends to or replaces a section of a kit role (through its extension). */
export function setSection(spec, slug, name, text, mode = 'append') {
  const e = ext(spec, slug);
  const s = e.sections.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (s) Object.assign(s, { text, mode }); else e.sections.push({ name, mode, text });
  return spec;
}

/** Drops a role's changes so it is the kit's brief again. */
export function resetRole(spec, slug) {
  delete spec.roles[slug].extension;
  return spec;
}

// ------------------------------------------------------------------------------------------------ resolve

/** Applies an extension to a brief, the way sync does (see bin/agent-team.mjs extendBrief). */
export function applyExtension(base, extension) {
  return extendBriefText(base, formatExtension(extension));
}

function joinBrief({ header, sections }) {
  return [...header, ...sections.flatMap((s) => [s.heading, ...trimBlank(s.body), ''])].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
const key = (heading) => heading.replace(/^##\s+/, '').replace(/\(.*?\)/g, '').trim().toLowerCase();

/** The kit's extension rules. bin/agent-team.mjs uses this function, so there is one implementation. */
export function extendBriefText(base, extMd) {
  const b = splitBrief(base);
  const e = splitBrief(extMd);
  for (const line of e.header) {
    if (/^#\s+/.test(line)) {
      const i = b.header.findIndex((l) => /^#\s+/.test(l));
      if (i >= 0) b.header[i] = line; else b.header.unshift(line);
      continue;
    }
    const m = /^\*\*([^*]+):\*\*/.exec(line);
    if (!m) continue;
    const i = b.header.findIndex((l) => l.startsWith(`**${m[1]}:**`));
    if (i >= 0) b.header[i] = line;
    else {
      const last = b.header.map((l, j) => (l.startsWith('**') ? j : -1)).filter((j) => j >= 0).at(-1) ?? 0;
      b.header.splice(last + 1, 0, line);
    }
  }
  for (const s of e.sections) {
    const replace = /\(replace\)\s*$/i.test(s.heading);
    const target = b.sections.find((x) => key(x.heading) === key(s.heading));
    if (target) target.body = replace ? trimBlank(s.body) : [...trimBlank(target.body), ...trimBlank(s.body)];
    else {
      const footer = b.sections.findIndex((x) => key(x.heading).startsWith('every thread'));
      const add = { heading: s.heading.replace(/\s*\(replace\)\s*$/i, ''), body: trimBlank(s.body) };
      b.sections.splice(footer >= 0 ? footer : b.sections.length, 0, add);
    }
  }
  return joinBrief(b);
}

/** Reporting lines that point at roles the team does not have are redirected, the way sync does. */
export function fitToTeam(md, installed) {
  const brief = splitBrief(md);
  const top = installed.has('chief-of-staff') ? 'chief-of-staff' : null;
  brief.header = brief.header.map((l) => {
    const m = /^\*\*Reports to:\*\*\s*(\S+)/.exec(l);
    return m && m[1] !== 'owner' && !installed.has(m[1]) && top ? `**Reports to:** ${top} (${m[1]} is not part of this team)` : l;
  });
  const dr = brief.sections.find((x) => key(x.heading) === 'direct reports');
  if (dr) {
    const kept = dr.body.join(' ').split(',').map((x) => x.trim()).filter((x) => installed.has(x));
    if (kept.length) dr.body = [kept.join(', ')];
    else brief.sections.splice(brief.sections.indexOf(dr), 1);
  }
  return joinBrief(brief);
}

/** The briefs the team ends up with: what sync would write to docs/team/roles/ (before placeholders are filled). */
export function resolveSpec(spec, kit) {
  const roles = [];
  const warnings = [];
  for (const [slug, r] of Object.entries(spec.roles).sort(([a], [b]) => a.localeCompare(b))) {
    if (!r.enabled) { if (!emptyExtension(r.extension)) warnings.push(`${slug} has changes but is switched off`); continue; }
    let md = r.brief ?? kit.roles[slug];
    if (md === undefined) { warnings.push(`role "${slug}" is switched on but neither the kit nor the project has it`); continue; }
    let source = r.brief !== undefined ? (slug in kit.roles ? 'project (replaces kit)' : 'project') : 'kit';
    if (!emptyExtension(r.extension)) { md = applyExtension(md, r.extension); source += ' + extension'; }
    roles.push({ slug, md, source });
  }
  const installed = new Set(roles.map((r) => r.slug));
  for (const r of roles) r.md = fitToTeam(r.md, installed);
  return { roles: applyMeetings(applyBindings(roles, spec.resources), spec.meetings), warnings };
}

// ------------------------------------------------------------------------------------------------ data files (kit 0.5)
//
// Three optional files in .agent-team/ hold what used to be hand-written prose or bash, as data the Studio can edit:
//   ownership.json   { "rows": [{ "path", "writer", "notes" }] }            → sync writes docs/team/ownership.md
//   gates.json       { "all": [...], "pools": { name: slots }, "targets": { name: [{ "name", "run", "pool" }] } }
//                                                                           → sync writes scripts/agent-team/gates.sh
//   resources.json   { "resources": [{ "id", "type", "name", "config", "secrets" }],
//                      "bindings": [{ "role", "resource", "permission" }] } → a Systems section in the project
//                                                                             instructions and in each bound role's brief
// Without them a layer behaves exactly as before.

export const DATA_FILES = { ownership: 'ownership.json', gates: 'gates.json', resources: 'resources.json', meetings: 'meetings.json', canvas: 'studio.json' };
export const PERMISSIONS = ['read', 'write', 'deploy'];

/** The title a brief gives itself, without a parenthesised note: "Chief of staff (project coordinator)" → "Chief of staff". */
const titleOf = (md, slug) => (/^#\s+(.+)$/m.exec(md ?? '')?.[1] ?? slug).replace(/\s*\(.*\)\s*$/, '').trim();

/** docs/team/ownership.md from ownership.json. A writer that is a role slug is shown by its title, which the dashboard resolves back. */
export function renderOwnership(ownership, roles) {
  const titles = new Map(roles.map((r) => [r.slug, titleOf(r.md, r.slug)]));
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Ownership: one writer per path',
    '',
    ownership.intro ?? 'A thread edits only the paths it owns. Anything else is a request to that path\'s owner.',
    '',
    'Generated from `.agent-team/ownership.json`: change that file (or the Studio\'s ownership table) and run `scripts/agent-team/sync.sh`.',
    '',
    '| Path | Writer | Notes |',
    '| --- | --- | --- |',
    ...(ownership.rows ?? []).map((r) => `| \`${cell(r.path)}\` | ${cell(titles.get(r.writer) ?? r.writer)} | ${cell(r.notes)} |`),
  ];
  return lines.join('\n') + '\n';
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** scripts/agent-team/gates.sh from gates.json: bash that merge-gate.sh sources after .agent-team/config.sh. */
export function renderGates(gates) {
  const out = [
    '# shellcheck shell=bash disable=SC2034',
    '# Merge gates from .agent-team/gates.json, sourced after .agent-team/config.sh: a target defined here replaces a',
    '# gate_<target> function of the same name there. Change gates.json and run scripts/agent-team/sync.sh.',
  ];
  if (gates.all?.length) out.push(`AGENT_TEAM_GATES_ALL=${shq(gates.all.join(' '))}`);
  if (gates.pools && Object.keys(gates.pools).length) out.push(`AGENT_TEAM_POOLS=${shq(Object.entries(gates.pools).map(([k, v]) => `${k}:${v}`).join(' '))}`);
  for (const [target, steps] of Object.entries(gates.targets ?? {})) {
    if (!/^[a-z0-9_]+$/i.test(target)) throw new Error(`gates.json: target "${target}" must be letters, digits and underscores`);
    out.push('', `gate_${target}() {`);
    for (const s of steps) {
      const lock = s.pool ? `locked ${s.pool} ` : '';
      if (s.pool && !/^[a-z0-9_-]+$/i.test(s.pool)) throw new Error(`gates.json: pool "${s.pool}" must be letters, digits, - and _`);
      out.push(`  run ${shq(`${target}: ${s.name}`)} ${lock}bash -c ${shq(s.run)}`);
    }
    if (!steps.length) out.push('  :');
    out.push('}');
  }
  return out.join('\n') + '\n';
}

/** Who may use what, as a section for the project instructions. */
export function renderSystems(resources) {
  const list = resources.resources ?? [];
  if (!list.length) return '';
  const who = (id) => (resources.bindings ?? []).filter((b) => b.resource === id).map((b) => `${b.role} (${b.permission})`).join(', ') || 'nobody';
  const cfg = (c) => Object.entries(c ?? {}).map(([k, v]) => `${k}: ${v}`).join('; ');
  return [
    '## Systems',
    '',
    'The systems this team works with, and who may use each. A role without a binding has no access. Secrets are named here and set in the environment; never paste their values anywhere.',
    '',
    '| System | Type | Settings | Secrets | Who |',
    '| --- | --- | --- | --- | --- |',
    ...list.map((r) => `| ${r.name ?? r.id} | ${r.type} | ${cfg(r.config)} | ${(r.secrets ?? []).map((s) => `\`${s}\``).join(', ')} | ${who(r.id)} |`),
  ].join('\n') + '\n';
}

/** Adds each bound system to a role's brief, under a Systems section before the shared footer. */
export function applyBindings(roles, resources) {
  const byId = new Map((resources?.resources ?? []).map((r) => [r.id, r]));
  return roles.map((r) => {
    const mine = (resources?.bindings ?? []).filter((b) => b.role === r.slug && byId.has(b.resource));
    if (!mine.length) return r;
    const lines = mine.map((b) => {
      const res = byId.get(b.resource);
      const secrets = (res.secrets ?? []).length ? ` Secrets from the environment: ${res.secrets.map((s) => `\`${s}\``).join(', ')}.` : '';
      return `- ${res.name ?? res.id} (${res.type}): ${b.permission}.${secrets}`;
    });
    return { ...r, md: extendBriefText(r.md, `## Systems\n${lines.join('\n')}`) };
  });
}

// ------------------------------------------------------------------------------------------------ validate

const SECRET_PATTERNS = [/sk-ant-[A-Za-z0-9_-]{10,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /:\/\/[^/\s:@]+:[^/\s@]+@/, /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./];
const GENERATED = [/^docs\/team\/(?!ownership\.md$|lanes\/)/, /^scripts\/agent-team\//, /^\.claude\/agents\//];
const field = (md, name) => (new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+)$`, 'm').exec(md ?? '')?.[1] ?? '').trim();

/**
 * Checks a TeamSpec the way sync and the roster check would, plus the data files, without touching disk.
 * Returns [{ level: 'error' | 'warning', where, message }], errors first.
 */
// Common names people type for a time zone, and the IANA zone each means. Meetings and the scheduler need an IANA zone
// (Intl rejects "Pacific"), so init maps these and validate names them.
export const ZONE_ALIASES = {
  pacific: 'America/Los_Angeles', pt: 'America/Los_Angeles', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', 'pacific time': 'America/Los_Angeles',
  mountain: 'America/Denver', mt: 'America/Denver', mst: 'America/Denver', mdt: 'America/Denver', 'mountain time': 'America/Denver', arizona: 'America/Phoenix',
  central: 'America/Chicago', ct: 'America/Chicago', cst: 'America/Chicago', cdt: 'America/Chicago', 'central time': 'America/Chicago',
  eastern: 'America/New_York', et: 'America/New_York', est: 'America/New_York', edt: 'America/New_York', 'eastern time': 'America/New_York',
  alaska: 'America/Anchorage', hawaii: 'Pacific/Honolulu', atlantic: 'America/Halifax', newfoundland: 'America/St_Johns',
  uk: 'Europe/London', gb: 'Europe/London', london: 'Europe/London', gmt: 'Europe/London', bst: 'Europe/London', ireland: 'Europe/Dublin',
  cet: 'Europe/Paris', cest: 'Europe/Paris', 'central european': 'Europe/Paris', eet: 'Europe/Athens', 'eastern european': 'Europe/Athens', wet: 'Europe/Lisbon',
  india: 'Asia/Kolkata', ist: 'Asia/Kolkata', japan: 'Asia/Tokyo', jst: 'Asia/Tokyo', china: 'Asia/Shanghai', singapore: 'Asia/Singapore', korea: 'Asia/Seoul',
  sydney: 'Australia/Sydney', aest: 'Australia/Sydney', aedt: 'Australia/Sydney', melbourne: 'Australia/Melbourne', perth: 'Australia/Perth',
  nz: 'Pacific/Auckland', 'new zealand': 'Pacific/Auckland', utc: 'UTC', 'z': 'UTC', zulu: 'UTC',
};
/** True when Intl knows `zone` as a time zone (an IANA name such as Europe/Lisbon, or UTC). */
export function isZone(zone) {
  if (typeof zone !== 'string' || !zone.trim()) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; }
}
/**
 * A team's TIMEZONE as an IANA zone: { zone, from } where `from` is 'iana' (already one), 'alias' (a common name such as
 * "Pacific" mapped to America/Los_Angeles), or null when neither (zone is then null). Abbreviations Intl happens to
 * accept (EST, PST8PDT) still map to the city zone, which follows daylight saving.
 */
export function toZone(value) {
  const v = String(value ?? '').trim();
  const alias = ZONE_ALIASES[v.toLowerCase().replace(/\s+/g, ' ')];
  if (alias) return { zone: alias, from: alias === v ? 'iana' : 'alias' };
  if (/^[A-Za-z]+\/[A-Za-z0-9_+\-/]+$/.test(v) && isZone(v)) return { zone: v, from: 'iana' };
  return { zone: null, from: null };
}

export function validate(spec, kit, { dailyCapUsd = spec.options?.budgets?.dailyUsd } = {}) {
  const issues = [];
  const add = (level, where, message) => issues.push({ level, where, message });
  const { roles, warnings } = resolveSpec(spec, kit);
  for (const w of warnings) add('warning', 'roles', w);
  for (const t of teamTargets(spec.options)) if (!TARGETS.includes(t)) add('error', 'team.json', `targets lists "${t}"; the kit writes ${TARGETS.join(', ')}`);
  if (spec.options?.packs !== undefined && !Array.isArray(spec.options.packs)) add('error', 'team.json', 'packs must be a list of pack names');
  else if (kit?.packs) for (const p of teamPacks(spec.options)) if (!(p in kit.packs)) add('error', 'team.json', `packs lists "${p}", which the kit does not have (packs: ${Object.keys(kit.packs).join(', ')})`);
  // Meetings and the scheduler read TIMEZONE with Intl; a name it rejects ("Pacific") silently becomes UTC. A warning,
  // so a team that has one still syncs.
  const tz = spec.values?.TIMEZONE;
  if (tz !== undefined && toZone(tz).from !== 'iana') {
    const z = toZone(tz).zone;
    add('warning', 'team.json', `TIMEZONE "${tz}" is not an IANA time zone, so meetings and the scheduler would use UTC; ${z ? `set it to "${z}"` : 'use a name such as America/Los_Angeles or Europe/Lisbon'}`);
  }
  const installed = new Map(roles.map((r) => [r.slug, r]));
  const manager = new Map(roles.map((r) => [r.slug, (field(r.md, 'Reports to').split(/\s/)[0] ?? '').toLowerCase()]));
  const top = roles.filter((r) => manager.get(r.slug) === 'owner');
  if (top.length !== 1) add('error', 'roles', `exactly one role must report to the owner (found ${top.map((r) => r.slug).join(', ') || 'none'})`);
  for (const [slug, m] of manager) {
    if (!m) add('error', `roles/${slug}`, 'has no "Reports to" line');
    else if (m !== 'owner' && !installed.has(m)) add('error', `roles/${slug}`, `reports to "${m}", which is not on the team`);
    const tier = (/^[a-z]+/i.exec(field(installed.get(slug).md, 'Model'))?.[0] ?? '').toLowerCase();
    // The same sections sync's roster check requires: a heading with nothing under it fails there, so it fails here.
    if (!briefSection(installed.get(slug).md, 'identity')) add('error', `roles/${slug}`, 'missing "## Identity" (or it is empty); sync refuses a brief without it');
    // Some roles own no areas (a clerk, a reviewer, a responder who only drafts): a warning, as in sync, not a block.
    if (!briefSection(installed.get(slug).md, 'owns')) add('warning', `roles/${slug}`, 'owns no areas ("## Owns (writes)" is missing or empty): it can read and message, but writes nothing of its own');
    if (!['deep', 'standard', 'routine', 'light'].includes(tier)) add('error', `roles/${slug}`, `model tier "${tier}" is not deep, standard, routine or light`);
  }
  for (const slug of manager.keys()) { // loops in the reporting lines
    const seen = new Set([slug]);
    for (let m = manager.get(slug); m && m !== 'owner' && installed.has(m); m = manager.get(m)) {
      if (seen.has(m)) { add('error', `roles/${slug}`, `reporting line loops back through ${m}`); break; }
      seen.add(m);
    }
  }
  const rows = spec.ownership?.rows ?? [];
  const byPath = new Map();
  for (const r of rows) {
    if (byPath.has(r.path)) add('error', 'ownership', `${r.path} has two writers: ${byPath.get(r.path)} and ${r.writer}`);
    byPath.set(r.path, r.writer);
    if (/^[a-z0-9-]+$/.test(r.writer) && !installed.has(r.writer)) add('warning', 'ownership', `${r.path}: writer "${r.writer}" is not on the team`);
    if (GENERATED.some((g) => g.test(r.path)) && /^[a-z0-9-]+$/.test(r.writer)) add('error', 'ownership', `${r.path} is generated by sync; no role may write it`);
  }
  if (spec.ownership) for (const slug of installed.keys()) if (!rows.some((r) => r.writer === slug) && field(installed.get(slug).md, 'Group') !== 'executive' && !/dormant/i.test(field(installed.get(slug).md, 'Status'))) add('warning', 'ownership', `${slug} owns no path`);
  const ids = new Set();
  for (const r of spec.resources?.resources ?? []) {
    if (!r.id || ids.has(r.id)) add('error', 'resources', `resource id "${r.id}" is missing or used twice`);
    ids.add(r.id);
    for (const s of r.secrets ?? []) if (!/^[A-Z][A-Z0-9_]*$/.test(s)) add('error', `resources/${r.id}`, `secret "${s}" must be an environment variable name, not a value`);
  }
  for (const b of spec.resources?.bindings ?? []) {
    if (!ids.has(b.resource)) add('error', 'bindings', `${b.role} is bound to "${b.resource}", which is not a resource`);
    if (!installed.has(b.role)) add('warning', 'bindings', `${b.role} is bound to ${b.resource} but is not on the team`);
    if (!PERMISSIONS.includes(b.permission)) add('error', 'bindings', `${b.role} → ${b.resource}: permission "${b.permission}" is not read, write or deploy`);
  }
  for (const [target, steps] of Object.entries(spec.gates?.targets ?? {})) {
    for (const s of steps) if (s.pool && spec.gates.pools && !(s.pool in spec.gates.pools)) add('warning', `gates/${target}`, `"${s.name}" uses pool "${s.pool}", which gates.json does not size`);
  }
  for (const i of checkCustomRoles(spec, kit, installed)) add(i.level, i.where, i.message);
  for (const i of checkMeetings(spec.meetings, roles, { dailyCapUsd })) add(i.level, i.where, i.message);
  for (const [slug, r] of installed) if (!isCustom(spec.roles[slug])) for (const i of checkBriefData(slug, r.md)) add(i.level, i.where, i.message);
  // No secrets anywhere in the team's text.
  const texts = [['values', JSON.stringify(spec.values ?? {})], ['rules', JSON.stringify(spec.rules ?? {})], ['resources', JSON.stringify(spec.resources ?? {})],
    ['gates', JSON.stringify(spec.gates ?? {})], ['meetings', JSON.stringify(spec.meetings ?? {})], ...Object.entries(spec.roles).map(([s, r]) => [`roles/${s}`, JSON.stringify([r.brief ?? '', r.extension ?? {}])])];
  for (const [where, text] of texts) if (SECRET_PATTERNS.some((p) => p.test(text))) add('error', where, 'looks like it contains a secret value; name the secret instead and set it in the environment');
  return issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
}

// ------------------------------------------------------------------------------------------------ custom agents
//
// A custom agent is a project role: .agent-team/roles/<slug>.md, carried in the spec as { source: 'project', brief }.
// These helpers build and edit that brief as data, for the Studio's agent editor (architecture section 12.1).

export const SLUG = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const slugify = (title) => String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
const isCustom = (r) => r && r.brief !== undefined;
const fieldRe = (name) => new RegExp(`^\\*\\*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\*\\*.*$`, 'm');

/** Whether `slug` can name a new agent on this team: { ok, message }. */
export function checkSlug(spec, kit, slug, { replaceKit = false } = {}) {
  if (!SLUG.test(slug ?? '')) return { ok: false, message: 'Use lower-case letters, digits and single hyphens, starting with a letter.' };
  if (spec.roles[slug] && isCustom(spec.roles[slug])) return { ok: false, message: `This team already has an agent called ${slug}.` };
  if (slug in kit.roles && !replaceKit) return { ok: false, message: `The kit has a role called ${slug}. Pick another name, or choose to replace the kit role.` };
  if (slug in kit.roles) return { ok: true, message: `This replaces the kit's ${slug} on this team; the kit role is not changed.` };
  return { ok: true, message: 'The slug is free. No kit role uses it.' };
}

/** The text of a "## " section, without the heading; '' when the brief has none. */
export function briefSection(md, name) {
  const s = splitBrief(md ?? '').sections.find((x) => key(x.heading) === name.toLowerCase());
  return s ? trimBlank(s.body).join('\n') : '';
}

/** Sets a section's text. A new section goes before "Every thread"; empty text removes the section. */
export function setBriefSection(md, name, text, heading = `## ${name}`) {
  const b = splitBrief(md);
  const i = b.sections.findIndex((x) => key(x.heading) === key(heading));
  const body = String(text ?? '').replace(/\s+$/, '').split('\n');
  if (!String(text ?? '').trim()) { if (i >= 0) b.sections.splice(i, 1); return joinBrief(b); }
  if (i >= 0) { b.sections[i].body = body; return joinBrief(b); }
  const footer = b.sections.findIndex((x) => key(x.heading).startsWith('every thread'));
  b.sections.splice(footer >= 0 ? footer : b.sections.length, 0, { heading, body });
  return joinBrief(b);
}

/** Sets a "**Name:** value" header line, adding it after the other header fields when missing. */
export function setBriefField(md, name, value) {
  const line = `**${name}:** ${value}`;
  if (fieldRe(name).test(md)) return md.replace(fieldRe(name), line);
  const b = splitBrief(md);
  const last = b.header.map((l, j) => (l.startsWith('**') ? j : -1)).filter((j) => j >= 0).at(-1);
  b.header.splice(last === undefined ? 1 : last + 1, 0, line);
  return joinBrief(b);
}

export function setBriefTitle(md, title) {
  return /^#\s+.*$/m.test(md) ? md.replace(/^#\s+.*$/m, `# ${title}`) : `# ${title}\n\n${md}`;
}

/** The paths an agent writes or reads, from its "Owns (writes)" section; other lines come back as `prose`. */
export function ownsPaths(md) {
  const paths = [];
  const prose = [];
  for (const line of briefSection(md, 'owns').split('\n')) {
    const m = /^-\s*(reads\s+)?`([^`]+)`\s*(.*)$/.exec(line.trim());
    if (m) paths.push({ path: m[2], mode: m[1] ? 'reads' : 'writes', note: m[3].replace(/^\(|\)$/g, '').trim() });
    else if (line.trim()) prose.push(line);
  }
  return { paths, prose: prose.join('\n') };
}

export function setOwnsPaths(md, paths, prose = '') {
  const lines = paths.filter((p) => p.path).map((p) => `- ${p.mode === 'reads' ? 'reads ' : ''}\`${p.path}\`${p.note ? ` (${p.note})` : ''}`);
  const text = [...lines, ...(prose.trim() ? [prose.trim()] : [])].join('\n') || 'Nothing yet';
  return setBriefSection(md, 'Owns (writes)', text, '## Owns (writes)');
}

/** Who already writes `path` (or a folder that contains it, or one inside it), other than `slug`: [{ path, writer }]. */
export function pathConflicts(spec, slug, path) {
  const norm = (p) => p.replace(/\*+$/, '');
  const overlap = (a, b) => norm(a).startsWith(norm(b)) || norm(b).startsWith(norm(a));
  const out = [];
  for (const r of spec.ownership?.rows ?? []) if (r.writer !== slug && overlap(r.path, path)) out.push({ path: r.path, writer: r.writer });
  for (const [other, r] of Object.entries(spec.roles)) {
    if (other === slug || !r.enabled || !isCustom(r)) continue;
    for (const p of ownsPaths(r.brief).paths) if (p.mode === 'writes' && overlap(p.path, path) && !out.some((o) => o.path === p.path && o.writer === other)) out.push({ path: p.path, writer: other });
  }
  return out;
}

/**
 * A new agent's brief. start: 'blank' (the kit's role template), 'copy' (a role as this team runs it today, with its
 * extension applied, as a separate role) or 'import' (a brief from a file). The title, group and manager are set and
 * the "every thread" lines name the new slug.
 */
export function draftRole(spec, kit, { start = 'blank', from, md: imported, title, slug, group, reportsTo }) {
  let md;
  let old = '<slug>';
  if (start === 'copy') {
    const r = spec.roles[from];
    md = r?.brief ?? kit.roles[from];
    if (md === undefined) throw new Error(`no role "${from}" to copy`);
    if (r?.extension) md = applyExtension(md, r.extension);
    old = from;
  } else if (start === 'import') {
    md = imported;
    old = /scripts\/agent-team\/team-status\.sh\s+(\S+)/.exec(md ?? '')?.[1] ?? '<slug>';
  } else {
    md = kit.template ?? '# Role title\n\n**Model:** standard\n**Group:** engineering\n**Reports to:** cto\n**Status:** active\n\n## Identity\n\n## Owns (writes)\n\n## Tools\n\n## Wakes on\n\n## Hands to\n\n## Rules\n';
    md = md.replaceAll('Role title', title || 'New agent');
  }
  md = md.replaceAll(`team-status.sh ${old} `, `team-status.sh ${slug} `).replaceAll(`roles/${old}.md`, `roles/${slug}.md`);
  if (title) md = setBriefTitle(md, title);
  if (group) md = setBriefField(md, 'Group', group);
  if (reportsTo) md = setBriefField(md, 'Reports to', reportsTo);
  if (start === 'blank') md = setBriefField(md, 'Status', 'active');
  return md.replace(/\s+$/, '') + '\n';
}

/** Adds a custom agent to the team, switched on. */
export function addAgent(spec, slug, md) {
  const inKit = !!spec.roles[slug] && spec.roles[slug].source !== 'project';
  spec.roles[slug] = { source: inKit ? 'project-replaces-kit' : 'project', enabled: true, brief: md };
  return spec;
}

/**
 * A role pack for one agent: { '<slug>.md': brief, 'pack.json': what it needs }. Never secrets: only names and paths.
 * pack.json: { schema, roles, kit?, needs: { tools, resources, paths, wakes } } (kit and needs.wakes since kit 0.10).
 */
export function rolePack(spec, slug, { kit } = {}) {
  const r = spec.roles[slug];
  if (!isCustom(r)) throw new Error(`${slug} is not a custom agent`);
  const bindings = (spec.resources?.bindings ?? []).filter((b) => b.role === slug);
  const types = bindings.map((b) => spec.resources.resources.find((x) => x.id === b.resource)?.type).filter(Boolean);
  const needs = {
    tools: briefSection(r.brief, 'tools').split(/[,\n]/).map((t) => t.replace(/^-\s*/, '').trim()).filter(Boolean),
    resources: [...new Set(types)],
    paths: ownsPaths(r.brief).paths.filter((p) => p.mode === 'writes').map((p) => p.path),
    wakes: wakesOn(r.brief).triggers,
  };
  const pack = { schema: 'agent-team/role-pack@1', roles: [slug], ...(kit ? { kit } : {}), needs };
  return { [`${slug}.md`]: r.brief, 'pack.json': JSON.stringify(pack, null, 2) + '\n' };
}

/** Reads a role pack or loose role files (name → text) into agents to import: [{ slug, md, needs }]. */
export function readPack(files) {
  const pack = files['pack.json'] ? JSON.parse(files['pack.json']) : null;
  const mds = Object.entries(files).filter(([n]) => n.endsWith('.md'));
  const slugs = pack?.roles ?? mds.map(([n]) => n.replace(/^.*\//, '').slice(0, -3));
  return slugs.map((slug) => {
    const md = files[`${slug}.md`] ?? mds.find(([n]) => n.endsWith(`/${slug}.md`))?.[1];
    if (md === undefined) throw new Error(`the pack lists ${slug} but has no ${slug}.md`);
    return { slug, md, needs: pack?.needs ?? {} };
  });
}

/** Checks only custom agents need, run as part of validate. */
function checkCustomRoles(spec, kit, installed) {
  const issues = [];
  for (const [slug, r] of Object.entries(spec.roles)) {
    if (!isCustom(r) || !r.enabled) continue;
    const where = `roles/${slug}`;
    if (!SLUG.test(slug)) issues.push({ level: 'error', where, message: `"${slug}" is not a valid slug (lower-case letters, digits and hyphens)` });
    if (r.source === 'project-replaces-kit') issues.push({ level: 'warning', where, message: `replaces the kit's ${slug} on this team; a kit upgrade will not change it` });
    if (!briefSection(r.brief, 'identity').trim()) issues.push({ level: 'warning', where, message: 'has no Identity: say what it owns and how it is judged' });
    for (const p of ownsPaths(r.brief).paths.filter((x) => x.mode === 'writes')) {
      for (const c of pathConflicts(spec, slug, p.path)) {
        if (installed.has(c.writer) || !SLUG.test(c.writer)) issues.push({ level: 'error', where, message: `${p.path} overlaps ${c.path}, which ${c.writer} writes; one writer per area` });
      }
    }
    for (const i of checkBriefData(slug, r.brief, { requireTrigger: true })) issues.push(i);
    if (/signoff/i.test(briefSection(r.brief, 'hands to')) && !signoffEvidence(r.brief).length) {
      issues.push({ level: 'warning', where, message: 'sends SIGNOFF but lists no sign-off evidence (screenshots, logs, links)' });
    }
  }
  return issues;
}

// ------------------------------------------------------------------------------------------------ sign-off evidence and wakes (kit 0.10)
//
// Two brief sections the runner reads as data (architecture section 12.1). Both are optional, and free text keeps
// working: only lines in the forms below are structured.
//
//   ## Sign-off evidence             ## Wakes on
//   - screenshot of each screen      - handoff
//   - test log                       - pr-paths: apps/web/**, tests/a11y/
//                                    - label: a11y           (an issue or PR label)
//                                    - issue-label: bug      (issues only)
//                                    - schedule: mon-fri 09:30   (days: mon..sun, ranges, lists, daily, weekdays; TIMEZONE)
//                                    - meeting
//                                    Anything else (prose, other bullets) is free text.

const bullets = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean);

/** The artefacts a SIGNOFF from this role must carry, from "## Sign-off evidence": one string per "- " bullet (prose is ignored). */
export function signoffEvidence(md) {
  return bullets(briefSection(md, 'sign-off evidence')).filter((l) => /^[-*]\s/.test(l)).map((l) => l.replace(/^[-*]\s*/, '').trim())
    .filter((l) => l && !l.startsWith(TEMPLATE_EVIDENCE));
}
/** The role template's placeholder evidence line, which is not evidence. */
const TEMPLATE_EVIDENCE = 'What a SIGNOFF from this role must attach';

/** Sets "## Sign-off evidence" to these items (an empty list removes the section). */
export function setSignoffEvidence(md, items) {
  return setBriefSection(md, 'Sign-off evidence', (items ?? []).map((i) => String(i).trim()).filter(Boolean).map((i) => `- ${i}`).join('\n'), '## Sign-off evidence');
}

export const WAKE_TYPES = ['handoff', 'meeting', 'pr-paths', 'label', 'issue-label', 'schedule'];
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const NEEDS_VALUE = new Set(['pr-paths', 'label', 'issue-label', 'schedule']);

/** Why a schedule value is not understood, or '' when it is fine ("mon-fri 09:30", "daily 08:00", "tue,thu 14:00"). */
export function scheduleProblem(value) {
  const m = /^(\S+)\s+(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim().toLowerCase());
  if (!m) return 'use "<days> HH:MM", for example "mon-fri 09:30"';
  if (Number(m[2]) > 23 || Number(m[3]) > 59) return `${m[2]}:${m[3]} is not a time of day`;
  if (m[1] === 'daily' || m[1] === 'weekdays') return '';
  for (const part of m[1].split(',')) {
    const [a, b, extra] = part.split('-');
    if (extra !== undefined || !DAYS.includes(a) || (b !== undefined && !DAYS.includes(b))) return `"${part}" is not a day or a range of days (mon..sun, daily, weekdays)`;
  }
  return '';
}

/**
 * The structured triggers of "## Wakes on": { triggers: [{ type, value }], text: [lines], problems: [{ line, message }] }.
 * A bullet whose first word is a trigger type is structured (and checked); every other line is free text.
 */
export function wakesOn(md) {
  const triggers = [];
  const text = [];
  const problems = [];
  for (const line of bullets(briefSection(md, 'wakes on'))) {
    const m = /^[-*]\s*([a-z-]+)\s*(?::\s*(.*))?$/i.exec(line);
    const type = m?.[1].toLowerCase();
    if (!m || !WAKE_TYPES.includes(type)) { text.push(line); continue; }
    const value = (m[2] ?? '').trim();
    if (NEEDS_VALUE.has(type) && !value) { problems.push({ line, message: `"${type}" needs a value` }); continue; }
    if (!NEEDS_VALUE.has(type) && value) { text.push(line); continue; } // "handoff: from the CTO" reads as prose
    if (type === 'schedule') { const p = scheduleProblem(value); if (p) { problems.push({ line, message: p }); continue; } }
    triggers.push(type === 'pr-paths' ? { type, value: value.split(',').map((p) => p.trim()).filter(Boolean).join(', ') } : value ? { type, value } : { type });
  }
  return { triggers, text, problems };
}

/** Writes "## Wakes on" from { triggers, text }: structured bullets first, then the free text as it was. */
export function setWakesOn(md, { triggers = [], text = [] } = {}) {
  const lines = [
    ...triggers.filter((t) => WAKE_TYPES.includes(t.type)).map((t) => (t.value ? `- ${t.type}: ${t.value}` : `- ${t.type}`)),
    ...text.map((l) => String(l)).filter((l) => l.trim()),
  ];
  return setBriefSection(md, 'Wakes on', lines.join('\n'), '## Wakes on');
}

/**
 * Checks of the two sections for one brief: [{ level, where, message }]. A malformed structured line is always a warning.
 * `requireTrigger` (custom agents: validate, the agent editor, pack import) also warns about lines the runner does not read.
 */
export function checkBriefData(slug, md, { requireTrigger = false } = {}) {
  const where = `roles/${slug}`;
  const out = [];
  const w = wakesOn(md);
  for (const p of w.problems) out.push({ level: 'warning', where, message: `Wakes on: ${p.line.replace(/^[-*]\s*/, '')}: ${p.message}` });
  // Custom agents: the runner reads only structured lines, so say which lines it will not read.
  if (requireTrigger && w.text.length) {
    const first = w.text[0].replace(/^[-*]\s*/, '');
    out.push({ level: 'warning', where, message: `Wakes on: ${w.text.length === 1 ? 'a line' : `${w.text.length} lines`} the runner does not read ("${first.length > 60 ? `${first.slice(0, 57)}...` : first}"); use ${WAKE_TYPES.join(', ')}` });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ role packs and renames (kit 0.10)

export const PACK_SCHEMA = 'agent-team/role-pack@1';
const PACK_NEEDS = ['tools', 'resources', 'paths', 'wakes'];

/** Checks a role pack before import, in validate's shape: [{ level, where, message }], where = roles/<slug>. */
export function checkPack(files, spec, kit) {
  const out = [];
  let pack = null;
  if (files['pack.json'] !== undefined) {
    try { pack = JSON.parse(files['pack.json']); } catch (e) { return [{ level: 'error', where: 'pack.json', message: `is not JSON: ${e.message}` }]; }
    if (pack.schema && pack.schema !== PACK_SCHEMA) out.push({ level: 'error', where: 'pack.json', message: `schema "${pack.schema}" is not ${PACK_SCHEMA}` });
    if (pack.roles !== undefined && (!Array.isArray(pack.roles) || !pack.roles.length)) out.push({ level: 'error', where: 'pack.json', message: 'roles must be a list of slugs' });
    for (const k of Object.keys(pack.needs ?? {})) if (!PACK_NEEDS.includes(k)) out.push({ level: 'warning', where: 'pack.json', message: `needs.${k} is not something the kit knows; it is ignored` });
  }
  let agents;
  try { agents = readPack(files); } catch (e) { return [...out, { level: 'error', where: 'pack.json', message: e.message }]; }
  if (!agents.length) out.push({ level: 'error', where: 'pack', message: 'has no role .md file' });
  for (const a of agents) {
    const where = `roles/${a.slug}`;
    if (!SLUG.test(a.slug)) { out.push({ level: 'error', where, message: `"${a.slug}" is not a valid slug (lower-case letters, digits and hyphens)` }); continue; }
    if (spec?.roles?.[a.slug] && isCustom(spec.roles[a.slug])) out.push({ level: 'error', where, message: `this team already has an agent called ${a.slug}; rename one of them` });
    else if (kit?.roles && a.slug in kit.roles) out.push({ level: 'warning', where, message: `the kit has a role called ${a.slug}; importing it replaces the kit role on this team unless you rename it` });
    if (!/^#\s+\S/m.test(a.md)) out.push({ level: 'error', where, message: 'has no "# Title" line' });
    if (SECRET_PATTERNS.some((p) => p.test(a.md))) out.push({ level: 'error', where, message: 'looks like it contains a secret value; a pack never brings secrets' });
    for (const i of checkBriefData(a.slug, a.md, { requireTrigger: true })) out.push(i);
  }
  return out;
}

/** Renames a custom agent: the role, its brief's own slug references, and every binding, ownership row and reporting line. */
export function renameRole(spec, from, to, kit) {
  const r = spec.roles[from];
  if (!isCustom(r)) throw new Error(`${from} is not a custom agent`);
  if (!SLUG.test(to)) throw new Error(`"${to}" is not a valid slug`);
  if (spec.roles[to] && isCustom(spec.roles[to])) throw new Error(`this team already has an agent called ${to}`);
  const brief = r.brief.replaceAll(`team-status.sh ${from} `, `team-status.sh ${to} `).replaceAll(`roles/${from}.md`, `roles/${to}.md`);
  delete spec.roles[from];
  // A kit role of the old name (the reason for most renames) comes back as the kit's own, switched off.
  if (kit?.roles && from in kit.roles) spec.roles[from] = { source: 'kit', enabled: false };
  spec.roles[to] = { ...r, source: 'project', brief };
  for (const b of spec.resources?.bindings ?? []) if (b.role === from) b.role = to;
  for (const row of spec.ownership?.rows ?? []) if (row.writer === from) row.writer = to;
  for (const [slug, other] of Object.entries(spec.roles)) {
    if (slug === to || !isCustom(other)) continue;
    const field = /^\*\*Reports to:\*\*\s*(\S+)/m.exec(other.brief);
    if (field && field[1].toLowerCase() === from) other.brief = setBriefField(other.brief, 'Reports to', to);
  }
  return spec;
}

/**
 * A7: custom agents a kit upgrade would shadow. `oldKitRoles` is the kit's role list the team last synced with
 * (kit.lock.json "kitRoles"); a slug the old kit already had was a deliberate replacement and is left alone.
 * Returns [{ slug, message, fixes: ['rename', 'use-kit'] }].
 */
export function checkUpgrade(spec, newKit, oldKitRoles) {
  if (!Array.isArray(oldKitRoles)) return [];
  const before = new Set(oldKitRoles);
  const out = [];
  for (const [slug, r] of Object.entries(spec.roles)) {
    if (!isCustom(r) || !(slug in newKit.roles) || before.has(slug)) continue;
    out.push({ slug, message: `the new kit adds a role called ${slug}, the same name as your custom agent; rename yours, or switch to the kit's`, fixes: ['rename', 'use-kit'] });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ change safety (kit 0.10)
//
// diffTeams(published, draft, kit) → changes[]: what a draft changes, role by role (architecture section 12.4).
// impact(changes, inventory) → items[]: those changes joined with the work in flight, each with a severity and the
// choices the owner has. Both are pure, so the Studio runs them on every edit and the runner when a publish merges.
//
// inventory: { source: 'runner' | 'board', roles: { <slug>: { state, task, branch, pr, files: [paths touched],
//              queued: <hand-offs waiting for it>, approvals: <pending approvals it raised> } } }
// From board events only (threads mode, no runner), inventoryFromBoard(summarize(...)) builds one; it is marked
// source 'board', and every item from it carries stale: true (PRD 6.9 X9).

const tierOf = (md) => (/^[a-z]+/i.exec(field(md, 'Model'))?.[0] ?? '').toLowerCase();
const statusOf = (md) => field(md, 'Status');
const dormant = (md) => /^dormant/i.test(statusOf(md).trim());
const managerOf = (md) => (field(md, 'Reports to').split(/\s/)[0] ?? '').toLowerCase();
const RANK = { read: 1, write: 2, deploy: 3 };

function sectionsOf(md) {
  const out = new Map();
  for (const s of splitBrief(md).sections) out.set(sectionName(s.heading), trimBlank(s.body).join('\n'));
  return out;
}

/** Every change between two TeamSpecs, as [{ kind, role?, path?, from?, to?, detail }], in a stable order. */
export function diffTeams(published, draft, kit) {
  // Each role's own text (brief plus extension), before sync fits reporting lists to the team and adds Systems: a role
  // switching off must not show up as a brief change on every manager, and bindings are compared on their own below.
  const own = (spec) => new Map(Object.entries(spec.roles).filter(([s, r]) => r.enabled && (r.brief ?? kit.roles[s]) !== undefined)
    .map(([s, r]) => [s, { slug: s, md: emptyExtension(r.extension) ? (r.brief ?? kit.roles[s]) : applyExtension(r.brief ?? kit.roles[s], r.extension) }]));
  const before = own(published);
  const after = own(draft);
  const changes = [];
  const add = (c) => changes.push(c);
  for (const [slug, r] of before) {
    if (!after.has(slug)) { add({ kind: draft.roles[slug] ? 'role-off' : 'role-removed', role: slug, detail: `${slug} is ${draft.roles[slug] ? 'switched off' : 'removed'}` }); continue; }
    const a = after.get(slug);
    if (!dormant(r.md) && dormant(a.md)) add({ kind: 'role-dormant', role: slug, from: statusOf(r.md), to: statusOf(a.md), detail: `${slug} becomes dormant` });
    if (managerOf(r.md) !== managerOf(a.md)) add({ kind: 'reports-to', role: slug, from: managerOf(r.md), to: managerOf(a.md), detail: `${slug} reports to ${managerOf(a.md)} instead of ${managerOf(r.md)}` });
    if (tierOf(r.md) !== tierOf(a.md)) add({ kind: 'tier', role: slug, from: tierOf(r.md), to: tierOf(a.md), detail: `${slug} model tier ${tierOf(r.md)} → ${tierOf(a.md)}` });
    const sb = sectionsOf(r.md);
    const sa = sectionsOf(a.md);
    const names = [...new Set([...sb.keys(), ...sa.keys()])].filter((n) => sb.get(n) !== sa.get(n));
    if (names.length || splitBrief(r.md).header[0] !== splitBrief(a.md).header[0]) {
      add({ kind: 'brief', role: slug, sections: names, detail: `${slug} brief changes${names.length ? `: ${names.join(', ')}` : ' (title)'}` });
    }
  }
  for (const slug of after.keys()) if (!before.has(slug)) add({ kind: 'role-added', role: slug, detail: `${slug} joins the team` });

  // Ownership: a path whose writer changes, or that loses or gains a writer.
  const rows = (spec) => new Map((spec.ownership?.rows ?? []).map((r) => [r.path, r.writer]));
  const ob = rows(published);
  const oa = rows(draft);
  for (const [path, w] of ob) {
    if (!oa.has(path)) add({ kind: 'path-removed', role: w, path, from: w, detail: `${path} no longer has a writer (was ${w})` });
    else if (oa.get(path) !== w) add({ kind: 'path-moved', role: w, path, from: w, to: oa.get(path), detail: `${path} moves from ${w} to ${oa.get(path)}` });
  }
  for (const [path, w] of oa) if (!ob.has(path)) add({ kind: 'path-added', role: w, path, to: w, detail: `${path} is now written by ${w}` });

  // Bindings: removed or narrowed (deploy → write → read) is a change for a working role; added or widened is safe.
  const bind = (spec) => new Map((spec.resources?.bindings ?? []).map((b) => [`${b.role}\u0000${b.resource}`, b]));
  const bb = bind(published);
  const ba = bind(draft);
  for (const [k, b] of bb) {
    const n = ba.get(k);
    if (!n) add({ kind: 'binding-removed', role: b.role, resource: b.resource, from: b.permission, detail: `${b.role} loses ${b.resource}` });
    else if ((RANK[n.permission] ?? 0) < (RANK[b.permission] ?? 0)) add({ kind: 'binding-narrowed', role: b.role, resource: b.resource, from: b.permission, to: n.permission, detail: `${b.role} on ${b.resource}: ${b.permission} → ${n.permission}` });
    else if (n.permission !== b.permission) add({ kind: 'binding-widened', role: b.role, resource: b.resource, from: b.permission, to: n.permission, detail: `${b.role} on ${b.resource}: ${b.permission} → ${n.permission}` });
  }
  for (const [k, b] of ba) if (!bb.has(k)) add({ kind: 'binding-added', role: b.role, resource: b.resource, to: b.permission, detail: `${b.role} gets ${b.resource} (${b.permission})` });

  // Gates, per target; meetings, per id (meetings.json, when the team has one); rules and values as a whole.
  const tb = published.gates?.targets ?? {};
  const ta = draft.gates?.targets ?? {};
  for (const t of [...new Set([...Object.keys(tb), ...Object.keys(ta)])].sort()) if (JSON.stringify(tb[t]) !== JSON.stringify(ta[t])) add({ kind: 'gate', target: t, detail: `the ${t} gate changes` });
  if (JSON.stringify(published.gates?.all) !== JSON.stringify(draft.gates?.all)) add({ kind: 'gate', target: 'all', detail: 'the gates for every target change' });
  const meetings = (spec) => new Map((spec.meetings?.meetings ?? []).map((m) => [m.id, m]));
  const mb = meetings(published);
  const ma = meetings(draft);
  for (const id of [...new Set([...mb.keys(), ...ma.keys()])].sort()) if (JSON.stringify(mb.get(id)) !== JSON.stringify(ma.get(id))) add({ kind: 'meeting', meeting: id, detail: `meeting ${id} ${!ma.has(id) ? 'is removed' : !mb.has(id) ? 'is added' : 'changes'}` });
  if (JSON.stringify(published.rules ?? {}) !== JSON.stringify(draft.rules ?? {})) add({ kind: 'rules', detail: 'the team rules change' });
  if (JSON.stringify(published.values ?? {}) !== JSON.stringify(draft.values ?? {})) add({ kind: 'values', detail: 'project values change' });
  return changes;
}

const BUSY = new Set(['working', 'waiting', 'blocked', 'review']);
const busy = (w) => !!w && BUSY.has(w.state);
const touches = (w, path) => (w?.files ?? []).some((f) => f === path || f.startsWith(path.replace(/\*+$/, '').replace(/\/?$/, '/')) || path.replace(/\*+$/, '') === f);

/** An inventory from the board (summarize() output): each role's latest status, task, branch and PR. Marked stale. */
export function inventoryFromBoard(board) {
  const roles = {};
  for (const c of board?.current ?? []) {
    if (c.instance) continue; // per-PR instances (code-reviewer#57) are not the role's own work
    roles[c.role] = { state: c.status, task: c.task ?? '', branch: c.branch ?? '', pr: c.pr ?? null, files: [], queued: 0, approvals: 0, stale: !!c.stale };
  }
  return { source: 'board', roles };
}

/** A team version by its commit, as the Studio names it: "abc1234" or "abc1234, published 5 Nov" (CPO story D16). */
export function versionName(sha, publishedAt) {
  const short = String(sha ?? '').slice(0, 7);
  if (!publishedAt) return short;
  const d = new Date(publishedAt);
  return Number.isNaN(d.getTime()) ? short : `${short}, published ${d.getUTCDate()} ${d.toLocaleString('en', { month: 'short', timeZone: 'UTC' })}`;
}

/**
 * The rollout of a published team version (demo step 17, CPO copy "Rollout view after a publish", D61 to D63): which
 * roles have picked it up, from the board (summarize() output, whose rows carry the team_version each role last
 * reported). Read-only: it describes, nothing here acts.
 *
 *   version      the commit the publish merged (any length from 7); newer: later versions that also count as moved
 *   publishedAt  when it merged. A role counts as moved only when a report after this names the new version (D61).
 *   roles        the slugs the published team runs; off: slugs the publish switched off, removed or made dormant
 *   plan         the change step's choices, { [role]: { choice: 'finish' | 'handoff' | 'pause' | ..., to? } }
 *
 * Each role gets one state: moved, next-task (idle on the old version, picks it up at its next task), finishing
 * (mid-task on the old version, with its plan), off-finishing, off, no-report (nothing since the publish; lastAt when
 * older reports exist) or unknown (reports without a version: an older kit or another coding agent). Unknown roles
 * stay outside "n of m" (D62).
 */
export function rollout({ version, publishedAt = null, newer = [], roles = [], off = [], plan = {}, board = { current: [] } } = {}) {
  const v = String(version ?? '');
  if (!/^[0-9a-f]{7,40}$/.test(v)) return { version: null, name: null, roles: [], summary: null };
  const same = (a, b) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));
  const isNew = (tv) => same(tv, v) || newer.some((n) => same(tv, String(n)));
  const since = publishedAt ? Date.parse(publishedAt) : NaN;
  const after = (at) => Number.isNaN(since) || (!!at && Date.parse(at) >= since);
  const rows = new Map((board?.current ?? []).filter((c) => !c.instance).map((c) => [c.role, c]));
  const offSet = new Set(off);
  const slugs = [...new Set([...roles, ...off])].sort();
  const out = slugs.map((role) => {
    const c = rows.get(role);
    const base = { role, teamVersion: c?.team_version ?? null, status: c?.status ?? null, task: c?.task ?? '', lastAt: c?.last_at ?? null, stale: !!c?.stale };
    const working = !!c && BUSY.has(c.status);
    if (offSet.has(role)) return { ...base, state: working && after(c.last_at) ? 'off-finishing' : 'off' };
    if (!c || !after(c.last_at)) return { ...base, state: 'no-report' };
    if (c.team_version && isNew(c.team_version) && after(c.team_version_at)) return { ...base, state: 'moved' };
    if (!c.team_version) return { ...base, state: 'unknown' };
    if (working) return { ...base, state: 'finishing', plan: plan[role] ?? { choice: 'finish' } };
    return { ...base, state: 'next-task' };
  });
  const count = (st) => out.filter((r) => r.state === st).length;
  const counted = out.filter((r) => !['off', 'off-finishing', 'unknown'].includes(r.state)).length;
  const moved = count('moved');
  return {
    version: v, name: versionName(v, publishedAt), publishedAt,
    roles: out,
    summary: { moved, of: counted, finishing: count('finishing'), offFinishing: count('off-finishing'), unknown: count('unknown'), noReport: count('no-report'), allMoved: counted > 0 && moved === counted },
  };
}

/**
 * Each change joined with the work in flight: [{ id, kind, role, detail, severity: 'safe' | 'choice' | 'blocking',
 * inFlight, choices, recommended, stale }]. Choices are ids the runner knows (architecture section 12.4).
 *
 * The result only describes: nothing here acts, and no item stops a publish (CPO story D15; only check errors do).
 * From board data (source 'board', threads mode) the choices are the ones a thread can carry out itself (D13):
 * finish, handoff, pause, and for a moved area move-after-merge or move-and-handover; "finish" is the default.
 * With a runner inventory the full 12.4 set is offered, and a pending approval that would be left with no one to run
 * it is 'blocking' (the runner will not apply the change until it is reassigned or cancelled).
 */
export function impact(changes, inventory = { roles: {} }) {
  const runner = inventory.source === 'runner';
  const stale = !runner;
  const at = (slug) => inventory.roles?.[slug];
  const items = [];
  changes.forEach((c, n) => {
    const w = c.role ? at(c.role) : undefined;
    const item = { id: `${c.kind}:${c.role ?? c.path ?? c.target ?? c.meeting ?? n}${c.path && c.role ? `:${c.path}` : ''}${c.resource ? `:${c.resource}` : ''}`, kind: c.kind, role: c.role, detail: c.detail, stale };
    const inFlight = busy(w) ? { state: w.state, task: w.task ?? '', branch: w.branch ?? '', pr: w.pr ?? null } : null;
    const set = (severity, choices, recommended, note) => items.push({ ...item, severity, inFlight, choices, recommended, ...(note ? { note } : {}) });
    switch (c.kind) {
      case 'role-off': case 'role-removed': case 'role-dormant': {
        if (runner && w?.approvals) return set('blocking', ['reassign-approvals', 'cancel-approvals'], 'reassign-approvals', `${w.approvals} pending approval(s) would have no one to run them`);
        if (!inFlight) return set('safe', ['off-at-merge'], 'off-at-merge');
        if (!runner) return set('choice', ['finish', 'handoff', 'pause'], 'finish');
        // Near done: in review or waiting with a PR open. Otherwise hand the work to someone who stays.
        const near = w.pr && ['review', 'waiting'].includes(w.state);
        return set('choice', ['finish', 'handoff', 'pause', 'apply-now', 'stop-drop'], near ? 'finish' : 'handoff');
      }
      case 'path-moved': case 'path-removed': {
        const owner = at(c.from);
        const hot = busy(owner) && (touches(owner, c.path) || !owner.files?.length);
        if (!hot) return set('safe', ['move-at-merge'], 'move-at-merge');
        const choices = runner ? ['move-after-merge', 'move-with-exception', 'move-and-handover'] : ['move-after-merge', 'move-and-handover'];
        return items.push({ ...item, role: c.from, severity: 'choice', inFlight: { state: owner.state, task: owner.task ?? '', branch: owner.branch ?? '', pr: owner.pr ?? null }, choices, recommended: 'move-after-merge', ...(owner.files?.length ? {} : { note: 'which files the work touches is not known; it may touch this area' }) });
      }
      case 'binding-removed': case 'binding-narrowed':
        return inFlight && runner ? set('choice', ['next-task', 'revoke-now'], 'next-task') : set('safe', ['next-task'], 'next-task');
      case 'tier': case 'brief':
        return inFlight && runner ? set('choice', ['next-task', 'apply-now'], 'next-task') : set('safe', ['next-task'], 'next-task');
      case 'reports-to': {
        const old = at(c.from);
        return old?.queued ? set('choice', ['reroute-queued', 'keep-queued'], 'reroute-queued', `${old.queued} hand-off(s) queued for ${c.from}`) : set('safe', ['next-task'], 'next-task');
      }
      case 'gate': return runner ? set('choice', ['old-gate-open-prs', 'new-gate-all'], 'old-gate-open-prs') : set('safe', ['next-task'], 'next-task');
      case 'meeting': return set('safe', ['finish-meeting'], 'finish-meeting');
      default: return set('safe', ['next-task'], 'next-task'); // role-added, path-added, binding-added/widened, rules, values
    }
  });
  const order = { blocking: 0, choice: 1, safe: 2 };
  return items.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ------------------------------------------------------------------------------------------------ meetings (kit 0.11)
//
// .agent-team/meetings.json, carried as spec.meetings (architecture 12.2, CPO story "meeting definitions"):
//   { "meetings": [ { "id", "title",
//       "when": { "days": ["mon", ...], "at": "09:00" }  or  { "label": "design" }     (wall-clock in values.TIMEZONE)
//       "attendees": { "roles": [...], "lanes": [<executive slug>, ...], "rule": null | "worked-since-last" },
//       "facilitator": "chief-of-staff", "format": "round" | "discussion", "rounds": 1,
//       "agenda": "...", "ifBusy": "next-pause" | "proxy" | "skip",
//       "owner": { "minutes": true, "speaks": false }, "capUsd": 1.0, "skipIfQuiet": true } ] }
// sync adds a "Meetings" section to the project instructions and "- meeting" to the Wakes on of every role a
// meeting names (attendees and facilitator). The runner holds the meetings; until it is connected they are definitions.

export const MEETING_FORMATS = ['round', 'discussion'];
export const MEETING_IF_BUSY = ['next-pause', 'proxy', 'skip'];
export const MEETING_RULES = ['worked-since-last'];
const MEETING_ID = /^[a-z0-9][a-z0-9-]*$/;
const isDormant = (md) => /dormant/i.test(field(md, 'Status'));

/**
 * The roles a meeting wakes, from the resolved team ([{ slug, md }]): named roles, every role in a named lane (the
 * executive and everyone reporting up to it, dormant roles only when named), and the facilitator.
 * { roles: [slug], missing: [slug], dynamic } — dynamic when the "worked since the last one" rule adds roles at run time.
 */
export function meetingAttendees(meeting, roles) {
  const bySlug = new Map(roles.map((r) => [r.slug, r]));
  const a = meeting.attendees ?? {};
  const named = [...(a.roles ?? []), ...(meeting.facilitator ? [meeting.facilitator] : [])];
  const out = new Set();
  const missing = [];
  for (const s of named) if (bySlug.has(s)) out.add(s); else missing.push(s);
  for (const lane of a.lanes ?? []) {
    if (!bySlug.has(lane)) { missing.push(lane); continue; }
    out.add(lane);
    for (const r of roles) {
      if (isDormant(r.md)) continue;
      const seen = new Set();
      for (let m = managerOf(r.md); m && bySlug.has(m) && !seen.has(m); m = managerOf(bySlug.get(m).md)) {
        if (m === lane) { out.add(r.slug); break; }
        seen.add(m);
      }
    }
  }
  return { roles: [...out].sort(), missing: [...new Set(missing)], dynamic: MEETING_RULES.includes(a.rule) };
}

const DAY_NAMES = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
/** "Mon to Fri 09:00", "Tue, Thu 14:00", "Daily 08:00", "when an item gets the label design". */
export function meetingWhen(when) {
  if (when?.label) return `when an item gets the label \`${when.label}\``;
  const days = when?.days ?? [];
  const order = days.map((d) => DAYS.indexOf(d)).sort((x, y) => x - y);
  const run = order.length > 2 && order.every((d, i) => i === 0 || d === order[i - 1] + 1);
  const label = order.length === 7 ? 'Daily' : run ? `${DAY_NAMES[DAYS[order[0]]]} to ${DAY_NAMES[DAYS[order.at(-1)]]}` : order.map((d) => DAY_NAMES[DAYS[d]]).join(', ');
  return `${label} ${when?.at ?? ''}`.trim();
}

/** The "Meetings" section of the project instructions, or '' when the team has none. */
export function renderMeetings(meetings, roles, { timezone = 'the team\'s time zone' } = {}) {
  const list = meetings?.meetings ?? [];
  if (!list.length) return '';
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const rows = list.map((m) => {
    const who = meetingAttendees(m, roles);
    const attendees = [...who.roles.filter((s) => s !== m.facilitator), ...(who.dynamic ? ['everyone who worked since the last one'] : [])].join(', ') || 'nobody yet';
    return `| ${cell(m.title ?? m.id)} | ${cell(meetingWhen(m.when))} | ${cell(attendees)} | ${cell(m.facilitator ?? 'chief-of-staff')} |`;
  });
  return [
    '## Meetings',
    '',
    `The team's meetings, defined in \`.agent-team/meetings.json\`. Times are in ${timezone}. The role in "Run by" opens each meeting, asks every attendee for their turn and writes the minutes; an attendee that is working answers at its next pause. Meetings are held by the team's runner; without one they are the schedule the chief of staff keeps.`,
    '',
    '| Meeting | When | Attendees | Run by |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n') + '\n';
}

/** Adds "- meeting" to the Wakes on of every role a meeting names, the way sync does. */
export function applyMeetings(roles, meetings) {
  const invited = new Set((meetings?.meetings ?? []).flatMap((m) => meetingAttendees(m, roles).roles));
  return roles.map((r) => {
    if (!invited.has(r.slug)) return r;
    const w = wakesOn(r.md);
    if (w.triggers.some((t) => t.type === 'meeting')) return r;
    const current = briefSection(r.md, 'wakes on');
    return { ...r, md: setBriefSection(r.md, 'Wakes on', `${current ? `${current}\n` : ''}- meeting`) };
  });
}

/**
 * Checks of meetings.json against the resolved team ([{ slug, md }]), in validate's shape. dailyCapUsd is the team's
 * daily cap when one is set (the control plane's budget, or team.json "budgets.dailyUsd").
 */
export function checkMeetings(meetings, roles, { dailyCapUsd } = {}) {
  const out = [];
  if (meetings === undefined) return out;
  const add = (level, id, message) => out.push({ level, where: id ? `meetings/${id}` : 'meetings', message });
  if (!Array.isArray(meetings?.meetings)) return [{ level: 'error', where: 'meetings', message: 'meetings.json must be { "meetings": [...] }' }];
  const bySlug = new Map(roles.map((r) => [r.slug, r]));
  const ids = new Set();
  const slots = new Map(); // "day at" → [{ id, roles }]
  for (const m of meetings.meetings) {
    const id = m.id;
    if (!MEETING_ID.test(id ?? '')) add('error', null, `meeting id "${id ?? ''}" must be lower-case letters, digits and hyphens`);
    else if (ids.has(id)) add('error', id, 'this id is used by two meetings');
    ids.add(id);
    if (!String(m.title ?? '').trim()) add('error', id, 'has no title');
    if (!String(m.agenda ?? '').trim()) add('error', id, 'has no agenda');
    const w = m.when ?? {};
    if (w.label !== undefined) {
      if (!String(w.label).trim()) add('error', id, 'the label that starts this meeting is empty');
    } else {
      const days = w.days ?? [];
      if (!Array.isArray(days) || !days.length) add('error', id, 'needs days and a time, or a label that starts it');
      else for (const d of days) if (!DAYS.includes(d)) add('error', id, `"${d}" is not a day (mon to sun)`);
      const t = /^(\d{2}):(\d{2})$/.exec(w.at ?? '');
      if (!t || Number(t[1]) > 23 || Number(t[2]) > 59) add('error', id, `"${w.at ?? ''}" is not a time of day (HH:MM)`);
    }
    const a = m.attendees ?? {};
    for (const s of [...(a.roles ?? []), ...(a.lanes ?? []), ...(m.facilitator ? [m.facilitator] : [])]) {
      if (!bySlug.has(s)) add('error', id, `${s} is not on the team`);
    }
    if (a.rule != null && !MEETING_RULES.includes(a.rule)) add('error', id, `attendee rule "${a.rule}" is not ${MEETING_RULES.join(' or ')}`);
    if (m.format !== undefined && !MEETING_FORMATS.includes(m.format)) add('error', id, `format "${m.format}" is not round or discussion`);
    if (m.format === 'discussion' && !(Number.isInteger(m.rounds) && m.rounds >= 2 && m.rounds <= 5)) add('error', id, 'a discussion has 2 to 5 rounds');
    if (m.ifBusy !== undefined && !MEETING_IF_BUSY.includes(m.ifBusy)) add('error', id, `ifBusy "${m.ifBusy}" is not ${MEETING_IF_BUSY.join(', ')}`);
    if (!(typeof m.capUsd === 'number' && m.capUsd > 0)) add('error', id, 'the cost cap must be above zero');
    else if (typeof dailyCapUsd === 'number' && m.capUsd > dailyCapUsd) add('error', id, `the cost cap ($${m.capUsd}) is above the team's daily cap ($${dailyCapUsd})`);
    const who = meetingAttendees(m, roles);
    const others = who.roles.filter((s) => s !== m.facilitator);
    if (others.length < 2 && !who.dynamic) add('warning', id, `has ${others.length === 1 ? 'one attendee' : 'no attendees'} besides the role that runs it`);
    if (!w.label && Array.isArray(w.days)) {
      const clashes = new Map(); // one warning per other meeting, naming every shared day
      for (const d of w.days) {
        const k = `${d} ${w.at}`;
        for (const o of slots.get(k) ?? []) {
          const both = who.roles.filter((s) => o.roles.includes(s));
          if (!both.length) continue;
          const c = clashes.get(o.id) ?? { days: new Set(), both: new Set() };
          c.days.add(d); both.forEach((s) => c.both.add(s)); clashes.set(o.id, c);
        }
        slots.set(k, [...(slots.get(k) ?? []), { id, roles: who.roles }]);
      }
      for (const [other, c] of clashes) add('warning', id, `meets at the same time as ${other} (${[...c.days].join(', ')} ${w.at}), and both include ${[...c.both].join(', ')}`);
    }
  }
  return out;
}

/**
 * The cost estimate of one meeting (CPO D26): turns × each role's tier at list price.
 * A round asks each attendee once; a discussion, `rounds` times; the role that runs it opens and closes.
 * { perMeetingUsd, perMonthUsd (null for an event-triggered meeting), asOf, turns }. `turn` is the token size of one
 * turn (from recent runs when there are some); each role's tier comes from its Model line.
 */
export function meetingEstimate(meeting, roles, prices, { turn = { inputTokens: 20000, outputTokens: 1500 }, overrides } = {}) {
  const bySlug = new Map(roles.map((r) => [r.slug, r]));
  const tier = (slug) => (/^[a-z]+/i.exec(field(bySlug.get(slug)?.md, 'Model'))?.[0] ?? 'standard').toLowerCase();
  const turnUsd = (slug) => {
    const t = { ...prices.tiers, ...overrides };
    const p = prices.models?.[t[tier(slug)] ?? t.standard];
    return p ? (turn.inputTokens * p.inputPerMTok + turn.outputTokens * p.outputPerMTok) / 1e6 : 0;
  };
  const who = meetingAttendees(meeting, roles);
  const rounds = meeting.format === 'discussion' ? meeting.rounds ?? 3 : 1;
  const others = who.roles.filter((s) => s !== meeting.facilitator);
  let usd = others.reduce((sum, s) => sum + rounds * turnUsd(s), 0);
  let turns = others.length * rounds;
  if (meeting.facilitator && bySlug.has(meeting.facilitator)) { usd += 2 * turnUsd(meeting.facilitator); turns += 2; }
  const perMeetingUsd = Math.round(usd * 100) / 100;
  const days = meeting.when?.label ? 0 : (meeting.when?.days ?? []).length;
  return { perMeetingUsd, perMonthUsd: days ? Math.round(usd * days * (52 / 12) * 100) / 100 : null, asOf: prices.asOf, turns };
}

// ------------------------------------------------------------------------------------------------ team templates (kit 0.12)
//
// A template is a folder the Studio's "New team" gallery and `agent-team init --template <id>` start a team from
// (CPO story "team templates", D29 to D36):
//   template.json   { "schema": "agent-team/team-template@1", "id", "title", "summary", "group",
//                     "preset" (the base, default "minimal") and optionally "roles" (the exact kit roles to switch on),
//                     "dormant": [slug], "values": {...}, "extensions": { slug: "<role>.extend.md text" },
//                     "systems": [{ "type", "name", "for": [slug] }]   suggested, never bound, never secrets
//                     "areas": [{ "path", "writer", "notes" }]          → ownership.json
//                     "checks": { gates.json }                          → gates.json
//                     "meetings": [ meetings.json entries ]             → meetings.json
//                     "layout": { slug: { x, y } } }                    → studio.json, with the suggested systems }
//   roles/          custom agents in the role pack format (<slug>.md, optional pack.json)
// A team made from a template has no link back to it: team.json only records "from": "<id>@<kit version>" (D35).

export const TEMPLATE_SCHEMA = 'agent-team/team-template@1';
export const TEMPLATE_GROUPS = { product: 'Build a product', 'business-function': 'Run a business function', 'open-source': 'Maintain open source' };

/** template.json and the custom agents of a template folder (files: relative path → text). */
export function readTemplate(files) {
  const template = JSON.parse(files['template.json']);
  const packFiles = Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith('roles/')).map(([p, t]) => [p.slice('roles/'.length), t]));
  const agents = Object.keys(packFiles).some((p) => p.endsWith('.md')) ? readPack(packFiles) : [];
  return { template, agents, packFiles };
}

/**
 * The TeamSpec a template makes, for the values the create form asks for (D31). The Studio and `init --template`
 * both compile this spec, so they write the same files.
 */
export function templateSpec(files, kit, { project, owner = 'the owner', timezone = 'UTC', kitVersion = '', kitSpec } = {}) {
  const { template: t, agents } = readTemplate(files);
  const preset = t.preset ?? 'minimal';
  const team = {
    ...(kitSpec ? { kit: kitSpec } : {}), preset, include: [], exclude: [],
    values: { DIGEST_TIME: '08:00', ...(t.values ?? {}), PROJECT_NAME: project ?? t.title, OWNER: owner, TIMEZONE: timezone },
  };
  const spec = importLayer({ 'team.json': JSON.stringify(team) }, kit);
  if (Array.isArray(t.roles)) {
    for (const [slug, r] of Object.entries(spec.roles)) r.enabled = t.roles.includes(slug);
    for (const slug of t.roles) if (!spec.roles[slug]) spec.roles[slug] = { source: 'missing', enabled: true };
  }
  for (const a of agents) spec.roles[a.slug] = { source: a.slug in kit.roles ? 'project-replaces-kit' : 'project', enabled: true, brief: a.md };
  for (const [slug, text] of Object.entries(t.extensions ?? {})) {
    if (!spec.roles[slug]) continue;
    spec.roles[slug].extension = parseExtension(text);
    spec.roles[slug].extensionText = text;
  }
  for (const slug of t.dormant ?? []) {
    const r = spec.roles[slug];
    if (!r || isCustom(r)) continue;
    const title = titleOf(applyExtension(kit.roles[slug] ?? '', r.extension ?? {}), slug);
    setField(spec, slug, 'Status', `dormant until the owner says "start ${title}". The chief of staff or the lane's executive opens the thread with this brief and an empty memory file.`);
  }
  if (t.areas?.length) spec.ownership = { rows: t.areas.map((a) => ({ path: a.path, writer: a.writer, notes: a.notes ?? '' })) };
  if (t.checks) spec.gates = t.checks;
  if (t.meetings?.length) spec.meetings = { meetings: t.meetings };
  if (t.systems?.length || t.layout) spec.canvas = { ...(t.systems?.length ? { suggestedSystems: t.systems } : {}), ...(t.layout ? { layout: t.layout } : {}) };
  spec.options = { subagents: false, hooks: true, ...(Array.isArray(t.packs) ? { packs: t.packs } : {}), from: `${t.id}@${kitVersion}` };
  return spec;
}

/** The .agent-team/ files a template makes (what the Studio publishes and `agent-team init --template` writes). */
export function templateLayer(files, kit, form) {
  return compileLayer(templateSpec(files, kit, form), kit);
}

/** A template's catalogue card: what the gallery shows before anything is written (D31, D33). */
export function templateCard(files, kit) {
  const { template: t } = readTemplate(files);
  const { roles } = resolveSpec(templateSpec(files, kit, { project: t.title }), kit);
  const dormant = roles.filter((r) => isDormant(r.md)).map((r) => r.slug);
  return {
    id: t.id, title: t.title, summary: t.summary, group: t.group, groupTitle: TEMPLATE_GROUPS[t.group] ?? t.group,
    roles: roles.map((r) => r.slug), on: roles.length - dormant.length, dormant, packs: teamPacks(t),
    systems: (t.systems ?? []).map((s) => ({ type: s.type, name: s.name })), meetings: (t.meetings ?? []).map((m) => ({ id: m.id, title: m.title, when: meetingWhen(m.when) })),
  };
}

/**
 * Checks a template the way a team is checked (criterion 1): the format, the custom agents as a role pack, and the
 * team it makes through validate. Returns [{ level, where, message }], errors first.
 */
export function checkTemplate(files, kit) {
  const out = [];
  const add = (level, where, message) => out.push({ level, where, message });
  let parsed;
  try { parsed = readTemplate(files); } catch (e) { return [{ level: 'error', where: 'template.json', message: `cannot be read: ${e.message}` }]; }
  const { template: t, agents, packFiles } = parsed;
  if (t.schema !== TEMPLATE_SCHEMA) add('error', 'template.json', `schema must be ${TEMPLATE_SCHEMA}`);
  if (!SLUG.test(t.id ?? '')) add('error', 'template.json', `id "${t.id ?? ''}" must be a lower-case slug`);
  for (const k of ['title', 'summary']) if (!String(t[k] ?? '').trim()) add('error', 'template.json', `has no ${k}`);
  if (!(t.group in TEMPLATE_GROUPS)) add('error', 'template.json', `group "${t.group}" is not one of ${Object.keys(TEMPLATE_GROUPS).join(', ')}`);
  if (t.preset !== undefined && !kit.presets[t.preset]) add('error', 'template.json', `the kit has no preset "${t.preset}"`);
  if (t.packs !== undefined && !Array.isArray(t.packs)) add('error', 'template.json', 'packs must be a list of pack names');
  const agentSlugs = new Set(agents.map((a) => a.slug));
  for (const s of t.roles ?? []) if (!(s in kit.roles) && !agentSlugs.has(s)) add('error', 'template.json', `roles lists "${s}", which is neither a kit role nor one of the template's agents`);
  for (const s of t.dormant ?? []) if (!(s in kit.roles) && !agentSlugs.has(s)) add('error', 'template.json', `dormant lists "${s}", which is not on the team`);
  for (const s of Object.keys(t.extensions ?? {})) if (!(s in kit.roles)) add('error', `extensions/${s}`, 'extends a role the kit does not have');
  for (const s of t.systems ?? []) {
    if (!String(s.type ?? '').trim() || !String(s.name ?? '').trim()) add('error', 'template.json', 'every suggested system needs a type and a name');
    if (s.secrets || s.config) add('error', 'template.json', `suggested system "${s.name}" carries settings or secrets; a template suggests the type only`);
  }
  if (SECRET_PATTERNS.some((p) => p.test(files['template.json']))) add('error', 'template.json', 'looks like it contains a secret value');
  if (agents.length) for (const i of checkPack(packFiles, null, kit)) if (!/the kit has a role called/.test(i.message)) out.push(i);
  for (const a of agents) {
    if (!briefSection(a.md, 'hands to')) add('error', `roles/${a.slug}`, 'has no "## Hands to"');
    const handsTo = briefSection(a.md, 'hands to');
    if (/SIGNOFF/.test(handsTo) && !signoffEvidence(a.md).length) add('error', `roles/${a.slug}`, 'signs off but lists no sign-off evidence');
  }
  if (out.some((i) => i.level === 'error')) return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
  const spec = templateSpec(files, kit, { project: t.title });
  for (const i of validate(spec, kit)) out.push(i);
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------------------------
// Protocol packs (kit 0.13). team/protocols.md and team/project-instructions.md are the neutral core every team
// gets; a slot in the core (<!-- slot:name --> default lines <!-- /slot -->) is filled by a pack that has
// <!-- fill:name --> for it (team/packs/<pack>/<file>). A team's packs are team.json "packs"; a team without the key
// gets DEFAULT_PACKS, so teams made before 0.13 keep the rules they had.

export const DEFAULT_PACKS = ['engineering'];
export const PACK_DOCS = ['protocols.md', 'project-instructions.md'];
const SLOT_RE = /^<!-- slot:([a-z0-9-]+) -->\n([\s\S]*?)^<!-- \/slot -->$/gm;
const FILL_RE = /^<!-- fill:([a-z0-9-]+) -->$/m;

/** The packs a team uses: team.json "packs", or DEFAULT_PACKS when it has none. */
export function teamPacks(options = {}) {
  return Array.isArray(options?.packs) ? options.packs : DEFAULT_PACKS;
}

/** A pack file's fills, as { slot: text }. Text before the first fill is a comment. */
export function parseFills(text) {
  const fills = {};
  const parts = String(text ?? '').split(FILL_RE);
  for (let i = 1; i < parts.length; i += 2) fills[parts[i]] = parts[i + 1].replace(/^\n/, '').replace(/\n+$/, '');
  return fills;
}

/** The slot names a core file has. */
export function docSlots(core) {
  return [...String(core).matchAll(SLOT_RE)].map((m) => m[1]);
}

/** A core file with each slot replaced by the last given pack that fills it, or by the core's own default. */
export function composeDoc(core, packTexts = []) {
  const fills = Object.assign({}, ...packTexts.map(parseFills));
  return String(core)
    .replace(SLOT_RE, (m, name, dflt) => (name in fills ? fills[name] : dflt.replace(/\n$/, '')))
    .replace(/\n{3,}/g, '\n\n');
}

/** The composed protocols or project instructions for a team's packs: kit.docs[file] and kit.packs[pack][file]. */
export function teamDoc(kit, file, packs = DEFAULT_PACKS) {
  return composeDoc(kit.docs?.[file] ?? '', packs.map((p) => kit.packs?.[p]?.[file] ?? ''));
}

// The one footer line of every brief that assumes a repository. A team without the engineering pack gets the neutral
// wording (D40); in a repository, saving where the team can see it still means pushing.
const PUSH_LINE = 'Push before long steps and at the end of the task.';
const SAVE_LINE = 'Save your work where the team can see it before long steps and at the end of the task.';

/** A brief as a team with these packs reads it. */
export function fitToPacks(md, packs = DEFAULT_PACKS) {
  return packs.includes('engineering') ? md : String(md).split(PUSH_LINE).join(SAVE_LINE);
}

/** Checks the kit's packs against the core: every fill names a slot that exists. */
export function checkPacks(kit) {
  const out = [];
  for (const [pack, docs] of Object.entries(kit.packs ?? {})) {
    for (const [file, text] of Object.entries(docs)) {
      const slots = new Set(docSlots(kit.docs?.[file] ?? ''));
      for (const name of Object.keys(parseFills(text))) if (!slots.has(name)) out.push({ level: 'error', where: `packs/${pack}/${file}`, message: `fills "${name}", which ${file} has no slot for` });
    }
  }
  return out;
}

/** The role template as a team with these packs gets it: without the engineering pack, a neutral group and manager. */
export function roleTemplateFor(md, packs = DEFAULT_PACKS) {
  if (packs.includes('engineering')) return md;
  return fitToPacks(md, packs).replace(/^\*\*Group:\*\* engineering$/m, '**Group:** <group>').replace(/^\*\*Reports to:\*\* cto$/m, '**Reports to:** chief-of-staff');
}

// ---------------------------------------------------------------------------------------------------------------
// Targets (kit 0.15): which coding agents the team's instructions are written for. "claude-code" is always written;
// "agents-md" adds a vendor-neutral AGENTS.md at the repository root (CPO story "Other coding agents", D42 to D48).

export const TARGETS = ['claude-code', 'agents-md'];
export const DEFAULT_TARGETS = ['claude-code'];
export const AGENTS_START = /<!-- agent-team:start[^\n]*?-->/;
export const AGENTS_END = '<!-- agent-team:end -->';

/** The targets a team uses: team.json "targets", or DEFAULT_TARGETS. */
export function teamTargets(options = {}) {
  return Array.isArray(options?.targets) ? options.targets : DEFAULT_TARGETS;
}

/**
 * The project instructions in tool-neutral words, for AGENTS.md: the part below the line (the part a person pastes),
 * with the hosted-session wording made neutral, the Node scripts in place of the bash ones, and the optional plugin
 * list (which belongs to one tool) left out.
 */
export function neutralInstructions(text) {
  const parts = String(text).split(/\n---\n/);
  const below = (parts.length > 1 ? parts.slice(1).join('\n---\n') : parts[0]).replace(/\n<!-- Generated by (?:OrgCraft|Agent Team Kit)[^\n]*-->\n?/g, '\n');
  return below
    .replace(/Claude Code sessions \(Remote Control on the owner's machine, or cloud sessions\)/g, "coding-agent sessions (on the owner's machine or in the cloud)")
    .replace(/\n## Working style \(optional plugins\)\n[\s\S]*?(?=\n## |$)/, '\n')
    .replace(/`scripts\/agent-team\/team-status\.sh`/g, '`node scripts/agent-team/report.mjs`')
    .replace(/`scripts\/agent-team\/with-lock\.sh`/g, '`node scripts/agent-team/with-lock.mjs`')
    .replace(/`scripts\/agent-team\/merge-gate\.sh`/g, '`node scripts/agent-team/merge-gate.mjs`')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Puts the kit's block into a file that may hold the repository's own text: replaced between the markers, else added. */
export function spliceBlock(existing, block) {
  if (existing === null || existing === undefined || !existing.trim()) return `${block}\n`;
  const start = AGENTS_START.exec(existing);
  const end = existing.indexOf(AGENTS_END);
  if (start && end > start.index) return existing.slice(0, start.index) + block + existing.slice(end + AGENTS_END.length);
  return `${existing.trimEnd()}\n\n${block}\n`;
}

/** The file without the kit's block (what is left when the target is switched off), or null when nothing is left. */
export function withoutBlock(existing) {
  const start = AGENTS_START.exec(existing ?? '');
  const end = (existing ?? '').indexOf(AGENTS_END);
  if (!start || end < start.index) return existing;
  const rest = (existing.slice(0, start.index).trimEnd() + '\n\n' + existing.slice(end + AGENTS_END.length).trimStart()).trim();
  return rest ? `${rest}\n` : null;
}
