// The Studio's string table comes from the CPO's strings file (tools/studio-strings.mjs): keyed tables, glossary
// tooltips, control tooltips and first-time hints each get their own keys (ALL-4, ALL-5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStrings } from '../tools/studio-strings.mjs';

const MD = `# Strings

| Key | String |
|---|---|
| \`catalog.count\` | {n} on the team |
| \`a.pipe\` | one \\| two |

### T1. Glossary

| Word | Tooltip |
|---|---|
| Badge: Sends | This step sent something. |
| The team's lead | Answers you first. |

### T4. Controls

| Control | Tooltip |
|---|---|
| Same job, more hands | Adds copies. |
| Try it (Try a role) | Runs this role. |

### T5. Hints

| Screen | Hint |
|---|---|
| Team (org chart) | Drag a role. |
| Wiring view | Left and right. |

| Key | String |
|---|---|
| \`after\` | Back to keys |
`;

test('keyed rows, glossary tooltips, control tooltips and first-time hints each get their keys', () => {
  assert.deepEqual(parseStrings(MD), {
    'catalog.count': '{n} on the team',
    'a.pipe': 'one | two',
    'tip.badge.sends': 'This step sent something.',
    "tip.the.team's.lead": 'Answers you first.',
    'tip.control.same.job.more.hands': 'Adds copies.',
    'tip.control.try.it': 'Runs this role.',
    'hint.team': 'Drag a role.',
    'hint.wiring.view': 'Left and right.',
    after: 'Back to keys',
  });
});
