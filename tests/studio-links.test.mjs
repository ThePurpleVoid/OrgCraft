// The link paths in emails and Slack messages (kit #101) and where they land in the Studio (apps/studio/public/links.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkHash } from '../apps/studio/public/links.js';

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
