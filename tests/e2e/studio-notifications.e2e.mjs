// The Notifications page of a hosted Studio in a real browser (CPO story "email notifications", opt-in copy, D49):
// /teams/{team}/notifications signs the person in first, an address gets a code and is verified, the suggested kinds
// are ticked but nothing is saved until Save, switches save at once after that, and a code that is wrong or could not
// be sent says so. Against the stub issuer, whose emails API follows apps/server (kit #101). Desktop and 360px.
//
//   node --test tests/e2e/studio-notifications.e2e.mjs
//   SCREENSHOTS=docs/product/screenshots/notifications node --test tests/e2e/studio-notifications.e2e.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { stubIssuer } from '../fixtures/stub-issuer.mjs';
import { channelError, channelName, emailsHtml, logHtml, prefsHtml, shownKinds, teamFromPath } from '../../apps/studio/public/notifications.js';
import { linkError } from '../../apps/studio/public/slack-callback.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* reported by the skip below */ }
if (!chromium && process.env.CI) throw new Error('CI is set but the playwright package is not installed');
const skip = !chromium && 'the playwright package is not installed';
const SHOTS = process.env.SCREENSHOTS;

let iss, browser;
before(async () => {
  if (skip) return;
  iss = await stubIssuer();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); iss?.close(); });

test('the team comes from the path, and nothing else passes', () => {
  assert.equal(teamFromPath('/teams/sample-app/notifications'), 'sample-app');
  assert.equal(teamFromPath('/teams/sample-app/notifications/'), 'sample-app');
  for (const p of ['/teams//notifications', '/teams/a%2Fb/notifications', '/teams/x/inbox', '/notifications', '/teams/%E0%A4%A/notifications']) assert.equal(teamFromPath(p), null, p);
});

test('a channel name is cleaned the way Slack writes it, and channel and link errors read as sentences', () => {
  assert.equal(channelName(' #Team Updates '), 'team-updates');
  assert.equal(channelName('ops.alerts_2'), 'ops.alerts_2');
  for (const bad of ['', '#', '-x', 'team updates!', 'a'.repeat(81)]) assert.equal(channelName(bad), null, bad);
  assert.equal(channelError(409, 'this channel is already picked; change its kinds instead'), 'That channel is already added. Change its switches below instead.');
  assert.match(channelError(400, 'send { channel, name } with…'), /^Check the channel ID/);
  assert.equal(channelError(409, "Slack isn't connected for this team yet"), "Slack isn't connected for this team yet.");
  assert.equal(linkError(409, 'sign in to the Acme Slack workspace, the one this team is connected to'), 'Sign in to the Acme Slack workspace, the one this team is connected to.');
});

test('suggested kinds show only until something is saved, and never after every kind is switched off', () => {
  const kinds = [{ id: 'approval', suggested: true }, { id: 'budget80' }, { id: 'budget100', suggested: true }];
  assert.deepEqual([...shownKinds({ kinds: [] }, kinds)], ['approval', 'budget100']);
  assert.deepEqual([...shownKinds({ kinds: ['budget80'] }, kinds)], ['budget80']);
  assert.deepEqual([...shownKinds({ kinds: [] }, kinds, true)], []);
  const html = emailsHtml({ kinds: [{ id: 'approval', label: 'Approval needed' }], emails: [{ id: 'eml_1', email: 'a@<b>.io', verified: true, kinds: [] }], notes: new Map() });
  assert.match(html, /a@&lt;b&gt;\.io/);
  assert.match(html, /data-save="eml_1"/);
});

