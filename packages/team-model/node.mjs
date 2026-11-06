// File-system helpers for the team model, for Node callers (the CLI, the Studio server, tests).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACK_DOCS, isLayerPath } from './index.mjs';

export const KIT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LAYER = '.agent-team';

/** The kit's role library and presets, as the pure functions in index.mjs take them. */
export function loadKit(kitDir = KIT_DIR) {
  const rolesDir = join(kitDir, 'team/roles');
  const roles = {};
  for (const f of readdirSync(rolesDir).filter((x) => x.endsWith('.md') && !x.startsWith('_')).sort()) roles[f.slice(0, -3)] = readFileSync(join(rolesDir, f), 'utf8');
  const presets = {};
  for (const f of readdirSync(join(kitDir, 'presets')).filter((x) => x.endsWith('.txt'))) {
    const slugs = readFileSync(join(kitDir, 'presets', f), 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
    presets[f.slice(0, -4)] = slugs[0] === '*' ? Object.keys(roles) : slugs;
  }
  const template = existsSync(join(rolesDir, '_template.md')) ? readFileSync(join(rolesDir, '_template.md'), 'utf8') : undefined;
  // The protocol core and its packs (kit 0.13): team/<doc> and team/packs/<pack>/<doc>.
  const docs = {};
  for (const f of PACK_DOCS) if (existsSync(join(kitDir, 'team', f))) docs[f] = readFileSync(join(kitDir, 'team', f), 'utf8');
  const packs = {};
  const packsDir = join(kitDir, 'team/packs');
  if (existsSync(packsDir)) for (const p of readdirSync(packsDir).filter((x) => existsSync(join(packsDir, x, 'protocols.md')) || existsSync(join(packsDir, x, 'project-instructions.md'))).sort()) {
    packs[p] = {};
    for (const f of PACK_DOCS) if (existsSync(join(packsDir, p, f))) packs[p][f] = readFileSync(join(packsDir, p, f), 'utf8');
  }
  return { roles, presets, template, docs, packs };
}

/** The layer files a TeamSpec is made from, as relative path → content. */
export function readLayer(root) {
  const dir = join(root, LAYER);
  const files = {};
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else if (isLayerPath(p)) files[p] = readFileSync(join(dir, p), 'utf8');
    }
  };
  if (existsSync(dir)) walk('');
  return files;
}

/** Writes a compiled layer. Layer files the new layer no longer has are removed; nothing else in .agent-team/ is touched. */
export function writeLayer(root, files) {
  const before = readLayer(root);
  const changed = [];
  for (const p of Object.keys(before)) if (!(p in files)) { rmSync(join(root, LAYER, p)); changed.push(`removed ${LAYER}/${p}`); }
  for (const [p, content] of Object.entries(files)) {
    if (before[p] === content) continue;
    mkdirSync(dirname(join(root, LAYER, p)), { recursive: true });
    writeFileSync(join(root, LAYER, p), content);
    changed.push(`${p in before ? 'updated' : 'wrote'} ${LAYER}/${p}`);
  }
  return changed;
}

/** One template folder (team/templates/<id>/) as the files the pure template functions take. */
export function readTemplateDir(dir) {
  const files = {};
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else if (p === 'template.json' || /^roles\/[^/]+\.(md|json)$/.test(p)) files[p] = readFileSync(join(dir, p), 'utf8');
    }
  };
  walk('');
  return files;
}

/** The kit's team templates: { <id>: files }, in id order. */
export function loadTemplates(kitDir = KIT_DIR) {
  const root = join(kitDir, 'team/templates');
  if (!existsSync(root)) return {};
  const out = {};
  for (const id of readdirSync(root).sort()) if (existsSync(join(root, id, 'template.json'))) out[id] = readTemplateDir(join(root, id));
  return out;
}
