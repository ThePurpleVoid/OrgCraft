// TIMEZONE must be an IANA zone: Intl rejects "Pacific", and meetings and the scheduler then silently use UTC
// (chief of staff, fast lane). validate warns and names the zone; init maps common names and refuses unknown ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toZone } from '../packages/team-model/index.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-team.mjs');
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('toZone: IANA names pass, common names map, the rest are unknown', () => {
  assert.deepEqual(toZone('America/Los_Angeles'), { zone: 'America/Los_Angeles', from: 'iana' });
  assert.deepEqual(toZone('UTC'), { zone: 'UTC', from: 'iana' });
  assert.deepEqual(toZone('Pacific'), { zone: 'America/Los_Angeles', from: 'alias' });
  assert.deepEqual(toZone(' eastern '), { zone: 'America/New_York', from: 'alias' });
  assert.deepEqual(toZone('UK'), { zone: 'Europe/London', from: 'alias' });
  assert.deepEqual(toZone('EST'), { zone: 'America/New_York', from: 'alias' }, 'an abbreviation Intl accepts still maps to the city zone');
  assert.deepEqual(toZone('local time'), { zone: null, from: null });
  assert.deepEqual(toZone('Mars/Olympus'), { zone: null, from: null });
});

test('init maps "Pacific", refuses an unknown zone, and validate warns on one already in team.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tz-'));
  let r = run('init', '--preset', 'minimal', '--project', 'Tz', '--timezone', 'Pacific', '--dir', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Time zone "Pacific" saved as America\/Los_Angeles\./);
  const file = join(dir, '.agent-team', 'team.json');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).values.TIMEZONE, 'America/Los_Angeles');
  assert.doesNotMatch(run('validate', '--dir', dir).stdout, /TIMEZONE/);

  r = run('init', '--preset', 'minimal', '--project', 'Tz', '--timezone', 'Somewhere', '--dir', dir, '--force');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--timezone "Somewhere" is not a time zone/);

  const team = JSON.parse(readFileSync(file, 'utf8'));
  team.values.TIMEZONE = 'Pacific';
  writeFileSync(file, JSON.stringify(team, null, 2));
  r = run('validate', '--dir', dir);
  assert.equal(r.status, 0, 'a warning, not an error');
  assert.match(r.stdout, /warning: team\.json: TIMEZONE "Pacific" is not an IANA time zone, so meetings and the scheduler would use UTC; set it to "America\/Los_Angeles"/);
  rmSync(dir, { recursive: true, force: true });
});

