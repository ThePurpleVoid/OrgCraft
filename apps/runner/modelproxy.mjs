// The loopback model proxy (security review R1). The real model key never enters a session: each session gets
// ANTHROPIC_BASE_URL pointing here and a random token of its own as its "key". The proxy checks that token,
// swaps in the runner's real key and forwards the request. A token works only for its own session and only while
// the session lives, so whatever the agent's shell does with it, it never holds the key itself.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';

const HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-connection', 'content-length', 'x-api-key', 'authorization']);
/** The only model API calls a session may make through the proxy (F4). */
const ALLOWED = new Set(['POST /v1/messages', 'POST /v1/messages/count_tokens']);
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

/**
 * `upstream` is the model API's base URL; `key()` returns the runner's real key. Returns
 * { ready, register(session) -> { baseUrl, token }, unregister(session), close() }.
 */
export function startModelProxy({ upstream = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com', key = () => process.env.ANTHROPIC_API_KEY, fetch: f = globalThis.fetch, log = () => {}, onHealth = () => {}, downAfter = 2, probeMs = 30_000, provider = 'Anthropic' } = {}) {
  const tokens = new Map(); // session -> token
  // Outage mode (L29, O37.8): whether the model provider answers. A network error or a 5xx (529 overloaded included)
  // is a failure; DOWN_AFTER in a row make it unreachable, one answer of any other kind makes it ok again. While it is
  // unreachable the runner tells the control plane, which starts no new work here, and probes once per probeMs
  // (GET /v1/models: free) so it notices the provider is back without a session having to fail first.
  const health = { state: 'unknown', since: null, provider, error: null };
  let fails = 0, probe = null;
  const changed = () => { try { onHealth({ ...health }); } catch { /* the runner's problem, not the proxy's */ } };
  const ok = () => {
    fails = 0;
    if (probe) { clearInterval(probe); probe = null; }
    if (health.state !== 'ok') { Object.assign(health, { state: 'ok', since: new Date().toISOString(), error: null }); changed(); }
  };
  const fail = (why) => {
    fails++;
    if (fails < downAfter || health.state === 'unreachable') return;
    Object.assign(health, { state: 'unreachable', since: new Date().toISOString(), error: String(why).slice(0, 200) });
    changed();
    if (!probe && probeMs > 0) { probe = setInterval(check, probeMs); probe.unref?.(); }
  };
  const seen = (status) => (status >= 500 ? fail(`HTTP ${status}`) : ok());
  async function check() {
    const real = key();
    if (!real) return;
    try { const r = await f(`${upstream.replace(/\/+$/, '')}/v1/models?limit=1`, { headers: { 'x-api-key': real, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(10_000) }); await r.body?.cancel?.(); seen(r.status); } catch (e) { fail(e?.cause?.code ?? e?.message ?? 'unreachable'); }
  }
  const server = createServer(async (req, res) => {
    const m = /^\/s\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(req.url ?? '');
    const session = m ? decodeURIComponent(m[1]) : null;
    const token = tokens.get(session);
    const given = req.headers['x-api-key'] ?? (/^Bearer (.+)$/.exec(req.headers.authorization ?? '') ?? [])[1];
    if (!token || !given || !same(given, token)) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"type":"error","error":{"type":"authentication_error","message":"not a live session of this runner"}}'); }
    if (!ALLOWED.has(`${req.method} ${m[2] ?? '/'}`)) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end('{"type":"error","error":{"type":"permission_error","message":"the runner forwards only the messages API"}}'); }
    const real = key();
    if (!real) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"type":"error","error":{"type":"api_error","message":"the runner has no model key"}}'); }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
    headers['x-api-key'] = real;
    headers['accept-encoding'] = 'identity';
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    try {
      const up = await f(`${upstream.replace(/\/+$/, '')}${m[2] ?? '/'}${m[3] ?? ''}`, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: 'half' });
      const out = {};
      up.headers.forEach((v, k) => { if (!HOP.has(k) && k !== 'content-encoding') out[k] = v; });
      seen(up.status);
      res.writeHead(up.status, out);
      if (up.body) Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res); else res.end();
    } catch (e) {
      log(`model proxy: ${e.message}`);
      fail(e?.cause?.code ?? e?.message ?? 'unreachable');
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"api_error","message":"the model API could not be reached"}}'); } else res.destroy();
    }
  });
  const ready = new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    ready,
    register(session) {
      const token = `sess-${randomBytes(24).toString('base64url')}`;
      tokens.set(session, token);
      return { baseUrl: `http://127.0.0.1:${server.address().port}/s/${encodeURIComponent(session)}`, token };
    },
    unregister(session) { tokens.delete(session); },
    /** The model provider's state as this runner last saw it: { state: ok | unreachable | unknown, since, provider, error }. */
    health: () => ({ ...health }),
    /** Probes the provider now; the runner calls it once at start. */
    check,
    close() { if (probe) clearInterval(probe); return new Promise((r) => server.close(r)); },
  };
}