test('verify an address, save the suggested kinds, switch one more on, and remove it', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());

  // Signed out: sign-in first, then back to the page the email linked to.
  await page.goto(`${iss.origin}/teams/sample-app/notifications`);
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  await page.getByRole('heading', { name: 'Emails' }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/teams/sample-app/notifications');
  await page.getByText('For Sample app. Only you see these settings.').waitFor();
  await page.getByText('Get an email when something needs you. Nothing is sent until you verify your address and choose what you want.').waitFor();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'emails-empty-light.png') });

  await page.getByLabel('Your email address').fill('Dana@Example.com');
  await page.getByRole('button', { name: 'Send a code' }).click();
  await page.getByText('We sent a code to dana@example.com. It expires in 15 minutes.').waitFor();
  const { code } = iss.codes.at(-1);
  assert.equal(iss.codes.at(-1).email, 'dana@example.com');

  // A wrong code says so, and the right one verifies.
  await page.getByLabel('Code').fill(code === '000000' ? '111111' : '000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.getByRole('alert').getByText('That code is not right. Check the latest email and try again.').waitFor();
  await page.getByLabel('Code').fill(code);
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.getByText('Verified. Choose what to email you about:').waitFor();

  // D49: the suggested two are ticked, but nothing is saved until Save.
  const box = (label) => page.locator('section[aria-labelledby="emails-title"]').getByLabel(label, { exact: true });
  for (const [label, on] of [['Approval needed', true], ['Budget at 80%', false], ['Budget at 100%', true], ['A role is blocked', false], ['Meeting minutes', false]]) assert.equal(await box(label).isChecked(), on, label);
  await page.getByText('The email links to the Studio. You always approve there, never by replying.').waitFor();
  assert.deepEqual(iss.emails[0].kinds, [], 'nothing saved yet');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'emails-verified-light.png') });
  await box('Meeting minutes').check();
  assert.deepEqual(iss.emails[0].kinds, [], 'a tick waits for Save the first time');
  await page.locator('section[aria-labelledby="emails-title"]').getByRole('button', { name: 'Save' }).click();
  await page.getByText('Saved. You will get these emails.').waitFor();
  assert.deepEqual(iss.emails[0].kinds, ['approval', 'budget100', 'minutes']);

  // After that each switch saves at once.
  await box('A role is blocked').check();
  await page.locator('section[aria-labelledby="emails-title"]').getByText('Saved.', { exact: true }).waitFor();
  assert.deepEqual(iss.emails[0].kinds.sort(), ['approval', 'blocked', 'budget100', 'minutes']);
  for (const l of ['Approval needed', 'Budget at 100%', 'A role is blocked', 'Meeting minutes']) await box(l).uncheck();
  await page.getByText('Saved. Nothing is emailed to this address now; it stays verified.').waitFor();
  assert.deepEqual(iss.emails[0].kinds, []);
  assert.equal(await page.locator('section[aria-labelledby="emails-title"]').getByRole('button', { name: 'Save' }).count(), 0, 'no suggestions after every kind was switched off');
  await page.reload();
  await page.getByText('Verified. Choose what to email you about:').waitFor();

  // A second address, then removing the first.
  await page.getByRole('button', { name: 'Add another address' }).click();
  await page.getByLabel('Your email address').fill('dana@work.example');
  await page.getByRole('button', { name: 'Send a code' }).click();
  await page.getByText('We sent a code to dana@work.example.').waitFor();
  await page.locator('.n-address', { hasText: 'dana@example.com' }).getByRole('button', { name: 'Remove' }).click();
  await page.locator('.n-address', { hasText: 'dana@example.com' }).waitFor({ state: 'detached' });
  assert.deepEqual(iss.emails.map((e) => e.email), ['dana@work.example']);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('when the team cannot send yet, the page says who sets it up and offers no code; at 360px nothing scrolls sideways', { skip }, async () => {
  iss.mail.sink = false;
  const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: SHOTS ? 3 : 1 });
  const page = await ctx.newPage();
  await page.goto(`${iss.origin}/teams/sample-app/notifications`);
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  await page.getByRole('heading', { name: 'Emails' }).waitFor();
  // octo is an owner of the workspace.
  await page.getByText("Emails aren't set up for this team yet. An owner connects an email provider in Systems.").waitFor();
  assert.equal(await page.getByRole('button', { name: 'Send a code' }).isDisabled(), true);
  assert.equal(await page.getByText('We sent a code').count(), 0, 'no code form while nothing can be sent');
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(w <= 360, `no sideways scroll (${w}px)`);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'emails-not-set-up-phone-light.png') });
  // A team the person is not on.
  await page.goto(`${iss.origin}/teams/other-team/notifications`);
  await page.getByText('There is no team called other-team here, or you are not on it.').waitFor();
  iss.mail.sink = true;
  await ctx.close();
});

