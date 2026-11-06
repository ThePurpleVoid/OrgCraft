#!/usr/bin/env node
// Checks a deployment after it ships, without writing anything to it:
//   1. the control plane answers /v1/health directly and through the site's rewrite
//   2. the site serves its page, and the page's own call (/v1/health, checked in 1) is the one it makes
//   3. a live stream passes the site's rewrite unbuffered: the first bytes arrive at once, and the server's 20-second
//      keep-alive arrives while the stream is open. A buffering proxy would hold both until the stream ended.
//   4. the caller's IP resolves through the site: GET /v1/internal/caller (Bearer CRON_SECRET) answers { ip, edge }. Through
//      the site, edge must be true (the middleware's x-agent-team-edge matched) and ip must be this machine's own
//      address, the one the container sees directly, not a Vercel egress address. Per-caller rate limits, and so
//      sign-in, depend on it (#73). The server answers 404 while sign-in is off; the check is then skipped.
//
//   AGENT_TEAM_ADMIN_TOKEN=… CRON_SECRET=… node deploy/smoke.mjs --site https://<site> --api https://<container host>
//   --api-only skips the Studio page check (when --site is the container itself, as in CI).
//
// Exit 0 when all pass, 1 when the deployment is broken, 4 when the caller's IP does not resolve through the site
// (keep sign-in off until it does), 3 when only the stream check fails (then clients must reach
// streams on the container host directly: name it for streams in discovery, docs/deploy/vercel-supabase.md).
import { parseArgs } from 'node:util';

const { values: o } = parseArgs({ options: { site: { type: 'string' }, api: { type: 'string' }, wait: { type: 'string', default: '30' }, 'api-only': { type: 'boolean' } } });
const token = process.env.AGENT_TEAM_ADMIN_TOKEN ?? '';
if (!o.site || !o.api) { console.error('smoke: pass --site and --api'); process.exit(2); }
const site = o.site.replace(/\/+$/, ''), api = o.api.replace(/\/+$/, '');
const auth = token ? { authorization: `Bearer ${token}` } : {};
let broken = false;
const ok = (m) => console.log(`smoke: ok   ${m}`);
const bad = (m) => { console.log(`smoke: FAIL ${m}`); broken = true; };

async function health(base, label) {
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(10_000) });
      const b = await r.json().catch(() => ({}));
      if (r.ok && b.ok) return ok(`${label} /v1/health (${b.db})`);
    } catch { /* retry: a new deploy can take a few seconds to answer */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  bad(`${label} /v1/health did not answer ok`);
}

await health(api, 'container');
await health(site, 'site rewrite');
if (!o['api-only']) try {
  const r = await fetch(`${site}/`, { signal: AbortSignal.timeout(10_000) });
  const html = await r.text();
  if (!r.ok || !/<html/i.test(html)) bad(`site / answered ${r.status}`);
  else {
    // Every same-origin API path the page calls must be one the control plane answers through the rewrite.
    // The page's own scripts (same-origin src) are read too, since the CSP keeps them out of the HTML.
    let code = html;
    for (const [, src] of html.matchAll(/<script[^>]+src="(\/[^"]+)"/g)) code += await fetch(`${site}${src}`).then((x) => x.text()).catch(() => '');
    const calls = [...new Set([...code.matchAll(/fetch\(\s*['"`](\/v1\/[^'"`?$]*)/g)].map((m) => m[1]))];
    const failing = [];
    for (const path of calls) {
      const c = await fetch(`${site}${path}`, { headers: auth, signal: AbortSignal.timeout(10_000) }).catch(() => null);
      if (!c || c.status === 404 || c.status >= 500) failing.push(`${path} → ${c?.status ?? 'no answer'}`);
    }
    failing.length ? bad(`the page calls API paths the control plane does not serve: ${failing.join(', ')}`) : ok(`site serves its page; its API calls answer (${calls.join(', ') || 'none'})`);
  }
} catch (e) { bad(`site /: ${e.message}`); }

async function streamCheck() {
  if (!token) return console.log('smoke: skip stream check (no AGENT_TEAM_ADMIN_TOKEN)');
  const teams = await fetch(`${site}/v1/teams`, { headers: auth }).then((r) => (r.ok ? r.json() : { teams: [] })).catch(() => ({ teams: [] }));
  const team = teams.teams?.[0]?.id;
  if (!team) return console.log('smoke: skip stream check (no team yet; it runs once the first team exists)');
  const ctl = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => ctl.abort(), Number(o.wait) * 1000);
  let first = null, beat = null, buf = '';
  try {
    const r = await fetch(`${site}/v1/teams/${encodeURIComponent(team)}/events/stream?type=deploy-smoke.`, { headers: { ...auth, accept: 'text/event-stream' }, signal: ctl.signal });
    if (!r.ok) { clearTimeout(timer); return bad(`stream answered ${r.status}`); }
    const dec = new TextDecoder();
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      if (first === null && buf.includes('retry:')) first = Date.now() - started;
      if (beat === null && buf.includes(': keep-alive')) { beat = Date.now() - started; ctl.abort(); }
    }
  } catch (e) { if (e.name !== 'AbortError') { clearTimeout(timer); return bad(`stream: ${e.message}`); } }
  clearTimeout(timer);
  if (first !== null && first < 5000 && beat !== null) return ok(`stream passes the rewrite unbuffered (first bytes ${first} ms, keep-alive ${beat} ms)`);
  console.log(`smoke: FAIL stream through the site is buffered or cut (first bytes ${first ?? 'never'} ms, keep-alive ${beat ?? 'never'} ms)`);
  return 'stream';
}

async function callerCheck() {
  if (o['api-only']) return;
  const cron = process.env.CRON_SECRET ?? '';
  if (!cron) return console.log('smoke: skip caller IP check (no CRON_SECRET)');
  const who = async (base) => {
    const r = await fetch(`${base}/v1/internal/caller`, { headers: { authorization: `Bearer ${cron}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (!r) return { error: 'no answer' };
    if (r.status === 404) return { off: true };
    if (!r.ok) return { error: `answered ${r.status}` };
    return r.json().catch(() => ({ error: 'not JSON' }));
  };
  const plain = (ip) => String(ip ?? '').replace(/^::ffff:/i, '');
  const direct = await who(api), via = await who(site);
  if (direct.off && via.off) return console.log('smoke: skip caller IP check (sign-in is off: the server answers 404 until it is on)');
  if (direct.off || via.off) { console.log('smoke: FAIL caller IP check: only one of the container and the site answers /v1/internal/caller'); return 'caller'; }
  if (direct.error || via.error) { console.log(`smoke: FAIL caller IP check: container ${direct.error ?? 'ok'}, site ${via.error ?? 'ok'}`); return 'caller'; }
  if (via.edge !== true) { console.log('smoke: FAIL the site\'s requests do not carry the edge secret (AGENT_TEAM_EDGE_SECRET differs between Vercel and Fly, or the middleware did not run)'); return 'caller'; }
  if (!plain(via.ip) || plain(via.ip) !== plain(direct.ip)) { console.log(`smoke: FAIL through the site the caller is ${via.ip || 'unknown'}, directly ${direct.ip || 'unknown'}: the server is reading a proxy's address, not the caller's (or this machine reached the two over different IP versions)`); return 'caller'; }
  ok(`caller IP resolves through the site (${via.ip}, as the container sees it directly)`);
}

const caller = await callerCheck();
const stream = await streamCheck();
process.exit(broken ? 1 : caller === 'caller' ? 4 : stream === 'stream' ? 3 : 0);
