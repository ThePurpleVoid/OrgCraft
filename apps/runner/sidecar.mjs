// The sidecar (L20 runner part; plans/build/l20-runner-sidecar.md, F4): local MCP servers, the connectors whose
// manifest says `tools: { command }`, run here and not inside the agent's process. Each server is its own process,
// started with only PATH, a private HOME and its own secrets, which the runner asks the control plane for by name
// (`secret.get`) and keeps in memory. The agent reaches the servers through one loopback MCP endpoint per session,
// with a token of its own; it never sees a secret, and every result is capped and redacted before the model reads it.
//
// The runner's policy has already decided each call (PreToolUse, with the effect from the manifest): the sidecar
// runs only a call the session's Steps hold as allowed and not yet ended, and gives it an idempotency key made from
// that call's id, so a retry of the same call never repeats its effect downstream.
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { redactNamed } from './steps.mjs';

export const RESULT_MAX = 64 * 1024;
export const EFFECTS = ['read', 'write', 'send', 'destructive', 'payment', 'deploy'];
/** The policy action a person approves for each effect that can't be taken back (policy.mjs DEFAULT_RULES names). */
export const EFFECT_ACTION = { send: 'outbound-message', destructive: 'destructive-data', payment: 'payment', deploy: 'deploy-production' };
const NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,40}$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const glob = (pattern, name) => new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name);

/** The command servers of session.start.tools.mcp; everything else (url servers) stays with the SDK and the gateway. */
export function localServers(mcp = {}) {
  return Object.fromEntries(Object.entries(mcp).filter(([, s]) => s && typeof s === 'object' && typeof s.command === 'string'));
}

/** Checks one local server's entry; returns a problem or null. */
export function serverProblem(name, s, { egressEnforced = false } = {}) {
  if (!NAME.test(name)) return `${name} is not a server name (letters, digits and dashes)`;
  if (s.args !== undefined && !(Array.isArray(s.args) && s.args.every((a) => typeof a === 'string'))) return `${name}: args must be a list of strings`;
  if (s.secrets !== undefined && !(Array.isArray(s.secrets) && s.secrets.every((x) => SECRET_NAME.test(x)))) return `${name}: secrets are names like API_TOKEN`;
  if (s.effects !== undefined && !(s.effects && typeof s.effects === 'object' && Object.values(s.effects).every((e) => EFFECTS.includes(e)))) return `${name}: each effect is one of ${EFFECTS.join(', ')}`;
  // A community server is trusted with nothing it can send anywhere: it runs only where its egress list is enforced.
  if (s.tier === 'community' && !egressEnforced) return `${name} is a community server, and this runner can't hold it to its egress list`;
  return null;
}

/** The effect a manifest gives a tool; a tool it does not name counts as write. */
export function effectOfTool(effects = {}, tool) {
  const exact = effects[tool];
  if (exact) return exact;
  const hit = Object.entries(effects).filter(([k]) => k.includes('*')).sort((a, b) => b[0].length - a[0].length).find(([k]) => glob(k, tool));
  return hit ? hit[1] : 'write';
}

/** The idempotency key of one decided call: the same call id always gives the same key. */
export const idempotencyKey = (session, call) => createHash('sha256').update(`${session}\n${call}`).digest('hex');

/** A tool result made safe for the model: secrets out, at most RESULT_MAX bytes of text. */
export function cleanResult(result, secrets) {
  let names = [];
  const content = (Array.isArray(result?.content) ? result.content : []).map((c) => {
    if (c?.type !== 'text') return { type: 'text', text: `[a ${c?.type ?? 'non-text'} part was left out]` };
    const r = redactNamed(c.text, secrets);
    names = names.concat(r.names);
    return { type: 'text', text: r.text };
  });
  let total = 0, cut = false;
  const kept = [];
  for (const c of content) {
    const left = RESULT_MAX - total;
    if (left <= 0) { cut = true; break; }
    const buf = Buffer.from(c.text, 'utf8');
    if (buf.length > left) { kept.push({ type: 'text', text: buf.subarray(0, left).toString('utf8').replace(/�$/, '') }); cut = true; total = RESULT_MAX; break; }
    kept.push(c);
    total += buf.length;
  }
  if (cut) kept.push({ type: 'text', text: `[cut at ${RESULT_MAX} bytes]` });
  return { content: kept, ...(result?.isError ? { isError: true } : {}), names: [...new Set(names)] };
}

/**
 * Starts a session's local servers. `servers`: the command entries of tools.mcp. `secretGet(name)`: resolves the
 * value or throws (secret.get over runner/1). `pending(tool, input)`: the call id the session's Steps hold as allowed
 * for this call, or null. `named()`: the session's own secrets, by name, for redaction.
 * Returns { mcp (entries for the SDK's mcpServers), effectOf(tool), secrets(), close() }.
 */
