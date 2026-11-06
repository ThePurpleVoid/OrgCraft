// What a session may do before a tool runs. Two rules from docs/team/protocols.md:
//   - one writer per path: a write outside the role's owned areas is refused;
//   - when the owner steps in: a call the policy classifies (data that cannot be undone, a secret, money, anything
//     leaving the company, accepting a change, a deploy) pauses the session until a person approves it.
//
// This classifier is a convenience layer, not the security line (security review R6). A shell can reach the same
// effect in ways no pattern sees (an encoded command, a script file, a raw API call). What holds the line is what
// the session cannot do at all: its environment has no credential that can push, merge or deploy, the runner
// pushes only at checkpoints after checking every changed path and scanning for secrets (worktree.mjs), and the
// default branch is protected so only the runner's own credential, after a person's approval, can merge.
// Pure: no I/O, so the same checks run under the Agent SDK, the stub model and the tests.
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Built-in tools that write files, and the input field that names the file. */
const WRITERS = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };

/**
 * The default owner-steps-in rules. Each names an action class (the `action` of approval.requested in
 * docs/contracts/events.md) and patterns over a shell command or an MCP call (`mcp__server__tool` plus its input).
 * Nothing here names a product: these are the protocol's categories. A team's policy can add rules or replace these.
 */
export const DEFAULT_RULES = [
  { action: 'destructive-data', why: 'changes or removes existing data in a way that cannot be undone',
    command: [/\bdrop\s+(table|schema|database|column|index|view)\b/i, /\btruncate\s+(table\s+)?\w/i, /\bdelete\s+from\b/i,
      /\balter\s+table\b[^;]*\b(drop|rename|alter\s+column\b[^;]*\btype)\b/i, /\brm\s+-[a-z]*r[a-z]*f?\s+\/(?!tmp\b)/i, /\b(db|database)\s+(reset|wipe|drop)\b/i] },
  { action: 'force-push', why: 'rewrites shared history',
    command: [/\bgit\s+push\b[^\n]*\s(--force(?!-with-lease)|-f\b)/i, /\bgit\s+push\b[^\n]*\s\+\S+/] },
  { action: 'accept', why: 'merges a proposal into the main line',
    command: [/\bgh\s+pr\s+merge\b/i, /\bgit\s+push\b[^\n]*\s(\S*:)?(refs\/heads\/)?(main|master)(\s|$)/i],
    call: [/merge_pull_request$/i, /(^|_)merge$/i] },
  { action: 'accept', why: 'merges a proposal into the main line',
    command: [/\/pulls\/\d+\/merge\b/i, /\bgh\s+api\b[^\n]*\bmerges?\b/i, /\bglab\s+mr\s+merge\b/i] },
  { action: 'deploy-production', why: 'deploys to production',
    command: [/\b(deploy|release|publish)\b[^\n]*\b(--prod(uction)?|prod(uction)?)\b/i, /\bvercel\b[^\n]*--prod\b/i, /\bnpm\s+publish\b/i, /\bterraform\s+(apply|destroy)\b/i, /\bkubectl\s+(apply|delete)\b[^\n]*\bprod/i] },
  { action: 'secret-write', why: 'adds or changes a secret',
    command: [/\b(gh|supabase|vercel|fly|heroku|doppler|vault)\b[^\n]*\b(secrets?|env)\s+(set|add|put|rm|remove|unset|write)\b/i, /\baws\s+secretsmanager\s+(put|create|update|delete)/i, /\bgcloud\s+secrets\s+(create|versions\s+add|delete)/i],
    call: [/secret/i] },
  { action: 'payment', why: 'spends or moves money',
    command: [/\bstripe\b[^\n]*\b(charges|payouts|refunds|transfers|payment_intents)\s+create\b/i],
    call: [/(payment|payout|refund|charge|invoice_send|transfer)s?($|_)/i] },
  { action: 'outbound-message', why: 'sends something outside the company',
    command: [/\b(sendmail|mailx?|mutt)\b/, /\bcurl\b[^\n]*\b(api\.(sendgrid|postmarkapp|mailgun|resend)\.|hooks\.slack\.com)/i],
    call: [/(send|post)_?(email|mail|message|tweet|dm)$/i, /^mcp__[^_]+__(send|reply|forward)\w*/i] },
];