test('a member who is not an owner is told to ask one', () => {
  const html = emailsHtml({ ready: false, owner: false, kinds: [], emails: [], notes: new Map() });
  assert.match(html, /Emails aren't set up for this team yet\. Ask an owner to connect one\./);
  assert.doesNotMatch(html, /id="email-add"/);
});

// ------------------------------------------------------------------------------------------------ Slack

test('Slack: the callback reads what Slack sent back, and says what to do when it cannot link', async () => {
  const { callbackOf, linkError } = await import('../../apps/studio/public/slack-callback.js');
  assert.deepEqual(callbackOf('?code=abc&state=sls_1', 'sample-app'), { team: 'sample-app', code: 'abc', state: 'sls_1' });
  assert.match(callbackOf('?error=access_denied&state=x', 'sample-app').error, /You cancelled the sign-in with Slack/);
  assert.match(callbackOf('?code=abc&state=x', null).error, /does not know which team/);
  assert.match(callbackOf('?code=abc&state=x', '../evil').error, /does not know which team/);
  assert.match(callbackOf('?state=x', 'sample-app').error, /did not send back/);
  assert.match(linkError(410), /more than 10 minutes/);
  assert.match(linkError(400), /started somewhere else/);
  assert.match(linkError(400, 'this sign-in with Slack was not started here; start again'), /started somewhere else/);
  assert.equal(linkError(400, 'send { code, state } from Slack'), 'Send { code, state } from Slack.');
  const { slackSignInUrl, slackHealth, slackHtml } = await import('../../apps/studio/public/notifications.js');
  assert.equal(slackSignInUrl('https://slack.com/openid/connect/authorize?x=1'), 'https://slack.com/openid/connect/authorize?x=1');
  for (const bad of ['http://slack.com/x', 'https://slack.com.evil.example/x', 'javascript:alert(1)', 'https://evil.example/slack.com']) assert.equal(slackSignInUrl(bad), null, bad);
  assert.equal(slackHealth({ status: 'failing', since: '2026-11-06T10:00:00Z' }, () => '10:00'), 'Slack · failing since 10:00, sending by email instead');
  assert.equal(slackHealth({ status: 'working' }), 'Slack · working');
  const member = slackHtml({ slack: { connected: false }, owner: false, notes: new Map() });
  assert.match(member, /Slack isn't connected for this team yet\. Ask an owner to add it\./);
  assert.doesNotMatch(member, /Add to Slack/);
  const owner = slackHtml({ slack: { connected: false }, owner: true, notes: new Map(), redirectUrl: 'https://studio.example/slack/callback' });
  assert.match(owner, /Connect your Slack workspace so the team can message you there\./);
  assert.match(owner, /Add to Slack/);
  assert.match(owner, /https:\/\/studio\.example\/slack\/callback/);
});

test('Slack: connect by signing in to Slack, save the suggested DMs, pick a channel, and disconnect', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  // "Slack": signs octo in at once and sends the browser back to the Studio's callback with a code and the state.
  let asked = null;
  await page.route('https://slack.com/**', (route) => {
    asked = new URL(route.request().url());
    return route.fulfill({ status: 302, headers: { location: `${asked.searchParams.get('redirect_uri')}?code=slack-code-1&state=${encodeURIComponent(asked.searchParams.get('state'))}` } });
  });
  await page.goto(`${iss.origin}/teams/sample-app/notifications`);
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  const slack = page.locator('section[aria-labelledby="slack-title"]');
  await slack.getByRole('heading', { name: 'Slack' }).waitFor();
  await slack.getByText('Slack · working').waitFor();
  await slack.getByText('Get messages as a Slack DM.').waitFor();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'slack-not-linked-light.png'), fullPage: true });

  await slack.getByRole('button', { name: 'Connect Slack' }).click();
  await slack.getByText('Connected as @octo.cat. Choose what to get in Slack, then save.').waitFor();
  assert.equal(new URL(page.url()).pathname, '/teams/sample-app/notifications');
  assert.equal(asked.searchParams.get('scope'), 'openid profile', 'identity only (D56)');
  assert.equal(asked.searchParams.get('redirect_uri'), `${iss.origin}/slack/callback`);
  assert.equal(iss.slack.states.size, 0, 'the state was used once');
  // As for email (D49): the suggested two are ticked, nothing is saved until Save.
  const box = (label) => slack.locator('.n-slack-me').getByLabel(label, { exact: true });
  for (const [label, on] of [['Approval needed', true], ['Budget at 80%', false], ['Budget at 100%', true], ['A role is blocked', false], ['Meeting minutes', false]]) assert.equal(await box(label).isChecked(), on, label);
  await slack.getByText('The message links to the Studio. You always approve there, never in Slack.').waitFor();
  // Ready to try (CPO, #143): its hint, and off to start with.
  await slack.locator('.n-slack-me').getByText('When something the team built is ready for you to look at.').waitFor();
  assert.equal(await box('Ready to try').isChecked(), false);
  const link = () => iss.slack.links.get('sample-app:per_octo');
  assert.deepEqual(link().kinds, []);
  await slack.getByRole('button', { name: 'Save' }).click();
  await slack.getByText('Saved. You will get these Slack messages.').waitFor();
  assert.deepEqual(link().kinds, ['approval', 'budget100']);
  await box('Meeting minutes').check();
  await slack.locator('.n-slack-me').getByText('Saved.', { exact: true }).waitFor();
  assert.deepEqual(link().kinds.sort(), ['approval', 'budget100', 'minutes']);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'slack-linked-light.png'), fullPage: true });

  // Team channels (owners and admins): budget and minutes start on, approval and BLOCKED off (D58).
  await slack.getByText('Post updates to a channel everyone on it can read. Channels get less detail than DMs.').waitFor();
  await slack.getByRole('button', { name: 'Add a channel' }).click();
  const add = slack.locator('#channel-add');
  await add.getByLabel('Channel name').fill('#Team-Updates');
  await add.getByLabel('Channel ID').fill('C0123ABCD');
  for (const [label, on] of [['Approval needed', false], ['Budget at 80%', true], ['Budget at 100%', true], ['A role is blocked', false], ['Meeting minutes', true], ['Ready to try', false]]) assert.equal(await add.getByLabel(label, { exact: true }).isChecked(), on, label);
  await add.getByRole('button', { name: 'Add the channel' }).click();
  await slack.getByText('Added. A first post in #team-updates says who chose it.').waitFor();
  assert.deepEqual(iss.slack.channels.map((c) => [c.channel, c.name, c.kinds]), [['C0123ABCD', 'team-updates', ['budget80', 'budget100', 'minutes']]]);
  // Mistakes keep what was typed (QA, #144): a name with a space is cleaned, a bad one and a duplicate say why in words.
  await slack.getByRole('button', { name: 'Add a channel' }).click();
  await add.getByLabel('Channel name').fill('Team Updates!');
  await add.getByLabel('Channel ID').fill('c0123abcd');
  await add.getByRole('button', { name: 'Add the channel' }).click();
  await add.getByText('A channel name can have lowercase letters, numbers, dashes, dots and underscores, up to 80. Copy it from Slack, without the #.').waitFor();
  assert.equal(await add.getByLabel('Channel name').inputValue(), 'Team Updates!');
  assert.equal(await add.getByLabel('Channel ID').inputValue(), 'c0123abcd');
  await add.getByLabel('Channel name').fill('Team Updates');
  await add.getByLabel('Meeting minutes', { exact: true }).uncheck();
  await add.getByRole('button', { name: 'Add the channel' }).click();
  await add.getByText('That channel is already added. Change its switches below instead.').waitFor();
  assert.equal(await add.getByLabel('Channel name').inputValue(), 'Team Updates');
  assert.equal(await add.getByLabel('Channel ID').inputValue(), 'c0123abcd');
  assert.equal(await add.getByLabel('Meeting minutes', { exact: true }).isChecked(), false, 'the switches are kept too');
  for (const label of ['Budget at 80%', 'Budget at 100%']) await add.getByLabel(label, { exact: true }).uncheck();
  await add.getByRole('button', { name: 'Add the channel' }).click();
  await add.getByText('Choose at least one thing to post to this channel.').waitFor();
  assert.equal(iss.slack.channels.length, 1);
  await add.getByRole('button', { name: 'Cancel' }).click();
  const ch = slack.locator('.n-channel', { hasText: '#team-updates' });
  await ch.getByLabel('A role is blocked', { exact: true }).check();
  await ch.getByText('Saved.', { exact: true }).waitFor();
  assert.deepEqual(iss.slack.channels[0].kinds.sort(), ['blocked', 'budget100', 'budget80', 'minutes']);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'slack-channel-light.png'), fullPage: true });
  await ch.getByRole('button', { name: 'Stop posting here' }).click();
  await slack.getByText('Stopped posting to #team-updates.').waitFor();
  assert.equal(iss.slack.channels.length, 0);

  // Disconnect stops every DM (D60).
  await slack.getByRole('button', { name: 'Disconnect Slack' }).click();
  await slack.getByText('Disconnected. No more Slack DMs from this team.').waitFor();
  assert.equal(link(), undefined);
  await slack.getByRole('button', { name: 'Connect Slack' }).waitFor();

  // A callback that was not started here, and one the person cancelled.
  await page.evaluate(() => sessionStorage.setItem('agent-team-slack-team', 'sample-app'));
  await page.goto(`${iss.origin}/slack/callback?code=x&state=sls_forged`);
  await page.getByText('This sign-in with Slack was started somewhere else. Choose Connect Slack again from Notifications.').waitFor();
  assert.equal(new URL(page.url()).search, '', 'the code is taken out of the address bar');
  await page.goto(`${iss.origin}/slack/callback?error=access_denied`);
  await page.getByText('You cancelled the sign-in with Slack. Nothing changed.').waitFor();
  await page.getByRole('link', { name: 'Back to Notifications' }).click();
  await slack.getByRole('button', { name: 'Connect Slack' }).waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Slack: failing health says so; a member sees no channels, and with no workspace is told to ask an owner (360px)', { skip }, async () => {
  const other = await stubIssuer({ members: { octo: { id: 'per_mem', name: 'Mem Ber', workspaces: [{ tenant: 'acme', name: 'Acme', role: 'member' }] } } });
  try {
    other.slack.failingSince = '2026-11-06T10:00:00.000Z';
    const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: SHOTS ? 3 : 1 });
    const page = await ctx.newPage();
    await page.goto(`${other.origin}/teams/sample-app/notifications`);
    await page.getByRole('link', { name: 'Continue with GitHub' }).click();
    const slack = page.locator('section[aria-labelledby="slack-title"]');
    await slack.getByText(/^Slack · failing since .+, sending by email instead$/).waitFor();
    assert.equal(await slack.getByText('Team channels').count(), 0, 'channels are for owners and admins');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 360);
    other.slack.connected = false;
    await page.reload();
    await slack.getByText("Slack isn't connected for this team yet. Ask an owner to add it.").waitFor();
    assert.equal(await slack.getByText('Add to Slack').count(), 0);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'slack-not-connected-member-phone-light.png'), fullPage: true });
    await ctx.close();
  } finally { other.close(); }
});

