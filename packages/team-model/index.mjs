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
    if (extended.includes(slug)) role.extension = parseExtension(files[`roles/${slug}.extend.md`]);
    roles[slug] = role;
  }

  const rules = {};
  for (const [k, f] of Object.entries(RULE_FILES)) if (files[f] !== undefined) rules[k] = files[f];
  const options = Object.fromEntries(Object.entries(team).filter(([k]) => !MODELLED.includes(k)));
  const spec = { schema: SCHEMA, preset, values: team.values ?? {}, roles, rules, options };
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
    if (!emptyExtension(r.extension)) files[`roles/${slug}.extend.md`] = formatExtension(r.extension);
  }
  for (const [k, f] of Object.entries(RULE_FILES)) if (spec.rules?.[k] !== undefined) files[f] = spec.rules[k];
  return files;
}

/** The paths compileLayer owns: a writer deletes files under these that the new layer no longer has. */
export const isLayerPath = (p) => p === 'team.json' || Object.values(RULE_FILES).includes(p) || (/^roles\/[^/]+\.md$/.test(p) && !/\/(_|README\.md$)/.test(p));

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
  return { roles, warnings };
}
