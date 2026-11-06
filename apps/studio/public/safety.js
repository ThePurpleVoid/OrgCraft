// Change safety, part 1 (PRD 6.9 X1, X5, X9; CPO story "change safety part 1"; mockup 06). Board-only: the Studio
// warns and records, it never stops or restarts anything (D12). Which roles are in flight comes from the board (the
// local event log or the control plane), so every list here says how old that is (D14). A team with no board reports
// shows none of it (D15, criterion 12).
import { diffTeams, impact, inventoryFromBoard, meetingAttendees, ownsPaths, setOwnsPaths, versionName } from './team-model.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const QUIET_S = 2 * 3600; // D14: a report older than this is shown with its age, in grey

/** How long ago, in words: "12 min", "3 h", "2 days". */
export function ago(seconds) {
  const s = Math.max(0, Math.round(seconds ?? 0));
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}

/** A role's own board row (not a per-PR instance), or null. */
export const rowOf = (board, slug) => (board?.current ?? []).find((c) => c.role === slug && !c.instance) ?? null;

/** The words a card and a library row show for a role's state: "working", or "last heard 3 h ago" when quiet (D14). */
export function stateWord(row) {
  if (!row) return '';
  if ((row.age_s ?? 0) > QUIET_S) return `last heard ${ago(row.age_s)} ago`;
  return row.waiting_on ? `${row.status} on ${row.waiting_on}` : row.status;
}

/** The task as people say it: "#153 Backfill theme default". */
export const taskOf = (row) => [row?.issue ? `#${row.issue}` : '', row?.task ?? ''].filter(Boolean).join(' ');

/** The short reason under a card's name for an amber mark (criterion 3). */
export function reasonOf(item) {
  return ({
    'role-off': 'switched off in this draft', 'role-removed': 'removed in this draft', 'role-dormant': 'dormant in this draft',
    'path-moved': 'area moves away', 'path-removed': 'area loses its writer', 'brief': 'rules changed', 'tier': 'tier changed',
    'reports-to': 'reports elsewhere', 'binding-removed': 'loses a system', 'binding-narrowed': 'system access narrowed',
  })[item.kind] ?? 'changed in this draft';
}

/** The same reason as the end of a sentence about the role, for the popover heading (CPO copy review of #97). */
export function clauseOf(item) {
  return ({
    'role-off': 'this draft switches it off', 'role-removed': 'this draft removes it', 'role-dormant': 'this draft makes it dormant',
    'path-moved': 'this draft moves an area it works in away from it', 'path-removed': 'this draft leaves an area it works in without a writer',
    'brief': 'this draft changes its rules', 'tier': 'this draft changes its tier', 'reports-to': 'this draft changes who it reports to',
    'binding-removed': 'this draft takes away a system it uses', 'binding-narrowed': 'this draft narrows its access to a system',
  })[item.kind] ?? 'this draft changes it';
}

/** "Undo switch off" and the like, for the popover's first button. */
export function undoLabel(item) {
  return ({
    'role-off': 'Undo switch off', 'role-removed': 'Undo removal', 'role-dormant': 'Undo dormant', 'path-moved': 'Undo area move',
    'path-removed': 'Undo area removal', 'brief': 'Undo brief changes', 'tier': 'Undo tier change', 'reports-to': 'Undo reporting change',
    'binding-removed': 'Undo system change', 'binding-narrowed': 'Undo system change',
  })[item.kind] ?? 'Undo this change';
}

/**
 * Everything the screens need, from the published team, the draft and the board: { on, changes, items, hot, newest,
 * version }. `hot` maps a role to its items that touch work in flight; `on` is false when the board has no reports.
 */
export function assess({ published, draft, kit, board, head }) {
  const on = !!board?.current?.length;
  const version = head?.sha ? versionName(head.sha, head.at) : '';
  if (!on || !published) return { on, changes: [], items: [], hot: new Map(), newest: null, version };
  const changes = diffTeams(published, draft, kit);
  const items = impact(changes, inventoryFromBoard(board));
  const hot = new Map();
  for (const i of items) if (i.inFlight && i.role) hot.set(i.role, [...(hot.get(i.role) ?? []), i]);
  const newest = board.current.reduce((m, c) => (!m || c.last_at > m ? c.last_at : m), null);
  return { on, changes, items, hot, newest, version };
}

