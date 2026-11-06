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
  for (const x of team.exclude ?? []) wanted.delete(x);
  for (const s of own) wanted.add(s);

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

/** The project layer for a TeamSpec, as relative path → content. The include/exclude lists are the smallest diff from the preset. */
export function compileLayer(spec, kit) {
  const preset = kit.presets[spec.preset];
  if (!preset) throw new Error(`the kit has no preset "${spec.preset}"`);
  const inPreset = new Set(preset);
  const enabledKit = (slug, r) => r.enabled && (r.source === 'kit' || r.source === 'missing');
  let include = Object.entries(spec.roles).filter(([s, r]) => enabledKit(s, r) && !inPreset.has(s)).map(([s]) => s);
  let exclude = preset.filter((s) => spec.roles[s] && !spec.roles[s].enabled);
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
    if (r.source === 'project' || r.source === 'project-replaces-kit') {
      if (!r.enabled) continue; // a project role that is switched off is removed from the layer
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
export const isLayerPath = (p) => p === 'team.json' || Object.values(RULE_FILES).includes(p) || ['ownership.json', 'gates.json', 'resources.json', 'studio.json'].includes(p) || (/^roles\/[^/]+\.md$/.test(p) && !/\/(_|README\.md$)/.test(p));

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
  return { roles: applyBindings(roles, spec.resources), warnings };
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

export const DATA_FILES = { ownership: 'ownership.json', gates: 'gates.json', resources: 'resources.json', canvas: 'studio.json' };
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
export function validate(spec, kit) {
  const issues = [];
  const add = (level, where, message) => issues.push({ level, where, message });
  const { roles, warnings } = resolveSpec(spec, kit);
  for (const w of warnings) add('warning', 'roles', w);
  const installed = new Map(roles.map((r) => [r.slug, r]));
  const manager = new Map(roles.map((r) => [r.slug, (field(r.md, 'Reports to').split(/\s/)[0] ?? '').toLowerCase()]));
  const top = roles.filter((r) => manager.get(r.slug) === 'owner');
  if (top.length !== 1) add('error', 'roles', `exactly one role must report to the owner (found ${top.map((r) => r.slug).join(', ') || 'none'})`);
  for (const [slug, m] of manager) {
    if (!m) add('error', `roles/${slug}`, 'has no "Reports to" line');
    else if (m !== 'owner' && !installed.has(m)) add('error', `roles/${slug}`, `reports to "${m}", which is not on the team`);
    const tier = (/^[a-z]+/i.exec(field(installed.get(slug).md, 'Model'))?.[0] ?? '').toLowerCase();
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
  // No secrets anywhere in the team's text.
  const texts = [['values', JSON.stringify(spec.values ?? {})], ['rules', JSON.stringify(spec.rules ?? {})], ['resources', JSON.stringify(spec.resources ?? {})],
    ['gates', JSON.stringify(spec.gates ?? {})], ...Object.entries(spec.roles).map(([s, r]) => [`roles/${s}`, JSON.stringify([r.brief ?? '', r.extension ?? {}])])];
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

/** A role pack for one agent: { '<slug>.md': brief, 'pack.json': what it needs }. Never secrets: only names and paths. */
export function rolePack(spec, slug) {
  const r = spec.roles[slug];
  if (!isCustom(r)) throw new Error(`${slug} is not a custom agent`);
  const bindings = (spec.resources?.bindings ?? []).filter((b) => b.role === slug);
  const types = bindings.map((b) => spec.resources.resources.find((x) => x.id === b.resource)?.type).filter(Boolean);
  const needs = {
    tools: briefSection(r.brief, 'tools').split(/[,\n]/).map((t) => t.replace(/^-\s*/, '').trim()).filter(Boolean),
    resources: [...new Set(types)],
    paths: ownsPaths(r.brief).paths.filter((p) => p.mode === 'writes').map((p) => p.path),
  };
  return { [`${slug}.md`]: r.brief, 'pack.json': JSON.stringify({ schema: 'agent-team/role-pack@1', roles: [slug], needs }, null, 2) + '\n' };
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
    if (/signoff/i.test(briefSection(r.brief, 'hands to')) && !briefSection(r.brief, 'sign-off evidence').trim()) {
      issues.push({ level: 'warning', where, message: 'sends SIGNOFF but lists no sign-off evidence (screenshots, logs, links)' });
    }
  }
  return issues;
}
