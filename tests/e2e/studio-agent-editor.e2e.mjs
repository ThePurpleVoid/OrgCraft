// The custom agent editor in a real browser (PRD 6.6 A2, A3; mockup 02; CPO story criteria 4 to 8, 10, 15, 16): a
// "Contract reviewer" made from Blank for a team that is not about code, every section, the preview on every keystroke,
// one undo per field, the checks, a system connected, a copy that marks what differs, an import that cannot be added
// until it is fixed, and a publish that reopens with the same text.
//
//   node --test tests/e2e/studio-agent-editor.e2e.mjs     # needs the playwright package and a Chromium
//   SCREENSHOTS=docs/product/screenshots/studio-agents node --test tests/e2e/studio-agent-editor.e2e.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  const root = mkdtempSync(join(tmpdir(), 'studio-editor-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Studio test']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'studio-test@example.com']);
  execFileSync(process.execPath, [join(KIT, 'bin/agent-team.mjs'), 'init', '--preset', 'minimal', '--project', 'Sample firm', '--dir', root], { stdio: 'ignore' });
  // One system to connect: a shared drive, known only by name and a secret's name.
  writeFileSync(join(root, '.agent-team/resources.json'), JSON.stringify({ resources: [{ id: 'drive', type: 'mcp', name: 'Shared drive', config: {}, secrets: ['DRIVE_TOKEN'] }], bindings: [] }, null, 2) + '\n');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'team']);
  studio = createStudio({ root, env: {} });
  await new Promise((r) => studio.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${studio.address().port}`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); studio?.closeAllConnections?.(); studio?.close(); });

const preview = (page) => page.locator('#e-preview');
const raw = (page) => page.locator('#e-raw').inputValue();

test('a Contract reviewer from Blank: every section, live preview, undo per field, checks, a system, and the round trip', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await page.locator('.lib-role').first().waitFor();
  await page.getByRole('button', { name: 'New agent' }).click();
  const dlg = page.locator('#agent-dialog');
  await dlg.locator('#a-name').fill('Contract reviewer');
  await dlg.locator('#a-group').selectOption('+');
  await dlg.locator('#a-newgroup').fill('legal');
  await dlg.locator('#a-manager').selectOption('chief-of-staff');
  await dlg.getByRole('button', { name: 'Continue to the brief' }).click();

  // The editor: the sections with their state on the left, the fields, and the file publish writes on the right.
  const ed = page.locator('#agent-editor');
  await ed.getByRole('heading', { name: 'Brief preview' }).waitFor();
  for (const s of ['Identity', 'Place in the team', 'What it owns', 'Tools and systems', 'Wakes on', 'Hands to', 'Rules', 'Sign-off evidence']) await ed.locator('.ed-nav a', { hasText: s }).waitFor();
  await ed.getByText('.agent-team/roles/contract-reviewer.md').waitFor();
  assert.match(await preview(page).textContent(), /^# Contract reviewer$/m);
  assert.equal(await page.locator('.layout').isVisible(), false, 'the editor has the page');

  // Identity: the preview follows every keystroke, and the typing is one undo step.
  const identity = ed.getByLabel('What this agent owns and how it is judged');
  // The template's example text is a hint, not the agent's text, and the checks say it is still there.
  assert.equal(await identity.inputValue(), '');
  assert.match(await identity.getAttribute('placeholder'), /responsible for/);
  await ed.locator('#e-checks li.warning', { hasText: "Identity still has the template's example text" }).waitFor();
  await identity.pressSequentially('You review every contract before it is signed.', { delay: 5 });
  await preview(page).getByText('You review every contract before it is signed.').waitFor();
  assert.match(await preview(page).textContent(), /^## Identity\nYou review every contract before it is signed\.\n\n## Owns/m, 'the section stays in its place');
  assert.equal(await ed.locator('#e-checks li', { hasText: 'example text' }).count(), 2, 'Identity is no longer an example; What it owns and Hands to still are');
  assert.equal(await identity.evaluate((el) => el === document.activeElement), true, 'typing keeps the focus');
  await page.getByRole('button', { name: 'Undo' }).click();
  assert.doesNotMatch(await preview(page).textContent(), /You review every contract/);
  await page.getByRole('button', { name: 'Redo' }).click();
  await preview(page).getByText('You review every contract before it is signed.').waitFor();

  // Place in the team: tier with its cost hint, and on or dormant.
  await ed.getByRole('radio', { name: 'deep' }).click();
  await ed.getByText('about 3× standard per task').waitFor();
  assert.match(await preview(page).textContent(), /^\*\*Model:\*\* deep/m);
  await ed.getByRole('radio', { name: 'Dormant until asked' }).click();
  assert.match(await preview(page).textContent(), /^\*\*Status:\*\* dormant/m);
  await ed.getByRole('radio', { name: 'On', exact: true }).click();
  assert.match(await preview(page).textContent(), /^\*\*Status:\*\* active$/m);
  assert.match(await preview(page).textContent(), /^\*\*Group:\*\* legal$/m);

  // What it owns: an area, written in the brief's Owns section.
  await ed.getByLabel('Area to add').fill('contracts/');
  await ed.getByRole('button', { name: 'Add an area' }).click();
  assert.match(await preview(page).textContent(), /^- `contracts\/`$/m);
  await ed.locator('.ed-nav [data-state="owns"]', { hasText: 'done' }).waitFor();

  // Tools and systems: a tool chip, and the shared drive connected read-only (the same binding as the Systems view).
  await ed.getByLabel('Tool to add').fill('document comparison');
  await ed.getByLabel('Tool to add').press('Enter');
  await ed.locator('.chip', { hasText: 'document comparison' }).waitFor();
  await ed.getByLabel('System to connect').selectOption('drive');
  await ed.getByRole('button', { name: 'Connect' }).click();
  await ed.locator('.ed-systems li', { hasText: 'Shared drive' }).waitFor();
  assert.equal(await ed.locator('.ed-systems select[data-binding]').inputValue(), 'read');
  assert.doesNotMatch(await preview(page).textContent(), /DRIVE_TOKEN=/, 'a secret shows only by name');

  // Wakes on: structured lines; a bad schedule is said and not written.
  await ed.getByLabel('A HANDOFF to this agent').check();
  await ed.getByLabel('An issue or task with a label: label, for example contract-review').fill('contract-review');
  await ed.getByLabel('A schedule: days and time, for example mon-fri 09:30').fill('fri 25:00');
  await ed.locator('#e-wake-problem', { hasText: 'is not a time of day' }).waitFor();
  assert.doesNotMatch(await preview(page).textContent(), /^- schedule:/m);
  await ed.getByLabel('A schedule: days and time, for example mon-fri 09:30').fill('fri 14:00');
  const wakes = await preview(page).textContent();
  assert.match(wakes, /^- handoff$/m);
  assert.match(wakes, /^- issue-label: contract-review$/m);
  assert.match(wakes, /^- schedule: fri 14:00$/m);

  // Hands to with SIGNOFF and no evidence: a warning, which the evidence clears.
  await ed.getByLabel('Role', { exact: true }).selectOption('chief-of-staff');
  await ed.getByLabel('Message', { exact: true }).selectOption('SIGNOFF');
  await ed.locator('#e-hand-add').click();
  assert.match(await preview(page).textContent(), /^## Hands to\nchief-of-staff \(SIGNOFF\)$/m, 'the example text is replaced, not added to');
  await ed.locator('#e-checks li.warning', { hasText: 'sends SIGNOFF but lists no sign-off evidence' }).waitFor();
  await ed.locator('.ed-nav [data-state="evidence"]', { hasText: 'to check' }).waitFor();
  await ed.getByLabel('Evidence to add').fill('the signed document, with the changes marked');
  await ed.getByLabel('Evidence to add').press('Enter');
  assert.match(await preview(page).textContent(), /^## Sign-off evidence\n- the signed document, with the changes marked$/m);
  assert.equal(await ed.locator('#e-checks li.warning', { hasText: 'sign-off evidence' }).count(), 0);
  await ed.locator('#e-checks li.pass', { hasText: 'No secrets in the text' }).waitFor();

  // A secret typed into the brief is an error at once.
  await ed.getByLabel('Rules').fill('- Use ghp_abcdefghijklmnopqrstuvwxyz0123 to reach the drive');
  await ed.locator('#e-checks li.error', { hasText: 'secret' }).waitFor();
  await ed.locator('#e-count.error').waitFor();
  await ed.getByLabel('Rules').fill('- Never sign on the owner\'s behalf');
  await ed.locator('#e-checks li.pass', { hasText: 'No secrets in the text' }).waitFor();

  // Nothing on the way assumed code (criterion 16): no "repository", "CI" or "pull request" outside the PR wake.
  const words = await ed.locator('.ed-form').evaluate((el) => [...el.querySelectorAll('h2, .hint, label, .lbl')].map((x) => x.textContent).join(' '));
  assert.doesNotMatch(words.replace(/A pull request (that changes these areas|with a label)/g, ''), /\b(repository|CI|pull request|merge|branch)\b/i);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'agent-editor-desktop-light.png') });
  if (SHOTS) { await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: join(SHOTS, 'agent-editor-desktop-dark.png') }); await page.emulateMedia({ colorScheme: 'light' }); }

  // Round trip: publish, open the repository again, and the agent has the same text (PRD E7).
  const text = await raw(page);
  await page.getByRole('button', { name: 'Back to the team' }).click();
  await page.getByRole('button', { name: 'Publish…' }).click();
  await page.locator('#branch').fill('team/contract-reviewer');
  await page.getByRole('button', { name: 'Commit to branch' }).click();
  await page.locator('#publish-result', { hasText: /team\/contract-reviewer/ }).waitFor();
  await page.reload();
  await page.locator('#library .lib-role', { hasText: 'Contract reviewer' }).locator('.name').click();
  assert.equal(await raw(page), text);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a copy marks what differs, and an imported agent with an error cannot be added until it is fixed', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?t=${studio.launchToken}`);
  await page.locator('.lib-role').first().waitFor();
  const dlg = page.locator('#agent-dialog');
  const ed = page.locator('#agent-editor');

  await page.getByRole('button', { name: 'New agent' }).click();
  await dlg.getByText('Copy a role').click();
  await dlg.getByLabel('Role to copy').fill('qa web');
  await dlg.locator('#a-copy-list').getByRole('option', { name: /QA web/ }).click();
  await dlg.locator('#a-name').fill('Accessibility auditor');
  await dlg.getByRole('button', { name: 'Continue to the brief' }).click();
  await ed.getByText('Copied from QA web').waitFor();
  const marked = () => preview(page).locator('.diff').allTextContents();
  const first = await marked();
  await ed.getByLabel('What this agent owns and how it is judged').fill('You audit every screen for keyboard paths, contrast and screen-reader names.');
  await preview(page).locator('.diff', { hasText: 'You audit every screen' }).waitFor();
  assert.ok((await marked()).length > first.length, 'the changed line is marked');
  assert.ok(!(await marked()).some((l) => /^## (Tools|Rules)$/.test(l)), 'unchanged headings are not marked');
  await page.getByRole('button', { name: 'Back to the team' }).click();

  // An import with a tier the kit does not know: it arrives off, and "Add to the team" waits for the fix.
  await page.getByRole('button', { name: 'New agent' }).click();
  await dlg.locator('#a-files').setInputFiles([{ name: 'clerk.md', mimeType: 'text/markdown', buffer: Buffer.from('# Clerk\n\n**Model:** turbo\n**Group:** legal\n**Reports to:** chief-of-staff\n**Status:** active\n\n## Identity\nYou file every signed contract.\n\n## Wakes on\n- handoff\n') }]);
  await page.waitForFunction(() => document.querySelector('#a-name').value === 'Clerk');
  await dlg.getByRole('button', { name: 'Add it, switched off' }).click();
  const add = ed.getByRole('button', { name: 'Add to the team' });
  await add.waitFor();
  assert.equal(await add.isDisabled(), true);
  await ed.locator('.ed-nav [data-state="place"]', { hasText: '1 to fix' }).waitFor();
  await ed.locator('#e-checks li.error', { hasText: 'model tier "turbo"' }).waitFor();
  await ed.getByRole('radio', { name: 'routine' }).click();
  assert.equal(await add.isDisabled(), false);
  await add.click();
  await ed.getByRole('button', { name: 'Add to the team' }).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Back to the team' }).click();
  assert.equal(await page.locator('#library .lib-role', { hasText: 'Clerk' }).locator('input[type=checkbox]').isChecked(), true);
  await page.locator('#canvas .node', { hasText: 'Clerk' }).waitFor();
  assert.deepEqual(errors, []);
  await page.close();
});
