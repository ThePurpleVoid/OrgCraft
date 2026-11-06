// The link paths in emails and Slack messages (kit #101) and where they land in the Studio (apps/studio/public/links.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkHash, linkTeam, resolveMeeting } from '../apps/studio/public/links.js';

test('each link path lands on its page of the Studio', () => {
  assert.equal(linkHash('/teams/sample-app/inbox', '?card=crd_9f2'), '/#chat?card=crd_9f2');
  assert.equal(linkHash('/teams/sample-app/inbox', ''), '/#chat');
  assert.equal(linkHash('/teams/sample-app/budget', ''), '/#chat?budget');
  assert.equal(linkHash('/teams/sample-app/board', '?role=web-dev'), '/#team?role=web-dev');
  assert.equal(linkHash('/teams/sample-app/board', ''), '/');
  assert.equal(linkHash('/teams/sample-app/meetings/weekly-review', ''), '/#meetings?id=weekly-review');
  assert.equal(linkHash('/teams/sample-app/meetings', ''), '/#meetings');
});

test('anything else is not a link path, and odd values are dropped, never passed on', () => {
  for (const p of ['/teams/sample-app/notifications', '/teams/sample-app', '/teams//inbox', '/teams/a%2Fb/inbox', '/teams/x/inbox/extra', '/inbox', '/teams/%E0%A4%A/budget']) assert.equal(linkHash(p, ''), null, p);
  assert.equal(linkHash('/teams/x/inbox', '?card=<script>'), '/#chat');
  assert.equal(linkHash('/teams/x/board', '?role=a%26b'), '/');
  assert.equal(linkHash('/teams/x/meetings/a b', ''), '/#meetings');
});

test('the links cards and minutes carry (/t/…) land the same way', () => {
  assert.equal(linkHash('/t/sample-app/cards/card_1', ''), '/#chat?card=card_1');
  assert.equal(linkHash('/t/sample-app/approvals/apr_1', ''), '/#chat?card=apr_1');
  assert.equal(linkHash('/t/sample-app/meetings/mtg_9', ''), '/#meetings?id=mtg_9');
  for (const p of ['/t/sample-app/inbox', '/t/sample-app/budget', '/teams/sample-app/cards/x']) assert.equal(linkHash(p, ''), null, p);
  assert.equal(linkTeam('/t/sample-app/meetings/mtg_9'), 'sample-app');
});

test('a held meeting opens the meeting it was held from; a failed lookup falls back to the Meetings page', async () => {
  assert.equal(await resolveMeeting('/#meetings?id=mtg_9', async () => ({ definition: 'weekly-review' })), '/#meetings?id=weekly-review');
  assert.equal(await resolveMeeting('/#meetings?id=mtg_9', async () => { throw new Error('404'); }), '/#meetings');
  assert.equal(await resolveMeeting('/#meetings?id=mtg_9', async () => null), '/#meetings');
  assert.equal(await resolveMeeting('/#meetings?id=mtg_9', async () => ({ definition: '../x' })), '/#meetings');
  assert.equal(await resolveMeeting('/#meetings?id=weekly-review', async () => { throw new Error('not called'); }), '/#meetings?id=weekly-review');
  assert.equal(await resolveMeeting('/#chat?card=x', null), '/#chat?card=x');
});
