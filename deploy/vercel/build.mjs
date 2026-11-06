#!/usr/bin/env node
// Writes the Vercel site: the static Studio, plus rewrites that send /v1/* and /.well-known/agent-team to the control
// plane container, so people, phones and the kit's report scripts all use one host. No functions and no crons run
// on Vercel; the API, live streams, timers and the runner socket all live in the container (m3-design.md §8).
//
//   node deploy/vercel/build.mjs --api https://<app>.fly.dev [--out .vercel-site]
//
// Then, in the output folder: vercel pull, vercel build --prod, vercel deploy --prebuilt --prod (see deploy.yml).
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The vercel.json for a site that fronts the control plane at `api` (an https origin, no path). */
export function siteConfig(api) {
  const u = new URL(api);
  if (u.protocol !== 'https:' || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username) {
    throw new Error(`--api must be an https origin with no path, query or credentials (got ${api})`);
  }
  const origin = u.origin;
  return {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    framework: null,
    buildCommand: '',
    installCommand: '',
    outputDirectory: 'public',
    cleanUrls: false,
    rewrites: [
      { source: '/v1', destination: `${origin}/v1` },
      { source: '/v1/:path*', destination: `${origin}/v1/:path*` },
      { source: '/.well-known/agent-team', destination: `${origin}/.well-known/agent-team` },
    ],
    headers: [
      {
        source: '/(.*)',
        headers: [
          { key: 'x-content-type-options', value: 'nosniff' },
          { key: 'referrer-policy', value: 'strict-origin-when-cross-origin' },
          { key: 'x-frame-options', value: 'DENY' },
          { key: 'strict-transport-security', value: 'max-age=63072000; includeSubDomains' },
        ],
      },
    ],
  };
}

export function buildSite({ api, out }) {
  const dir = resolve(out);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, 'apps', 'studio', 'public'), join(dir, 'public'), { recursive: true });
  writeFileSync(join(dir, 'vercel.json'), `${JSON.stringify(siteConfig(api), null, 2)}\n`);
  return dir;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: o } = parseArgs({ options: { api: { type: 'string' }, out: { type: 'string', default: '.vercel-site' } } });
  if (!o.api) { console.error('build: pass --api https://<control plane host>'); process.exit(2); }
  try { console.log(`build: site in ${buildSite(o)}, /v1 → ${new URL(o.api).origin}`); } catch (e) { console.error(`build: ${e.message}`); process.exit(2); }
}
