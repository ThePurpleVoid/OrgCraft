// F-B2 (owner's live test, 2026-11-10): a brief's "Model:" words reached the provider as a model id. A run's roster
// now takes a tier word or a priced model id only, and a run frozen before the fix sends its tier word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeRunner, plane, registerRunner } from './helpers.mjs';
import { teamFrom } from '../../studio/runs.mjs';

const roster = (model) => ({ version: 'abc123', repo: { url: 'https://github.com/example/shop.git', ref: 'main' }, roles: [{ slug: 'chief-of-staff', reportsTo: 'owner', areas: [], brief: 'Front door.', ...(model === undefined ? {} : { model }) }] });

test('F-B2: a run takes a tier word or a priced model id, never a brief\'s words; an old frozen roster sends its tier word', async () => {
  await plane(async (p) => {
    await p.call('POST', '/teams', { id: 'shop' });
    assert.equal((await p.call('PUT', '/teams/shop/budget', { perDay: 1000, sessions: 2 }, await p.su())).status, 200);
    for (const bad of ['deep (high effort)', 'claude-made-up', 'Deep']) {
      const r = await p.call('POST', '/teams/shop/runs', { team: roster(bad) });
      assert.equal(r.status, 400, `${bad}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error ?? '', /model is a tier \(deep, standard, routine, light\) or a model id in the price table/);
    }
    const ok = await p.call('POST', '/teams/shop/runs', { team: roster('claude-haiku-5-5') });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    // A run frozen before the fix holds the brief's words: the session is sent the tier word, never the words.
    await p.db.system(`update runs set roster = jsonb_set(roster, '{roles,0,model}', '"deep (high effort)"') where id = $1`, [ok.body.run ?? ok.body.id]);
    const r = await registerRunner(p.call);
    const runner = await fakeRunner(p.base, r.key, { runner: r.id });
    await p.call('POST', '/teams/shop/chat', { text: 'Hello' });
    const s = (await runner.next((f) => f.op === 'session.start')).body;
    assert.equal(s.model, 'deep');
  }, { tickMs: 0 });
});

test('F-B2: the Studio sends only a brief\'s tier word, taken from a real brief\'s Model line', () => {
  const md = readFileSync(new URL('../../../docs/team/roles/architect.md', import.meta.url), 'utf8');
  assert.match(md, /\*\*Model:\*\* deep \(high effort\)/);
  const files = { 'docs/team/roles/architect.md': md.replace(/\*\*Reports to:\*\*[^\n]*/, '**Reports to:** owner') };
  const team = teamFrom({ version: 'abc', paths: Object.keys(files), read: (p) => files[p] ?? null });
  assert.equal(team.roles[0].model, 'deep');
});
