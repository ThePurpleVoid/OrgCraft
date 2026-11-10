// The runner image copies only some of the kit (apps/runner/Dockerfile COPY lines). Every file the runner's code can
// import must be in that set, or the runner breaks only inside the image (code review L22mx: packages/calls/money.mjs
// re-exports apps/studio/public/money.mjs, which the image does not copy, so the runner must never import it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The kit paths the image copies, as prefixes ("packages/calls/", "apps/runner/"). */
function copied(dockerfile) {
  return readFileSync(join(KIT, dockerfile), 'utf8').split('\n').filter((l) => /^COPY\s/.test(l) && !/--from=/.test(l))
    .flatMap((l) => l.trim().split(/\s+/).slice(1, -1)).map((p) => p.replace(/^\.\//, ''));
}

/** Every kit file reachable by relative imports (static and literal dynamic) from these entry files. */
function reachable(entries) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const [, spec] of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      const to = resolve(dirname(file), spec);
      if (existsSync(to) && statSync(to).isFile()) walk(to);
    }
  };
  for (const e of entries) walk(e);
  return [...seen].map((f) => relative(KIT, f));
}

test('the runner image copies every file the runner can import', () => {
  const have = copied('apps/runner/Dockerfile');
  const dir = join(KIT, 'apps/runner');
  const entries = readdirSync(dir).filter((f) => f.endsWith('.mjs')).map((f) => join(dir, f));
  const missing = reachable(entries).filter((f) => !have.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));
  assert.deepEqual(missing, [], 'add these to apps/runner/Dockerfile, or do not import them from the runner');
});
