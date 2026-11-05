// team-report: the hosted Agent Team Kit board.
//
//   POST  with header x-team-token: TEAM_REPORT_TOKEN   body: one report from scripts/agent-team/team-status.sh
//         -> { ok: true, id }
//   GET   with header x-team-read-token: TEAM_READ_TOKEN   ?role=<role>[#instance]&days=7
//         -> { as_of, current, recent, flow, role }
//
// The write token can only append; the read token can only read. Neither is a Supabase key, and the function
// talks to the database with the service role. Deploy with --no-verify-jwt: threads have no Supabase user.
import { createClient } from "jsr:@supabase/supabase-js@2";

export const KINDS = new Set(["status", "handoff", "bug", "signoff", "blocked", "note", "heartbeat"]);
export const STATUSES = new Set(["idle", "working", "waiting", "blocked", "review", "done"]);
const ROLE = /^[a-z0-9][a-z0-9_-]{0,59}$/;

export class BadRequest extends Error {}

const text = (v: unknown, max: number): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, max) : null;
};
const int = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : parseInt(String(v ?? "").replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

/** The row for team_events, or a BadRequest saying what is wrong with the report. */
export function toRow(b: Record<string, unknown>): Record<string, unknown> {
  const role = (text(b.role, 60) ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  if (!ROLE.test(role)) throw new BadRequest("role must be a brief's slug, like backend-dev");
  const kind = text(b.kind, 20) ?? "status";
  if (!KINDS.has(kind)) throw new BadRequest(`kind must be one of ${[...KINDS].join(", ")}`);
  const status = text(b.status, 20);
  if (status && !STATUSES.has(status)) throw new BadRequest(`status must be one of ${[...STATUSES].join(", ")}`);
  if (kind === "status" && !status) throw new BadRequest("a status report needs a status");
  const to = text(b.to, 60)?.toLowerCase().replace(/[^a-z0-9_#-]+/g, "-") ?? null;
  if (["handoff", "bug", "signoff", "blocked"].includes(kind) && !to) throw new BadRequest(`${kind} needs a 'to' role`);
  const evidence = (Array.isArray(b.evidence) ? b.evidence : String(b.evidence ?? "").split(","))
    .map((e) => String(e).trim()).filter(Boolean).slice(0, 20).map((e) => e.slice(0, 300));
  const severity = int(b.severity);
  return {
    role,
    instance: text(b.instance, 60),
    kind,
    status,
    task: text(b.task, 300),
    issue: int(b.issue),
    pr: int(b.pr),
    branch: text(b.branch, 200),
    commit: text(b.commit, 40),
    platform: text(b.platform, 20),
    to_role: to,
    severity: severity && severity <= 4 ? severity : null,
    evidence,
    detail: text(b.detail, 2000),
    source: text(b.source, 60) ?? "team-status.sh",
    session: text(b.session, 120),
  };
}

/** Constant-time string comparison for tokens. */
export function sameToken(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const hits = new Map<string, number[]>();
/** At most 30 reports a minute per role or instance, per function instance. */
function limited(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > 30;
}

/**
 * CORS for dashboards on a website: TEAM_DASHBOARD_ORIGINS is a comma-separated list of origins allowed to read
 * (for example https://example.com), or * for any. Unset, browsers on other origins cannot read the board.
 */
export function cors(origin: string | null, allowed = Deno.env.get("TEAM_DASHBOARD_ORIGINS") ?? ""): Record<string, string> {
  const list = allowed.split(",").map((o) => o.trim()).filter(Boolean);
  if (!origin || !list.length || (!list.includes("*") && !list.includes(origin))) return {};
  return {
    "access-control-allow-origin": list.includes("*") ? "*" : origin,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "x-team-read-token, authorization, apikey, content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });

const db = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

export async function handle(req: Request): Promise<Response> {
  const corsHeaders = cors(req.headers.get("origin"));
  const json = (b: unknown, status = 200) => reply(b, status, corsHeaders);
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    if (req.method === "POST") {
      const expected = Deno.env.get("TEAM_REPORT_TOKEN");
      if (!expected) return json({ error: "TEAM_REPORT_TOKEN is not set on this project" }, 403);
      if (!sameToken(expected, req.headers.get("x-team-token") ?? "")) return json({ error: "forbidden" }, 403);
      const row = toRow(await req.json().catch(() => ({})));
      if (limited(`${row.role}#${row.instance ?? ""}`)) return json({ error: "too many reports" }, 429);
      const id = crypto.randomUUID();
      const { error } = await db().from("team_events").insert({ id, ...row });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, id });
    }
    if (req.method === "GET") {
      const expected = Deno.env.get("TEAM_READ_TOKEN");
      if (!expected) return json({ error: "TEAM_READ_TOKEN is not set on this project" }, 403);
      if (!sameToken(expected, req.headers.get("x-team-read-token") ?? "")) return json({ error: "forbidden" }, 403);
      const url = new URL(req.url);
      const days = Math.min(Math.max(parseInt(url.searchParams.get("days") ?? "7", 10) || 7, 1), 90);
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const [wantRole, wantInst] = (url.searchParams.get("role") ?? "").split("#");
      const c = db();
      const [current, recent, flow] = await Promise.all([
        c.from("team_current").select("*").order("last_at", { ascending: false }),
        c.from("team_events").select("*").gte("at", since).order("at", { ascending: false }).limit(200),
        c.from("team_flow_7d").select("*").order("last_at", { ascending: false }),
      ]);
      let role: unknown[] = [];
      if (wantRole) {
        let q = c.from("team_events").select("*").eq("role", wantRole);
        if (wantInst) q = q.eq("instance", wantInst);
        role = (await q.order("at", { ascending: false }).limit(100)).data ?? [];
      }
      const error = current.error ?? recent.error ?? flow.error;
      if (error) return json({ error: error.message }, 500);
      return json({ as_of: new Date().toISOString(), days, current: current.data, recent: recent.data, flow: flow.data, role });
    }
    return json({ error: "method not allowed" }, 405);
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    return json({ error: "internal error" }, 500);
  }
}

if (import.meta.main) Deno.serve(handle);
