// The hosted deploy path's pure parts: the destructive-migration guard and the Vercel site config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { destructiveStatements } from '../deploy/server/guard.mjs';
import { siteConfig, STATUS_PAGE } from '../deploy/vercel/build.mjs';

test('the guard flags data-losing statements and nothing in the shipped migrations', () => {
  const flagged = destructiveStatements([
    'alter table events drop column envelope;',
    'drop table sinks;',
    'truncate events;',
    'delete from secrets where true;',
    'alter table teams rename to crews;',
    'alter table events alter column version type bigint;',
    "create table a (b text default 'drop table x');",
    'create table c (d text references teams(id) on delete cascade);',
    "do $$ begin perform 1; end $$;",
  ].join('\n'));
  assert.equal(flagged.length, 6);
  for (const f of readdirSync('apps/server/migrations').filter((n) => n.endsWith('.sql'))) {
    assert.deepEqual(destructiveStatements(readFileSync(`apps/server/migrations/${f}`, 'utf8')), [], f);
  }
});

test('the site rewrites the API and discovery to one https origin, and nothing else', () => {
  const c = siteConfig('https://api.example.org');
  assert.deepEqual(c.rewrites.map((r) => [r.source, r.destination]), [
    ['/v1', 'https://api.example.org/v1'],
    ['/v1/:path*', 'https://api.example.org/v1/:path*'],
    ['/.well-known/agent-team', 'https://api.example.org/.well-known/agent-team'],
  ]);
  assert.equal(c.outputDirectory, 'public');
  assert.equal(c.crons, undefined);
  assert.equal(c.functions, undefined);
  for (const bad of ['http://api.example.org', 'https://api.example.org/v1', 'https://u:p@api.example.org', 'https://a.org/?x=1']) {
    assert.throws(() => siteConfig(bad), /https origin/, bad);
  }
});

test('until the Studio has a hosted mode, the site page only calls what the control plane serves', () => {
  const calls = [...STATUS_PAGE.matchAll(/fetch\(\s*['"`](\/v1\/[^'"`?$]*)/g)].map((m) => m[1]);
  assert.deepEqual(calls, ['/v1/health']);
});
