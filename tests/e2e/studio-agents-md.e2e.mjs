// AGENTS.md from the Studio (CPO story "other coding agents", criteria 6 and 8; D45, D46): the team settings switch
// puts AGENTS.md in the publish diff and the commit, and a role that reports with no hook events reads
// "self-reported" on its card.
//
//   node --test tests/e2e/studio-agents-md.e2e.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { KIT } from '../../bin/agent-team.mjs';
import { createStudio } from '../../apps/studio/server.mjs';
import { context } from '../../tools/report.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* reported by the skip below */ }
if (!chromium && process.env.CI) throw new Error('CI is set but the playwright package is not installed');
const skip = !chromium && 'the playwright package is not installed';

let studio, root, base, browser;
before(async () => {
  if (skip) return;
  root = mkdtempSync(join(tmpdir(), 'studio-agents-md-'));
  const home = mkdtempSync(join(tmpdir(), 'studio-agents-md-home-'));
  const git = (...a) => execFileSync('git', ['-C', root, ...a]);
  git('init', '-q');
  git('config', 'user.name', 'Studio test');
  git('config', 'user.email', 'studio-test@example.com');
  git('config', 'commit.gpgsign', 'false');
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Sample app', '--dir', root], { stdio: 'ignore' });
  // The repository's own AGENTS.md: its text must survive (D45).
  writeFileSync(join(root, 'AGENTS.md'), '# Sample app\n\nRun the tests with npm test.\n');
  git('add', '-A');
  git('commit', '-qm', 'team');
  const env = { AGENT_TEAM_HOME: home };
  // web-dev reports for itself (no hook events): another coding agent.
  const { log } = context(env, root);
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, JSON.stringify({ id: 'e2e-1', kind: 'status', at: new Date(Date.now() - 5 * 60_000).toISOString(), role: 'web-dev', status: 'working', task: 'Add a footer' }) + '\n');
  studio = createStudio({ root, env });
  await new Promise((r) => studio.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${studio.address().port}`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); studio?.closeAllConnections?.(); studio?.close(); });

test('the AGENTS.md switch publishes AGENTS.md and keeps the repository\'s own text; self-reported cards', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?t=${studio.launchToken}`);
  // Criterion 6: the card of a role with reports and no hook events.
  await page.locator('#canvas .node[data-slug="web-dev"]', { hasText: 'self-reported' }).waitFor();

  // Criterion 8: the switch, in the team settings (no role picked).
  const sw = page.getByLabel('Also keep an AGENTS.md file, for AI coding tools other than Claude Code');
  assert.equal(await sw.isChecked(), false);
  await sw.check();
  await page.locator('#publish').click();
  await page.locator('#files > summary').click();
  await page.locator('#changes summary', { hasText: 'AGENTS.md' }).first().waitFor();
  await page.locator('#branch').fill('agents-md');
  await page.locator('#confirm').click();
  await page.locator('#publish-result', { hasText: 'Committed' }).waitFor();
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /^# Sample app\n\nRun the tests with npm test\./, 'the repository\'s own text stays');
  assert.match(agents, /<!-- agent-team:start/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.agent-team/team.json'), 'utf8')).targets, ['claude-code', 'agents-md']);
  assert.equal(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }), '', 'AGENTS.md and the .gitignore line are committed');

  // Off again: the kit's block goes, the repository's text stays, and team.json loses the key.
  await page.locator('#publish-dialog').getByRole('button', { name: 'Keep editing' }).click();
  await page.locator('#canvas').click({ position: { x: 5, y: 5 } });
  await page.getByLabel('Also keep an AGENTS.md file, for AI coding tools other than Claude Code').uncheck();
  await page.locator('#publish').click();
  await page.locator('#files > summary').click();
  await page.locator('#changes summary', { hasText: 'AGENTS.md' }).first().waitFor();
  // The review shows what sync does: the kit's block goes, the owner's text stays (QA of #119).
  assert.equal(await page.locator('#changes summary', { hasText: /^changedAGENTS\.md$/ }).count(), 1);
  await page.locator('#confirm').click();
  await page.locator('#publish-result', { hasText: 'Committed' }).waitFor();
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), '# Sample app\n\nRun the tests with npm test.\n');
  assert.equal(JSON.parse(readFileSync(join(root, '.agent-team/team.json'), 'utf8')).targets, undefined);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a kit-made AGENTS.md: the review shows only real changes, switching off commits the deletion, and the team settings come back (QA of #119)', { skip }, async () => {
  const { unlinkSync } = await import('node:fs');
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('checkout', '-q', '-b', 'kit-made');
  unlinkSync(join(root, 'AGENTS.md'));
  git('commit', '-qam', 'no AGENTS.md of its own');
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await page.locator('.lib-role').first().waitFor();
  const label = 'Also keep an AGENTS.md file, for AI coding tools other than Claude Code';

  // A role picked, then back to the team settings: Escape, and a click on the owner.
  await page.locator('#canvas .node[data-slug="web-dev"]').click();
  assert.equal(await page.getByLabel(label).count(), 0);
  await page.keyboard.press('Escape');
  await page.getByLabel(label).waitFor();
  await page.locator('#canvas .node[data-slug="web-dev"]').click();
  await page.locator('#canvas .node[data-slug="owner"]').click();
  await page.getByLabel(label).check();
  await page.locator('#publish').click();
  await page.locator('#files > summary').click();
  await page.locator('#changes summary', { hasText: 'AGENTS.md' }).first().waitFor();
  await page.locator('#confirm').click();
  await page.locator('#publish-result', { hasText: 'Committed' }).waitFor();
  await page.locator('#publish-dialog').getByRole('button', { name: 'Keep editing' }).click();
  // Nothing left to publish: the review reads the repository's AGENTS.md, so it is not shown as changed.
  await page.locator('#publish', { hasText: 'Nothing to publish' }).waitFor();
  assert.equal(await page.locator('#publish').isDisabled(), true);

  // Off: the kit made the file, so it goes, and the deletion is committed.
  await page.getByLabel(label).uncheck();
  await page.locator('#publish').click();
  await page.locator('#files > summary').click();
  await page.locator('#changes summary', { hasText: 'AGENTS.md' }).first().waitFor();
  await page.locator('#confirm').click();
  await page.locator('#publish-result', { hasText: 'Committed' }).waitFor();
  assert.equal(git('status', '--porcelain'), '', 'the deletion is committed');
  assert.throws(() => git('show', 'HEAD:AGENTS.md'));
  assert.deepEqual(errors, []);
  await page.close();
});
