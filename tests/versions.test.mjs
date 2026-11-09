// The control plane places each runner in its supported window (CTO R13: N-2) by comparing versions, so the server,
// the runner and the kit must carry one version. A release that bumps the root bumps these too, or this fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const v = (p) => JSON.parse(readFileSync(p, 'utf8'));
test('the kit, the server and the runner carry one version (package.json and lock files)', () => {
  const root = v('package.json').version;
  for (const app of ['apps/server', 'apps/runner']) {
    assert.equal(v(`${app}/package.json`).version, root, `${app}/package.json`);
    const lock = v(`${app}/package-lock.json`);
    assert.deepEqual([lock.version, lock.packages[''].version], [root, root], `${app}/package-lock.json`);
  }
});