test('Slack: a callback that needs a sign-in first never carries the code into the sign-in address', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${iss.origin}/sign-in`);
  await page.evaluate(() => sessionStorage.setItem('agent-team-slack-team', 'sample-app'));
  await page.goto(`${iss.origin}/slack/callback?code=secret-code-123&state=sls_forged`);
  await page.getByRole('link', { name: 'Continue with GitHub' }).waitFor();
  assert.doesNotMatch(page.url(), /secret-code-123|sls_forged/);
  assert.ok(!iss.log.some((l) => /secret-code-123/.test(l.to ?? '')), 'no redirect carried the code');
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  // Back on the callback, the code this tab kept is tried once: here its state was not started by this person.
  await page.getByText('This sign-in with Slack was started somewhere else. Choose Connect Slack again from Notifications.').waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem('agent-team-slack-cb')), null);
  await ctx.close();
});

test('quiet hours and the digest render what is saved, and the log never shows an address it was not given', () => {
  const kinds = [{ id: 'approval', label: 'Approval needed' }, { id: 'budget100', label: 'Budget at 100%' }, { id: 'minutes', label: 'Meeting minutes' }, { id: 'digest', label: 'Daily digest' }];
  const html = prefsHtml({ kinds, notes: new Map(), device: 'Europe/Paris', prefs: { timezone: 'America/Los_Angeles', quietHours: { from: '22:00', to: '07:00' }, digest: { at: '08:00', kinds: ['minutes'] }, breakthrough: ['approval', 'budget100'] } });
  assert.match(html, /<option selected>America\/Los_Angeles<\/option>/);
  assert.match(html, /value="22:00"/);
  assert.match(html, /Approvals and budget stops always reach you, even in quiet hours, because the team is waiting on you\./);
  assert.match(html, /name="dkind" value="minutes" checked/);
  assert.doesNotMatch(html, /name="dkind" value="(approval|budget100|digest)"/, 'breakthrough kinds and the digest itself are not digest choices');
  assert.match(html, /Use this device&#39;s time zone \(Europe\/Paris\)/);
  const log = logHtml({ kinds, owner: true, log: { all: true, next: '1', items: [{ channel: 'email', at: new Date().toISOString(), kind: 'minutes', status: 'held', why: 'quiet hours', principal: 'per_kim' }, { channel: 'slack', at: new Date().toISOString(), kind: 'approval', status: 'failed', why: 'channel_not_found', to: '<U1>', principal: 'per_octo' }] } });
  assert.match(log, /Held for the digest<\/td><td>It came in during quiet hours\./);
  assert.doesNotMatch(log, /channel_not_found|quiet hours<\/p>/, 'never a provider\'s own error');
  assert.match(log, /&lt;U1&gt;/);
  assert.match(log, /<th scope="col">Who<\/th>/);
  assert.match(log, /aria-pressed="true">Everyone/);
  assert.match(log, /id="log-older"/);
  assert.match(logHtml({ kinds, owner: false, log: { items: [], next: null, all: false } }), /Nothing sent yet\. Messages show here as soon as the team needs you\./);
});

test('L25: set quiet hours and a digest, then read the delivery log, mine and everyone\'s', { skip }, async () => {
  const now = Date.now();
  iss.deliveries.push(
    { team: 'sample-app', person: 'per_octo', channel: 'email', at: new Date(now - 60e3).toISOString(), event: 'evt_1', kind: 'minutes', status: 'held', why: null, to: 'd***@example.com' },
    { team: 'sample-app', person: 'per_octo', channel: 'email', at: new Date(now - 120e3).toISOString(), event: 'evt_2', kind: 'approval', status: 'sent', why: null, to: 'd***@example.com' },
    { team: 'sample-app', person: 'per_kim', channel: 'slack', at: new Date(now - 180e3).toISOString(), event: 'evt_3', kind: 'blocked', status: 'failed', why: 'channel_not_found', to: 'U2' },
  );
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1, timezoneId: 'Europe/Paris' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${iss.origin}/teams/sample-app/notifications`);
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  const prefs = page.locator('#prefs');
  await prefs.getByRole('heading', { name: 'Quiet hours and the daily digest' }).waitFor();
  // Approvals and budget stops always break through, and say why on hover.
  const through = prefs.getByText('Approvals and budget stops always reach you, even in quiet hours, because the team is waiting on you.');
  assert.match(await through.getAttribute('title'), /^A decision only you can make/);
  await prefs.getByRole('button', { name: "Use this device's time zone (Europe/Paris)" }).click();
  await prefs.getByLabel('No quiet hours').uncheck();
  await prefs.getByLabel('Quiet from').fill('22:00');
  await prefs.getByLabel('to', { exact: true }).fill('07:30');
  await prefs.getByLabel('No daily digest').uncheck();
  await prefs.getByLabel('Daily digest at').fill('08:15');
  await prefs.getByLabel('Meeting minutes').check();
  await prefs.getByRole('button', { name: 'Save' }).click();
  await prefs.getByText('Saved.', { exact: true }).waitFor();
  const saved = iss.prefs.get('per_octo');
  assert.equal(saved.timezone, 'Europe/Paris');
  assert.deepEqual(saved.quietHours, { from: '22:00', to: '07:30' });
  assert.deepEqual(saved.digest, { at: '08:15', kinds: ['minutes'] });
  await page.reload();
  assert.equal(await prefs.getByLabel('Daily digest at').inputValue(), '08:15');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'quiet-hours-light.png'), fullPage: true });

  // The log: mine first; held says why on hover; an owner can see everyone's, with no one else's address.
  const log = page.locator('#log');
  await log.getByRole('heading', { name: 'Delivery log' }).waitFor();
  assert.equal(await log.locator('tbody tr').count(), 2);
  assert.equal(await log.locator('tr.st-held td', { hasText: 'Held for the digest' }).getAttribute('title'), 'It came in during quiet hours.');
  await log.getByRole('button', { name: 'Everyone' }).click();
  await log.locator('tbody tr').nth(2).waitFor();
  assert.equal(await log.getByRole('button', { name: 'Everyone' }).getAttribute('aria-pressed'), 'true');
  const kim = log.locator('tr', { hasText: 'per_kim' });
  await kim.getByText("Couldn't send").waitFor();
  assert.doesNotMatch(await kim.textContent(), /U2|channel_not_found/, "someone else's address, and a provider's own error, are never shown");
  // A phone: the page never scrolls sideways (the log scrolls inside itself), and the toggles are 44 px.
  await page.setViewportSize({ width: 360, height: 780 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 360), 'no sideways scroll at 360px');
  assert.ok((await log.getByRole('button', { name: 'Everyone' }).boundingBox()).height >= 44);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'delivery-log-phone-light.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await ctx.close();
});
