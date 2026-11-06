// New agent in a real browser (PRD 6.6 A1, A5, A6; mockup 01): start blank with a group of its own, copy a role, take
// a kit role's slug only by choosing to replace it, import a role pack (added switched off) and refuse one with a
// secret in it; Your agents in the library; and the file publish would write.
//
//   node --test tests/e2e/studio-agents.e2e.mjs     # needs the playwright package and a Chromium
//   SCREENSHOTS=docs/product/screenshots/studio-agents node --test tests/e2e/studio-agents.e2e.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT } from '../../bin/agent-team.mjs';
import { createStudio } from '../../apps/studio/server.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* reported by the skip below */ }
if (!chromium && process.env.CI) throw new Error('CI is set but the playwright package is not installed');
const skip = !chromium && 'the playwright package is not installed';
const SHOTS = process.env.SCREENSHOTS;

let studio, base, browser;
before(async () => {
  if (skip) return;
  const root = mkdtempSync(join(tmpdir(), 'studio-agents-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Sample app', '--dir', root], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'team']);
  studio = createStudio({ root, env: {} });
  await new Promise((r) => studio.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${studio.address().port}`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); studio?.closeAllConnections?.(); studio?.close(); });

const brief = (title, slug, extra = '', tier = 'standard') => `# ${title}\n\n**Model:** ${tier}\n**Group:** localization\n**Reports to:** cto\n**Status:** active\n\n## Identity\nYou keep every string translated.${extra}\n\n## Owns (writes)\n- \`locales/${slug}/\`\n\n## Every thread, every task\n- \`scripts/agent-team/team-status.sh ${slug} status working --task "<task>"\`\n`;
const file = (name, text) => ({ name, mimeType: name.endsWith('.json') ? 'application/json' : 'text/markdown', buffer: Buffer.from(text) });

test('new agents: blank in a new group, a copy, a kit slug only by replacing, a pack switched off, and a secret refused', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await page.locator('.lib-role').first().waitFor();
  const dlg = page.locator('#agent-dialog');

  // Blank, with a group the kit does not have.
  await page.getByRole('button', { name: 'New agent' }).click();
  await dlg.getByLabel('Name', { exact: true }).fill('Accessibility auditor');
  assert.equal(await dlg.getByLabel('Slug (file name and board name)').inputValue(), 'accessibility-auditor');
  await dlg.locator('.check-line.ok', { hasText: 'The slug is free' }).waitFor();
  await dlg.getByText('.agent-team/roles/accessibility-auditor.md').waitFor();
  await dlg.locator('#a-group').selectOption('+');
  await dlg.getByLabel('New group name').fill('accessibility');
  await dlg.locator('#a-manager').selectOption('cto');
  await dlg.getByRole('button', { name: 'Continue to the brief' }).click();
  assert.equal(await dlg.isVisible(), false);

  // Under Your agents, switched on, selected, and its brief is the kit's template with the choices made.
  const yours = page.locator('#library .lib-role', { hasText: 'Accessibility auditor' });
  await yours.waitFor();
  assert.equal(await yours.locator('input[type=checkbox]').isChecked(), true);
  assert.match(await yours.locator('.tag').textContent(), /custom/);
  assert.equal(await page.locator('#library .group-title').first().textContent(), 'Your agents');
  const md = await page.locator('#i-brief').inputValue();
  assert.match(md, /^# Accessibility auditor$/m);
  assert.match(md, /^\*\*Group:\*\* accessibility$/m);
  assert.match(md, /^\*\*Reports to:\*\* cto$/m);
  assert.match(md, /^\*\*Status:\*\* active$/m);
  assert.match(md, /team-status\.sh accessibility-auditor status/);
  await page.locator('#canvas .node', { hasText: 'Accessibility auditor' }).waitFor();

  // A copy of a role: a separate agent, the original untouched. A kit role's slug needs "replace".
  await page.getByRole('button', { name: 'New agent' }).click();
  await dlg.getByText('Copy a role').click();
  await dlg.getByLabel('Role to copy').fill('qa');
  await dlg.locator('#a-copy-list').getByRole('option', { name: /QA web/ }).click();
  await dlg.getByLabel('Name', { exact: true }).fill('Release manager');
  await dlg.locator('.check-line.bad', { hasText: 'The kit has a role called release-manager' }).waitFor();
  assert.equal(await dlg.getByRole('button', { name: 'Continue to the brief' }).isDisabled(), true);
  await dlg.getByLabel(/Replace the kit's role/).check();
  await dlg.locator('.check-line.ok', { hasText: 'This replaces the kit' }).waitFor();
  await dlg.getByLabel('Slug (file name and board name)').fill('qa-a11y');
  assert.equal(await dlg.getByLabel(/Replace the kit's role/).isVisible(), false);
  await dlg.getByLabel('Name', { exact: true }).fill('QA accessibility');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'new-agent-copy-desktop-light.png') });
  await dlg.getByRole('button', { name: 'Continue to the brief' }).click();
  const copy = await page.locator('#i-brief').inputValue();
  assert.match(copy, /^# QA accessibility$/m);
  assert.match(copy, /team-status\.sh qa-a11y status/);
  assert.doesNotMatch(copy, /team-status\.sh qa-web /);
  assert.equal(await page.locator('#library .lib-role[data-slug="qa-web"] input').isChecked(), true, 'the role copied is still on');

  // A role pack: two agents, added switched off and tagged imported. One has a model tier the kit does not know, so it
  // cannot be switched on until that is fixed; the other can.
  await page.getByRole('button', { name: 'New agent' }).click();
  await dlg.locator('#a-files').setInputFiles([
    file('pack.json', JSON.stringify({ schema: 'agent-team/role-pack@1', roles: ['localization-lead', 'translator'], needs: {} })),
    file('localization-lead.md', brief('Localization lead', 'localization-lead', '', 'turbo')),
    file('translator.md', brief('Translator', 'translator')),
  ]);
  await dlg.getByText('2 agents in this pack').waitFor();
  await dlg.getByRole('button', { name: 'Add them, switched off' }).click();
  for (const name of ['Localization lead', 'Translator']) {
    const row = page.locator('#library .lib-role', { hasText: name });
    await row.waitFor();
    assert.equal(await row.locator('input[type=checkbox]').isChecked(), false, `${name} is off`);
    assert.match(await row.locator('.tag').textContent(), /imported/);
  }
  await page.locator('#library .lib-role', { hasText: 'Localization lead' }).locator('input[type=checkbox]').click();
  await page.locator('#checks', { hasText: 'cannot be switched on yet' }).waitFor();
  assert.equal(await page.locator('#library .lib-role', { hasText: 'Localization lead' }).locator('input[type=checkbox]').isChecked(), false);
  await page.locator('#library .lib-role', { hasText: 'Translator' }).locator('input[type=checkbox]').check();
  await page.locator('#canvas .node', { hasText: 'Translator' }).waitFor();

  // Export as a role pack: the brief and pack.json, names and paths only (here the browser has no folder picker, so both download).
  const downloads = [];
  page.on('download', (d) => downloads.push(d));
  await page.evaluate(() => { delete window.showDirectoryPicker; });
  await page.getByRole('button', { name: 'Export Translator as a role pack' }).click();
  await page.locator('#checks', { hasText: 'Downloaded translator.md and pack.json' }).waitFor();
  assert.deepEqual(downloads.map((d) => d.suggestedFilename()).sort(), ['pack.json', 'translator.md']);
  const pack = JSON.parse(await readFile(await downloads.find((d) => d.suggestedFilename() === 'pack.json').path(), 'utf8'));
  assert.equal(pack.schema, 'agent-team/role-pack@1');
  assert.deepEqual(pack.roles, ['translator']);
  assert.deepEqual(pack.needs.paths, ['locales/translator/']);
  assert.deepEqual(pack.needs.resources, []);

  // One file: added switched off too. One with a secret in it is refused before it is added.
  await page.getByRole('button', { name: 'New agent' }).click();
  await dlg.locator('#a-files').setInputFiles([file('glossary-keeper.md', brief('Glossary keeper', 'glossary-keeper'))]);
  await page.waitForFunction(() => document.querySelector('#a-name').value === 'Glossary keeper'); // filled from the file's title
  await dlg.getByText('An imported agent is added switched off').waitFor();
  await dlg.getByRole('button', { name: 'Add it, switched off' }).click();
  assert.equal(await page.locator('#library .lib-role', { hasText: 'Glossary keeper' }).locator('input[type=checkbox]').isChecked(), false);

  await page.getByRole('button', { name: 'New agent' }).click();
  await dlg.locator('#a-files').setInputFiles([file('leaky.md', brief('Leaky', 'leaky', ' Use ghp_abcdefghijklmnopqrstuvwxyz0123 to push.'))])
  await dlg.locator('.result.error', { hasText: 'secret' }).waitFor();
  assert.equal(await dlg.getByRole('button', { name: 'Add it, switched off' }).isDisabled(), true);
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await page.locator('#library .lib-role', { hasText: 'Leaky' }).count(), 0);

  // Publish writes every agent's file, and lists the ones that are off in exclude.
  await page.getByRole('button', { name: 'Publish…' }).click();
  const changes = page.locator('#changes');
  for (const p of ['.agent-team/roles/accessibility-auditor.md', '.agent-team/roles/qa-a11y.md', '.agent-team/roles/translator.md', '.agent-team/roles/localization-lead.md', '.agent-team/team.json']) await changes.locator('summary', { hasText: p }).first().waitFor();
  await changes.locator('summary', { hasText: '.agent-team/team.json' }).click();
  await changes.locator('pre', { hasText: '"localization-lead"' }).waitFor();
  // Commit it, then open the repository again: the same agents, with the same text (PRD E7).
  const before = Object.fromEntries(await Promise.all(['accessibility-auditor', 'qa-a11y', 'translator'].map(async (s) => [s, await page.evaluate(async (slug) => (await (await fetch('/v1/team')).json()).spec.roles[slug] ?? null, s)])));
  assert.deepEqual(before, { 'accessibility-auditor': null, 'qa-a11y': null, translator: null }, 'nothing is written before publish');
  await page.locator('#branch').fill('team/new-agents');
  await page.getByRole('button', { name: 'Commit to branch' }).click();
  await page.locator('#publish-result', { hasText: /team\/new-agents/ }).waitFor();
  await page.keyboard.press('Escape');
  await page.reload();
  await page.locator('#library .lib-role', { hasText: 'QA accessibility' }).waitFor();
  assert.equal(await page.locator('#library .lib-role', { hasText: 'Translator' }).locator('input[type=checkbox]').isChecked(), true);
  assert.equal(await page.locator('#library .lib-role', { hasText: 'Localization lead' }).locator('input[type=checkbox]').isChecked(), false);
  assert.match(await page.locator('#library .lib-role', { hasText: 'Translator' }).locator('.tag').textContent(), /custom/);
  if (SHOTS) {
    await page.getByRole('button', { name: 'New agent' }).click();
    await dlg.getByText('Copy a role').click();
    await dlg.getByLabel('Role to copy').fill('back');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: join(SHOTS, 'new-agent-desktop-dark.png') });
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await page.locator('#library .lib-role', { hasText: 'Accessibility auditor' }).click();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.screenshot({ path: join(SHOTS, 'your-agents-desktop-light.png') });
  }
  assert.deepEqual(errors, []);
  await page.close();
});

test('at 390px there is no New agent button, and an agent says to edit it on a larger screen', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: SHOTS ? 2 : 1 });
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await page.locator('.lib-role').first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'New agent' }).isVisible(), false);
  // Your agents is a list on a phone (CPO story D9): it reads, and the agent says where to edit it.
  await page.locator('#library .group-title', { hasText: 'Your agents' }).waitFor();
  await page.locator('#library .lib-role', { hasText: 'Accessibility auditor' }).waitFor();
  await page.locator('#canvas .node', { hasText: 'Accessibility auditor' }).click();
  await page.getByText('Open the Studio on a larger screen to edit this agent.').waitFor();
  assert.equal(await page.locator('#i-brief').count(), 0);
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(w <= 390, `no sideways scroll (${w}px)`);
  await page.getByText('Open the Studio on a larger screen to edit this agent.').scrollIntoViewIfNeeded();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'your-agents-phone-light.png') });
  await page.close();
});