export async function startSidecar({ session, servers, secretGet, pending, named = () => [], egressEnforced = false, log = () => {}, connectTimeoutMs = 15_000 }) {
  const live = new Map(); // name -> { client, tools, secrets: [{ name, value }], home }
  const token = randomBytes(24).toString('base64url');
  const problems = [];
  const close = async () => {
    for (const [, s] of live) {
      await s.client.close().catch(() => {});
      s.secrets.length = 0;
      rmSync(s.home, { recursive: true, force: true });
    }
    live.clear();
    await new Promise((r) => http.close(() => r()));
  };

  const http = createServer(async (req, res) => {
    const m = /^\/mcp\/([^/?]+)$/.exec(req.url ?? '');
    const given = (/^Bearer (.+)$/.exec(req.headers.authorization ?? '') ?? [])[1];
    const s = m && live.get(decodeURIComponent(m[1]));
    if (!s || !given || !same(given, token)) { res.writeHead(401); return res.end(); }
    const server = proxyServer(m[1], s);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      log(`sidecar ${m[1]}: ${e.message}`);
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    }
  });

  function proxyServer(name, s) {
    const server = new Server({ name: `sidecar-${name}`, version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: s.tools }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const tool = `mcp__${name}__${req.params.name}`;
      const input = req.params.arguments ?? {};
      const call = pending(tool, input);
      // Only a call the runner's policy allowed reaches the server: nothing on the loopback port can go round it.
      if (!call) return { content: [{ type: 'text', text: 'Refused: the runner did not decide this call.' }], isError: true };
      let out;
      try {
        out = await s.client.callTool({ name: req.params.name, arguments: input, _meta: { idempotencyKey: idempotencyKey(session, call) } });
      } catch (e) {
        out = { content: [{ type: 'text', text: `The ${name} server failed: ${e.message}` }], isError: true };
      }
      const { names, ...clean } = cleanResult(out, [...s.secrets.map((x) => ({ name: x.name, value: x.value })), ...named()]);
      if (names.length) log(`sidecar ${name}: redacted ${names.join(', ')} in a result`);
      return clean;
    });
    return server;
  }

  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  for (const [name, s] of Object.entries(servers ?? {})) {
    const problem = serverProblem(name, s, { egressEnforced });
    if (problem) { problems.push(problem); continue; }
    const secrets = [];
    try {
      for (const n of s.secrets ?? []) secrets.push({ name: n, value: await secretGet(n) });
    } catch (e) { problems.push(`${name}: a secret was not released (${e.message})`); continue; }
    const home = mkdtempSync(join(tmpdir(), `sidecar-${name}-`));
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...Object.fromEntries(secrets.map((x) => [x.name, x.value])) };
    const client = new Client({ name: 'orgcraft-runner', version: '1' });
    try {
      const transport = new StdioClientTransport({ command: s.command, args: s.args ?? [], env, cwd: home, stderr: 'ignore' });
      await withTimeout(client.connect(transport), connectTimeoutMs, `${name} did not start`);
      const { tools } = await withTimeout(client.listTools(), connectTimeoutMs, `${name} did not list its tools`);
      live.set(name, { client, tools, secrets, home, effects: s.effects ?? {} });
    } catch (e) {
      await client.close().catch(() => {});
      secrets.length = 0;
      rmSync(home, { recursive: true, force: true });
      problems.push(`${name}: ${e.message}`);
    }
  }
  const base = `http://127.0.0.1:${http.address().port}/mcp/`;
  return {
    problems,
    mcp: Object.fromEntries([...live.keys()].map((n) => [n, { type: 'http', url: `${base}${encodeURIComponent(n)}`, headers: { authorization: `Bearer ${token}` } }])),
    /** The manifest's effect for `mcp__<server>__<tool>`, or undefined for a tool that isn't the sidecar's. */
    effectOf(tool) {
      const m = /^mcp__([A-Za-z0-9-]+)__(.+)$/.exec(tool);
      const s = m && live.get(m[1]);
      return s ? effectOfTool(s.effects, m[2]) : undefined;
    },
    /** The servers' secrets, by name, for the session's own redaction (step I/O, pushes, memory). */
    secrets() { return [...live.values()].flatMap((s) => s.secrets.map((x) => ({ name: x.name, value: x.value }))); },
    close,
  };
}

function withTimeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, reject) => { t = setTimeout(() => reject(new Error(what)), ms); t.unref?.(); })]).finally(() => clearTimeout(t));
}