/** The meetings a role attends, by name and when (from the draft's meetings.json). */
function meetingsOf(spec, roles, slug) {
  return (spec.meetings?.meetings ?? []).filter((m) => meetingAttendees(m, roles).roles.includes(slug)).map((m) => m.name ?? m.id);
}

/** What is in flight for a role, as list items: the task, branch and PR, and its meetings (criteria 4 and 5). */
export function inFlightList(row, spec, roles, slug) {
  if (!row) return [];
  const out = [];
  const task = taskOf(row);
  // A quiet row's state word already says how long ago ("last heard 3 h ago"), so the age is not said twice.
  const quiet = (row.age_s ?? 0) > QUIET_S;
  out.push(`${esc(stateWord(row))}${!quiet && (row.status_at || row.last_at) ? ` · ${esc(ago(row.age_s))}${(row.age_s ?? 0) > 90 ? ' ago' : ''}` : ''}${task ? `: <strong>${esc(task)}</strong>` : ''}`);
  if (row.branch || row.pr) out.push([row.branch ? `branch <code>${esc(row.branch)}</code>` : '', row.pr ? `PR #${esc(row.pr)}` : ''].filter(Boolean).join(' · '));
  if (row.waiting_on) out.push(`waiting on ${esc(row.waiting_on)}`);
  for (const m of meetingsOf(spec, roles, slug)) out.push(`invited to ${esc(m)}`);
  return out;
}

/** The note every in-flight list carries (D14, X9). */
export function staleNote(newest) {
  if (!newest) return '';
  const t = new Date(newest);
  return `Based on board reports; may be out of date. Newest report ${Number.isNaN(t.getTime()) ? newest : t.toLocaleString('en', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}.`;
}

/** "a, b and c" from the items' clauses, each said once. */
function clauses(items) {
  const c = [...new Set(items.map(clauseOf))];
  return c.length > 1 ? `${c.slice(0, -1).join(', ')} and ${c.at(-1)}` : c[0];
}

/** What the role is doing, for the popover heading: "is working right now", "is blocked", "is waiting on qa-web". */
function doing(row) {
  if (!row || (row.age_s ?? 0) > QUIET_S) return 'has work in flight';
  if (row.waiting_on) return `is waiting on ${row.waiting_on}`;
  return ({ working: 'is working right now', blocked: 'is blocked', waiting: 'is waiting' })[row.status] ?? 'has work in flight';
}

