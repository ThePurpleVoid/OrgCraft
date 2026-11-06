#!/usr/bin/env node
// Makes AGENT_TEAM_STEP_UP_SECRET_HASH from the step-up secret the owner types at approval time (m3-design §5).
// The secret is read without echo, so it never lands in shell history or on screen. Only the hash goes into the
// GitHub "production" environment; the plain secret stays in the owner's password manager.
//
//   node deploy/server/step-up-hash.mjs
//
// Output: scrypt$<N>$<r>$<p>$<salt, base64url>$<32-byte key, base64url>, the format the control plane verifies.
import { randomBytes, scryptSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const PARAMS = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

export function hashStepUp(secret, salt = randomBytes(16)) {
  if (String(secret).length < 12) throw new Error('use at least 12 characters');
  const { N, r, p, keylen, maxmem } = PARAMS;
  const key = scryptSync(String(secret), salt, keylen, { N, r, p, maxmem });
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

async function ask(prompt) {
  const { stdin, stderr } = process;
  stderr.write(prompt);
  if (!stdin.isTTY) { let s = ''; for await (const c of stdin) s += c; return s.split('\n')[0]; }
  stdin.setRawMode(true);
  let s = '';
  return new Promise((done) => {
    const on = (b) => {
      for (const ch of b.toString('utf8')) {
        if (ch === '\r' || ch === '\n') { stdin.off('data', on); stdin.setRawMode(false); stdin.pause(); stderr.write('\n'); return done(s); }
        if (ch === '\u0003') { stderr.write('\n'); process.exit(130); }
        if (ch === '\u007f') s = s.slice(0, -1); else s += ch;
      }
    };
    stdin.on('data', on);
    stdin.resume();
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = await ask('Step-up secret (not shown): ');
  const b = process.stdin.isTTY ? await ask('Again: ') : a;
  if (a !== b) { console.error('step-up-hash: the two entries differ'); process.exit(1); }
  try { console.log(hashStepUp(a)); } catch (e) { console.error(`step-up-hash: ${e.message}`); process.exit(1); }
}
