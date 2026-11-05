// Evals for the team definition itself: every preset builds a team whose roster, reporting lines and hand-offs hold
// together, so a role is never told to hand work to someone who is not there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT, resolveRoles } from '../bin/agent-team.mjs';
import { parseBrief } from '../tools/briefs.mjs';
import { check } from '../tools/roster.mjs';
import { graphFrom } from '../tools/roster-graph.mjs';
import { toSubagent } from '../tools/export-subagents.mjs';

const empty = mkdtempSync(join(tmpdir(), 'agent-team-evals-'));
const presets = readdirSync(join(KIT, 'presets')).map((f) => f.replace(/\.txt$/, ''));

for (const preset of presets) {
  test(`preset ${preset}: the team holds together`, () => {
    const { roles, warnings } = resolveRoles(empty, { preset, include: [], exclude: [] });
    assert.deepEqual(warnings, []);
    const briefs = roles.map((r) => parseBrief(r.slug, r.md));
    assert.deepEqual(check(briefs).errors, []);
    const g = graphFrom(briefs);
    assert.equal(g.ownerReports.length, 1, 'one role reports to the owner');
    const slugLike = g.unresolved.filter((u) => /^[a-z0-9]+(-[a-z0-9]+)+$/.test(u.phrase));
    assert.deepEqual(slugLike, [], 'hand-offs name installed roles');
    for (const r of g.roles) {
      assert.ok(r.identity, `${r.slug} has an identity`);
      assert.ok(r.reportsTo === 'owner' || g.roles.some((x) => x.slug === r.reportsTo), `${r.slug} reports to someone on the team`);
    }
    for (const b of briefs) assert.match(toSubagent(b), new RegExp(`^---\\nname: ${b.slug}\\ndescription: ".+"\\nmodel: \\w+\\n---\\n`), `${b.slug} exports as a teammate type`);
  });
}
