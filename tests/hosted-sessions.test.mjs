// Live test exit B (F-B3, F-B4): a hosted (runner) session has no gh and no sign-in, so no shipped brief may tell it to
// call gh; it finishes a change with request_approval action "accept", and owner decisions go on cards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { KIT } from '../bin/agent-team.mjs';
import { PACK_DOCS, teamDoc } from '../packages/team-model/index.mjs';
import { loadKit } from '../packages/team-model/node.mjs';

const kit = loadKit();
const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : f.endsWith('.md') ? [join(dir, f)] : []));

test('no shipped brief or protocol tells a hosted session to call gh', () => {
  const GH = /(^|[^\w-])`?gh`?(?![\w-])/;
  const ok = (l) => /outside a hosted session|never call gh there/i.test(l) || /Never call `gh`/.test(l);
  for (const file of walk(join(KIT, 'team'))) {
    for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
      if (GH.test(line)) assert.ok(ok(line), `${relative(KIT, file)}:${i + 1} names gh without saying it is not for hosted sessions: ${line}`);
    }
  }
});

test('the core protocols, with or without packs, name request_approval action "accept" and cards for owner decisions', () => {
  for (const packs of [[], ['engineering']]) {
    const doc = teamDoc(kit, 'protocols.md', packs);
    assert.match(doc, /## Hosted sessions/, String(packs));
    assert.match(doc, /Finish a change with `request_approval`, action `"accept"`/, String(packs));
    assert.match(doc, /Never call `gh`/, String(packs));
    assert.match(doc, /A decision for the owner goes on a card, never only in chat text/, String(packs));
    assert.match(doc, /`ask_owner`: two to four options lettered A to D/, String(packs));
  }
  assert.match(teamDoc(kit, 'protocols.md', ['engineering']), /the runner pushes the branch, opens the pull request and, on approval, merges it pinned to the head commit/);
  assert.ok(PACK_DOCS.includes('protocols.md'));
});

test('the front door logs tasks without gh in a hosted session and asks the owner on cards', () => {
  const brief = kit.roles['chief-of-staff'];
  assert.doesNotMatch(brief, /open the issue/);
  assert.match(brief, /In a hosted session the task is your `report`/);
  assert.match(brief, /Every decision for the owner goes on a card with `ask_owner`/);
  assert.match(brief, /a finished change is accepted with `request_approval`, action `"accept"`, never with a merge question in chat/);
});