/** The popover by an amber card (criterion 4): what is in flight, and Undo / Review the impact. */
export function popoverHtml({ slug, title, items, row, spec, roles, newest }) {
  const first = items[0];
  return `<div class="impact-pop" role="dialog" aria-label="${esc(title)} is working right now" data-slug="${esc(slug)}">
    <p><strong>${esc(title)} ${esc(doing(row))}, and ${esc(clauses(items))}.</strong></p>
    <ul>${inFlightList(row, spec, roles, slug).map((l) => `<li>${l}</li>`).join('')}</ul>
    <p class="hint">Nothing changes for it yet. When you publish, you choose what happens to this work. ${esc(staleNote(newest))}</p>
    <div class="row"><button type="button" data-pop="undo" data-item="${esc(first.id)}">${esc(undoLabel(first))}</button><button type="button" class="primary" data-pop="review">Review the impact</button><button type="button" class="link" data-pop="close">Close</button></div>
  </div>`;
}

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const FIELD = { tier: 'Model', 'reports-to': 'Reports to', 'role-dormant': 'Status' };
const fieldRe = (name) => new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.*)$`, 'm');

/** Puts one header field of a role back as published, leaving the rest of its draft alone. */
function revertField(spec, published, slug, name) {
  const r = spec.roles[slug], p = published.roles[slug];
  if (!r || !p) return;
  if (r.brief !== undefined && !r.extension) {
    const was = fieldRe(name).exec(p.brief ?? '');
    const re = fieldRe(name);
    if (was) r.brief = re.test(r.brief) ? r.brief.replace(re, was[0]) : r.brief.replace(/^(#\s+.*\n)/, `$1\n${was[0]}\n`);
    else r.brief = r.brief.replace(new RegExp(`${re.source}\\n?`, 'm'), '');
    return;
  }
  const fields = r.extension?.fields ?? [];
  const was = p.extension?.fields?.find((f) => f.name === name);
  const rest = fields.filter((f) => f.name !== name);
  if (r.extension) r.extension.fields = was ? [...rest, clone(was)] : rest;
}

/** Puts every role's own Owns lines for `path` (and paths inside it or around it) back as published. */
function revertOwns(spec, published, path) {
  const norm = (x) => x.replace(/\*+$/, '');
  const overlap = (a, b) => norm(a).startsWith(norm(b)) || norm(b).startsWith(norm(a));
  for (const [slug, r] of Object.entries(spec.roles)) {
    if (r.brief === undefined) continue;
    const p = published.roles[slug];
    const now = ownsPaths(r.brief);
    const was = p?.brief !== undefined ? ownsPaths(p.brief).paths.filter((x) => overlap(x.path, path)) : [];
    if (!was.length && !now.paths.some((x) => overlap(x.path, path))) continue;
    r.brief = setOwnsPaths(r.brief, [...now.paths.filter((x) => !overlap(x.path, path)), ...was], now.prose);
  }
}

/**
 * Puts one change back as it is in the published team (the popover's Undo). It undoes only that change: a tier undo
 * keeps the role's rule edits, and an area undo restores both the ownership row and the roles' own Owns lines.
 */
export function revert(spec, published, item) {
  const p = published.roles[item.role];
  if (item.kind === 'role-removed' || (item.kind === 'role-off' && !spec.roles[item.role])) { spec.roles[item.role] = clone(p); return; }
  if (item.kind === 'role-off') { spec.roles[item.role].enabled = p?.enabled ?? true; return; }
  if (FIELD[item.kind]) return revertField(spec, published, item.role, FIELD[item.kind]);
  if (item.kind === 'brief') {
    // The rules and sections go back; the header fields the draft changed stay (they have their own undo).
    const keep = Object.values(FIELD).map((name) => [name, fieldRe(name).exec(spec.roles[item.role]?.brief ?? '')?.[0], spec.roles[item.role]?.extension?.fields?.find((f) => f.name === name)]);
    const enabled = spec.roles[item.role]?.enabled;
    spec.roles[item.role] = clone(p);
    const r = spec.roles[item.role];
    if (enabled !== undefined) r.enabled = enabled;
    for (const [name, line, ext] of keep) {
      if (r.brief !== undefined && !r.extension && line) r.brief = fieldRe(name).test(r.brief) ? r.brief.replace(fieldRe(name), line) : r.brief.replace(/^(#\s+.*\n)/, `$1\n${line}\n`);
      else if (r.extension && ext) r.extension.fields = [...(r.extension.fields ?? []).filter((f) => f.name !== name), clone(ext)];
    }
    return;
  }
  if (item.kind === 'path-moved' || item.kind === 'path-removed') {
    const path = item.id.split(':').slice(2).join(':');
    const was = (published.ownership?.rows ?? []).find((r) => r.path === path);
    spec.ownership ??= { rows: [] };
    spec.ownership.rows = [...(spec.ownership.rows ?? []).filter((r) => r.path !== path), ...(was ? [clone(was)] : [])];
    revertOwns(spec, published, path);
    return;
  }
  if (item.kind === 'binding-removed' || item.kind === 'binding-narrowed') {
    const resource = item.id.split(':').at(-1);
    const was = (published.resources?.bindings ?? []).find((b) => b.role === item.role && b.resource === resource);
    spec.resources ??= { resources: [], bindings: [] };
    spec.resources.bindings = [...(spec.resources.bindings ?? []).filter((b) => !(b.role === item.role && b.resource === resource)), ...(was ? [clone(was)] : [])];
  }
}