/** Does a path pattern from the ownership table (`apps/runner/`, `scripts/*.sh`, `docs/**\/x.md`) match a path? */
export function matchArea(pattern, path) {
  const p = pattern.trim().replace(/^\.\//, '').replace(/\s*\(.*\)\s*$/, '');
  if (!p) return false;
  if (p.endsWith('/')) return path === p.slice(0, -1) || path.startsWith(p);
  if (!/[*?]/.test(p)) return path === p || path.startsWith(`${p}/`);
  const re = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  return new RegExp(`^${re}$`).test(path);
}

/** Paths that steer agents, CI or git itself: written only by a role whose area names them explicitly (R3). */
const GUARDED = [/^\.claude(\/|$)/, /^\.mcp\.json$/, /^\.github\/workflows(\/|$)/, /^\.git(attributes|modules|config)?$/, /(^|\/)\.git(\/|$)/];

/** May a role with these owned areas write this path (relative to the working copy)? */
export function owns(areas, path) {
  if (!areas.some((a) => matchArea(a, path))) return false;
  if (!GUARDED.some((g) => g.test(path))) return true;
  return areas.some((a) => GUARDED.some((g) => g.test(a.trim().replace(/[*?].*$/, '').replace(/\/$/, ''))) && matchArea(a, path));
}

/** Split an ownership row's path cell (`bin/, presets/, tools/`) into patterns. */
export const areasOf = (cells) => (Array.isArray(cells) ? cells : [cells]).flatMap((c) => String(c).split(/,\s*/)).map((s) => s.trim()).filter(Boolean);

const SHA = '([0-9a-f]{7,64})';
/** The pull request number and head commit a merge names, or null when it does not name both. */
export function mergeTarget(tool, input = {}, text = '') {
  let pr = null, headSha = null;
  if (tool === 'Bash') {
    pr = (/\bgh\s+pr\s+merge\s+(?:-\S+\s+)*#?(\d+)\b/.exec(text) ?? /\/pulls\/(\d+)\/merge\b/.exec(text) ?? /\bglab\s+mr\s+merge\s+(?:-\S+\s+)*!?(\d+)\b/.exec(text) ?? [])[1] ?? null;
    headSha = (new RegExp(`--match-head-commit[= ]\\s*${SHA}\\b`).exec(text) ?? new RegExp(`\\bsha["']?\\s*[=:]\\s*["']?${SHA}\\b`).exec(text) ?? new RegExp(`--sha[= ]\\s*${SHA}\\b`).exec(text) ?? [])[1] ?? null;
  } else {
    pr = input.pullNumber ?? input.pull_number ?? input.number ?? null;
    headSha = input.expectedHeadSha ?? input.expected_head_sha ?? input.sha ?? input.headSha ?? null;
    if (headSha !== null && !new RegExp(`^${SHA}$`).test(String(headSha))) headSha = null;
  }
  const n = Number(pr);
  return Number.isInteger(n) && n > 0 && headSha ? { pr: n, headSha: String(headSha) } : null;
}

/**
 * The decision for one tool call: { decision: 'allowed' | 'refused' | 'needs-approval', rule, why, target }.
 * `cwd` is the session's working copy, `areas` the role's owned areas (none: the role writes nothing), `rules` the
 * owner-steps-in rules, `also` absolute paths outside the copy the session may write (its memory file), and `teamTools` the name prefix of the team tool server (its calls are checked there).
 */
export function decide({ tool, input = {}, cwd, areas = [], also = [], rules = DEFAULT_RULES, teamTools = 'mcp__team__' }) {
  if (tool.startsWith(teamTools)) return { decision: 'allowed', rule: 'team-tool', target: tool };
  if (WRITERS[tool]) {
    const raw = String(input[WRITERS[tool]] ?? '');
    const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
    // Files the runner gives the session outside its working copy (its memory file).
    if (also.includes(abs)) return { decision: 'allowed', rule: 'session-file', target: abs };
    const rel = relative(cwd, abs).split(sep).join('/');
    if (!raw || rel.startsWith('..') || isAbsolute(rel)) return { decision: 'refused', rule: 'outside-worktree', why: `${raw || 'that path'} is outside this session's working copy`, target: raw };
    if (/^\.git(\/|$)/.test(rel)) return { decision: 'refused', rule: 'git-internals', why: 'the session does not write inside .git', target: rel };
    if (areas.some((a) => matchArea(a, rel)) && !owns(areas, rel)) return { decision: 'refused', rule: 'guarded', why: `${rel} steers agents, CI or git; only a role that owns it by name writes it`, target: rel };
    if (!owns(areas, rel)) {
      return { decision: 'refused', rule: 'ownership', target: rel,
        why: areas.length ? `${rel} is not in this role's owned areas (${areas.join(', ')}). Send a request to its owner instead.` : 'this role owns no paths, so it writes nothing. Send a request to the owner of the path instead.' };
    }
    return { decision: 'allowed', rule: 'ownership', target: rel };
  }
  const isShell = tool === 'Bash';
  const text = isShell ? String(input.command ?? '') : `${tool} ${JSON.stringify(input)}`;
  for (const r of rules) {
    const pats = isShell ? r.command : tool.startsWith('mcp__') ? r.call : null;
    if (pats?.some((re) => re.test(isShell ? text : tool))) {
      // A merge is approved for one pull request at one head commit (R5, D1): the call must name both, so a later
      // push cannot ride along. Anything accepted without them (a push straight to the main line) is refused.
      if (r.action === 'accept') {
        const m = mergeTarget(tool, input, text);
        if (!m) return { decision: 'refused', rule: 'match-head-commit', target: isShell ? text : tool, why: 'a merge must name the pull request and the commit it merges (for example gh pr merge 12 --match-head-commit <sha of the head that was reviewed>); the main line is never pushed to directly' };
        return { decision: 'needs-approval', rule: r.action, why: r.why, target: isShell ? text : tool, ...m };
      }
      return { decision: 'needs-approval', rule: r.action, why: r.why, target: isShell ? text : tool };
    }
  }
  return { decision: 'allowed', rule: null, target: isShell ? text : tool };
}
