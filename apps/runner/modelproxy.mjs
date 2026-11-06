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
export function startModelProxy({ upstream = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com', key = () => process.env.ANTHROPIC_API_KEY, fetch: f = globalThis.fetch, log = () => {} } = {}) {
  const tokens = new Map(); // session -> token
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
      res.writeHead(up.status, out);
      if (up.body) Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res); else res.end();
    } catch (e) {
      log(`model proxy: ${e.message}`);
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
    close() { return new Promise((r) => server.close(r)); },
  };
}
