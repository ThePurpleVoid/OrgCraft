// The repository never tracks node_modules (a committed symlink points at
// one person's machine and breaks every other checkout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('no tracked path is or sits inside node_modules', () => {
  let files;
  try {
    files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0');
  } catch {
    return; // not a git checkout (an npm tarball): nothing to check
  }
  const bad = files.filter((f) => f.split('/').includes('node_modules'));
  assert.deepEqual(bad, [], `tracked node_modules paths: ${bad.join(', ')}`);
});
