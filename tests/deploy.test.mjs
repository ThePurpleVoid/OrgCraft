// The hosted deploy path's pure parts: the destructive-migration guard and the Vercel site config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { destructiveStatements } from '../deploy/server/guard.mjs';
import { siteConfig, STATUS_PAGE, STATUS_SCRIPT, CSP, MIDDLEWARE } from '../deploy/vercel/build.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scryptSync } from 'node:crypto';
import { hashStepUp } from '../deploy/server/step-up-hash.mjs';

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
  assert.doesNotMatch(STATUS_PAGE, /<script>/, 'no inline script: the CSP forbids it');
  assert.match(STATUS_PAGE, /<script src="\/status.js"><\/script>/);
  const calls = [...STATUS_SCRIPT.matchAll(/fetch\(\s*['"`](\/v1\/[^'"`?$]*)/g)].map((m) => m[1]);
  assert.deepEqual(calls, ['/v1/health']);
});

test('the step-up hash is scrypt with its parameters and salt, and never contains the secret', () => {
  const h = hashStepUp('correct horse battery staple');
  const [kind, N, r, p, salt, key] = h.split('$');
  assert.equal(kind, 'scrypt');
  assert.ok(!h.includes('correct horse'));
  const again = scryptSync('correct horse battery staple', Buffer.from(salt, 'base64url'), 32, { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  assert.equal(N, '32768');
  assert.equal(again.toString('base64url'), key);
  assert.notEqual(hashStepUp('correct horse battery staple'), h, 'a fresh salt each time');
  assert.throws(() => hashStepUp('short'), /12 characters/);
});

test('the site sends the agreed CSP', () => {
  const h = siteConfig('https://api.example.org').headers[0].headers.find((x) => x.key === 'content-security-policy');
  assert.equal(h.value, CSP);
  assert.equal(CSP, "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
});

test('the edge middleware replaces a client x-agent-team-edge with the secret, keeps the rest, and only runs on the API paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mw-'));
  const file = join(dir, 'middleware.mjs');
  writeFileSync(file, MIDDLEWARE);
  const mw = await import(pathToFileURL(file).href);
  assert.deepEqual(mw.config.matcher, ['/v1/:path*', '/.well-known/agent-team']);
  assert.equal(mw.config.runtime, 'nodejs');
  const req = () => new Request('https://site.example/v1/health?x=1', {
    headers: { host: 'site.example', 'x-agent-team-edge': 'forged', 'x-forwarded-for': '203.0.113.9', authorization: 'Bearer t' },
  });
  const was = process.env.AGENT_TEAM_EDGE_SECRET;
  try {
    process.env.AGENT_TEAM_EDGE_SECRET = 's3cret-edge-value';
    let h = mw.default(req()).headers;
    assert.equal(h.get('x-middleware-next'), '1');
    assert.equal(h.get('x-middleware-rewrite'), null, 'the vercel.json rewrite stays the only destination');
    assert.equal(h.get('x-middleware-request-x-agent-team-edge'), 's3cret-edge-value');
    assert.equal(h.get('x-middleware-request-x-forwarded-for'), '203.0.113.9');
    assert.equal(h.get('x-middleware-request-authorization'), 'Bearer t');
    assert.equal(h.get('x-middleware-request-host'), null);
    const keys = h.get('x-middleware-override-headers').split(',');
    assert.ok(keys.includes('x-agent-team-edge') && keys.includes('authorization') && !keys.includes('host'));
    delete process.env.AGENT_TEAM_EDGE_SECRET;
    h = mw.default(req()).headers;
    assert.equal(h.get('x-middleware-request-x-agent-team-edge'), null, 'without the secret, a forged header is dropped');
    assert.ok(!h.get('x-middleware-override-headers').split(',').includes('x-agent-team-edge'));
  } finally {
    if (was === undefined) delete process.env.AGENT_TEAM_EDGE_SECRET; else process.env.AGENT_TEAM_EDGE_SECRET = was;
  }
});

test('every path the site rewrites to the control plane runs through the edge middleware', async () => {
  const matcher = MIDDLEWARE.match(/matcher: (\[[^\]]*\])/)[1].replace(/'/g, '"');
  const m = JSON.parse(matcher);
  const covered = (src) => m.some((x) => x === src || (x.endsWith('/:path*') && (src === x.slice(0, -7) || src.startsWith(x.slice(0, -6)))));
  for (const { source } of siteConfig('https://api.example').rewrites) assert.ok(covered(source), `${source} is rewritten but not in the middleware matcher`);
});
