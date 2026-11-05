// File-system helpers for the team model, for Node callers (the CLI, the Studio server, tests).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLayerPath } from './index.mjs';

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
  return { roles, presets };
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
