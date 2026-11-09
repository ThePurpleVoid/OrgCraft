// Change safety, part 1 (PRD 6.9 X1, X5, X9; CPO story "change safety part 1"; mockup 06). Board-only: the Studio
// warns and records, it never stops or restarts anything (D12). Which roles are in flight comes from the board (the
// local event log or the control plane), so every list here says how old that is (D14). A team with no board reports
// shows none of it (D15, criterion 12).
import { briefSection, diffTeams, impact, inventoryFromBoard, meetingAttendees, ownsPaths, setBriefSection, setOwnsPaths, versionName } from './team-model.mjs';

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
const FIELD = { tier: 'Model', 'reports-to': 'Reports to', 'role-dormant': 'Status', pool: 'Pool', 'type-changed': 'Based on' };
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
  revertOne(spec, published, item);
  // An undo that leaves only empty change lists behind puts the role back exactly as published, so nothing is left over.
  const r = spec.roles[item.role], p = published.roles[item.role];
  const bare = (x) => { const e = x?.extension; const empty = !e || (!(e.fields ?? []).length && !(e.sections ?? []).length && e.title === undefined); return JSON.stringify({ ...x, extension: empty ? undefined : e }); };
  if (r && p && bare(r) === bare(p)) spec.roles[item.role] = clone(p);
}

function revertOne(spec, published, item) {
  const p = published.roles[item.role];
  // A role or teammate this draft added (the Publish sheet's Undo, L14): back to off, or gone with what it was given.
  if (item.kind === 'role-added' || item.kind === 'member-added') {
    if (p) { spec.roles[item.role] = clone(p); return; }
    delete spec.roles[item.role];
    const was = new Set((published.resources?.bindings ?? []).filter((b) => b.role === item.role).map((b) => b.resource));
    if (spec.resources?.bindings) spec.resources.bindings = spec.resources.bindings.filter((b) => b.role !== item.role || was.has(b.resource));
    return;
  }
  if (item.kind === 'member-renamed') {
    const r = spec.roles[item.role];
    if (!r || !p) return;
    // A seat's own name is its Name field (kit 0.22, L11b); a teammate named before that has it as its title.
    revertField(spec, published, item.role, 'Name');
    if (r.extension) { if (p.extension?.title !== undefined) r.extension.title = p.extension.title; else delete r.extension.title; }
    if (r.brief !== undefined && p.brief !== undefined) {
      const was = /^#\s+.*$/m.exec(p.brief)?.[0];
      if (was) r.brief = r.brief.replace(/^#\s+.*$/m, was);
    }
    return;
  }
  if (item.kind === 'hands-to') {
    const r = spec.roles[item.role];
    if (!r || !p) return;
    if (r.brief !== undefined && !r.extension && p.brief !== undefined) { r.brief = setBriefSection(r.brief, 'Hands to', briefSection(p.brief, 'hands to')); return; }
    const mine = (x) => (x.extension?.sections ?? []).filter((y) => /^hands to$/i.test(y.name));
    r.extension ??= {};
    r.extension.sections = [...(r.extension.sections ?? []).filter((y) => !/^hands to$/i.test(y.name)), ...mine(p).map(clone)];
    return;
  }
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
  if (item.kind === 'path-moved' || item.kind === 'path-removed' || item.kind === 'path-added') {
    const path = item.path ?? item.id.split(':').slice(2).join(':');
    const was = (published.ownership?.rows ?? []).find((r) => r.path === path);
    spec.ownership ??= { rows: [] };
    spec.ownership.rows = [...(spec.ownership.rows ?? []).filter((r) => r.path !== path), ...(was ? [clone(was)] : [])];
    revertOwns(spec, published, path);
    return;
  }
  if (/^binding-/.test(item.kind)) {
    const resource = item.resource ?? item.id.split(':').at(-1);
    const was = (published.resources?.bindings ?? []).find((b) => b.role === item.role && b.resource === resource);
    spec.resources ??= { resources: [], bindings: [] };
    spec.resources.bindings = [...(spec.resources.bindings ?? []).filter((b) => !(b.role === item.role && b.resource === resource)), ...(was ? [clone(was)] : [])];
    return;
  }
  // The team's own files, piece by piece (the Publish sheet's Undo): a gate target, a meeting, the rules, the values.
  const put = (obj, k, v) => { if (v === undefined) delete obj[k]; else obj[k] = clone(v); };
  if (item.kind === 'gate') {
    spec.gates ??= {};
    if (item.target === 'all') put(spec.gates, 'all', published.gates?.all);
    else { spec.gates.targets ??= {}; put(spec.gates.targets, item.target, published.gates?.targets?.[item.target]); }
    return;
  }
  if (item.kind === 'meeting') {
    const was = (published.meetings?.meetings ?? []).find((m) => m.id === item.meeting);
    spec.meetings ??= { meetings: [] };
    const list = spec.meetings.meetings ?? [];
    const i = list.findIndex((m) => m.id === item.meeting);
    if (was && i >= 0) list[i] = clone(was);
    else if (was) list.push(clone(was));
    else if (i >= 0) list.splice(i, 1);
    spec.meetings.meetings = list;
    return;
  }
  if (item.kind === 'rules' || item.kind === 'values' || item.kind === 'options') put(spec, item.kind, published[item.kind]);
  else if (item.kind === 'other' && item.key) put(spec, item.key, published[item.key]);
}

/**
 * A kept draft made on an older published team (someone published since): the draft's own changes, put on top of the
 * team as it is now (CPO ruling on publish.stale; B1.1-10, a reload never loses the draft). Each role, and each other
 * part of the spec, that the draft changed comes from the draft; everything else from the newer team. Where both
 * changed the same role the draft's wins, and the Publish sheet lists it, so the owner checks it before publishing.
 */
export function rebaseDraft(from, mine, now) {
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const out = clone(now);
  out.roles ??= {};
  for (const slug of new Set([...Object.keys(from.roles ?? {}), ...Object.keys(mine.roles ?? {})])) {
    if (same(mine.roles?.[slug], from.roles?.[slug])) continue;
    if (mine.roles?.[slug] === undefined) delete out.roles[slug]; else out.roles[slug] = clone(mine.roles[slug]);
  }
  for (const k of new Set([...Object.keys(from), ...Object.keys(mine)])) {
    if (k === 'roles' || same(mine[k], from[k])) continue;
    if (mine[k] === undefined) delete out[k]; else out[k] = clone(mine[k]);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the impact step
// Criteria 8 to 11: in Publish, between the checks and the file review. Every item has a recommended choice, nothing
// here blocks Publish (D15), and the chosen plan goes into the commit message only (D12), never a file.

/** The words for a choice, with the PR named only when the work has one (D18). */
export function choiceLabel(id, item) {
  const pr = item?.inFlight?.pr;
  return ({
    finish: 'Let it finish its current task first',
    handoff: 'Hand the work off now',
    pause: 'Pause the work',
    'move-after-merge': pr ? `Move the area after PR #${pr} merges` : 'Move the area after the current work is done',
    'move-and-handover': 'Move the area now and hand the files over',
  })[id] ?? id;
}

/** The role a hand-off goes to by default (criterion 10): the area's new owner, else the role's manager, if on. */
export function defaultTarget(item, spec, on, managerOf = null) {
  const ok = (slug) => slug && slug !== item.role && on.some((r) => r.slug === slug);
  if (item.kind === 'path-moved') {
    const path = item.id.split(':').slice(2).join(':');
    const to = (spec.ownership?.rows ?? []).find((r) => r.path === path)?.writer;
    if (ok(to)) return to;
  }
  // A kit role has no brief in the spec: the caller's managerOf reads the resolved one (QA on #103).
  const brief = spec.roles[item.role]?.brief ?? '';
  const mgr = managerOf?.(item.role) || (fieldRe('Reports to').exec(brief)?.[1] ?? spec.roles[item.role]?.extension?.fields?.find((f) => f.name === 'Reports to')?.value ?? '').split(/\s/)[0]?.toLowerCase();
  if (ok(mgr)) return mgr;
  return on.find((r) => r.slug !== item.role)?.slug ?? '';
}

/** Each item that asks for a choice gets its recommendation, and a hand-off target where one can be needed. */
export function recommendations(items, spec, on, managerOf = null) {
  const out = new Map();
  for (const i of items) if (i.severity !== 'safe') out.set(i.id, { choice: i.recommended, target: i.choices.includes('handoff') || i.choices.includes('move-and-handover') ? defaultTarget(i, spec, on, managerOf) : '' });
  return out;
}

const needsTarget = (choice) => choice === 'handoff' || choice === 'move-and-handover';

/** The impact step's HTML. `picks` maps item id to { choice, target }; `on` lists the roles on in the draft. */
export function impactHtml({ items, picks, on, titleOf, board, newest, spec, roles, dispatcher = '' }) {
  const asks = items.filter((i) => i.severity !== 'safe');
  const safe = items.filter((i) => i.severity === 'safe');
  if (!asks.length && !safe.length) return '';
  const groups = new Map();
  for (const i of asks) groups.set(i.role, [...(groups.get(i.role) ?? []), i]);
  const targetSelect = (i, p) => `<label class="target">To <select data-target="${esc(i.id)}" aria-label="Hand ${esc(titleOf(i.role))}'s work to">
    ${on.filter((r) => r.slug !== i.role).map((r) => `<option value="${esc(r.slug)}"${r.slug === p.target ? ' selected' : ''}>${esc(r.title)}</option>`).join('')}</select></label>`;
  const itemHtml = (i) => {
    const p = picks.get(i.id) ?? { choice: i.recommended, target: '' };
    return `<fieldset class="impact-item" data-item="${esc(i.id)}"><legend>${esc(reasonOf(i).replace(/^./, (c) => c.toUpperCase()))}</legend>
      ${i.choices.map((c) => `<label class="choice"><input type="radio" name="pick-${esc(i.id)}" value="${esc(c)}" data-pick="${esc(i.id)}"${c === p.choice ? ' checked' : ''}> ${esc(choiceLabel(c, i))}${c === i.recommended ? ' <span class="muted">(recommended)</span>' : ''}</label>${c === p.choice && needsTarget(c) ? targetSelect(i, p) : ''}`).join('')}
      ${p.choice === 'move-after-merge' ? '<p class="hint">The published files keep the current writer until you publish again after that. The checks panel reminds you.</p>' : ''}
    </fieldset>`;
  };
  return `<section class="impact" aria-labelledby="impact-title">
    <div class="row impact-head"><h3 id="impact-title">Work in progress</h3>${asks.length ? '<button type="button" id="impact-recommend">Use the recommendations</button>' : ''}</div>
    ${asks.length ? `<p class="muted">Nothing stops or restarts now. ${esc(carriedBy(dispatcher))}</p>` : ''}
    ${[...groups].map(([slug, list]) => `<div class="impact-role"><h4>${esc(titleOf(slug))}</h4><ul class="plain">${inFlightList(rowOf(board, slug), spec, roles, slug).map((l) => `<li>${l}</li>`).join('')}</ul>${list.map(itemHtml).join('')}</div>`).join('')}
    ${safe.length ? `<details class="impact-safe"${asks.length ? '' : ' open'}><summary>Applies at each role's next task (${safe.length})</summary><ul>${safe.map((i) => `<li>${esc(i.detail)}</li>`).join('')}</ul></details>` : ''}
    <p class="hint">${esc(staleNote(newest))}</p>
  </section>`;
}

/** The plan for the commit message (criterion 9): one line per item that asked for a choice. '' when there is none. */
/** Who carries the plan out: the role that takes the owner's requests when the team has one (CPO copy review of #103). */
export const carriedBy = (dispatcher) => `${dispatcher ? `${dispatcher.replace(/^./, (c) => c.toUpperCase())} carries` : 'The team carries'} these out when this change is merged.`;

/** The reason as it reads once published (no "in this draft"): "Switched off", "Area web/ moved from a to b". */
export function doneReason(item) {
  if (item.kind === 'path-moved' || item.kind === 'path-removed') return `Area ${item.detail.replace(/ moves /, ' moved ').replace(/ no longer has /, ' no longer has ')}`;
  return ({
    'role-off': 'Switched off', 'role-removed': 'Removed', 'role-dormant': 'Made dormant', brief: 'Rules changed', tier: 'Tier changed',
    'reports-to': 'Reports elsewhere', 'binding-removed': 'System removed', 'binding-narrowed': 'System access narrowed',
  })[item.kind] ?? 'Changed';
}

export function planText(items, picks, titleOf, dispatcher = '') {
  const lines = items.filter((i) => i.severity !== 'safe').map((i) => {
    const p = picks.get(i.id) ?? { choice: i.recommended, target: '' };
    const w = i.inFlight;
    const work = w ? [w.task || 'current work', w.branch ? `branch ${w.branch}` : '', w.pr ? `PR #${w.pr}` : ''].filter(Boolean).join(', ') : 'current work';
    const what = doneReason(i);
    return `- ${titleOf(i.role)} (${i.role}): ${work}. ${what}: ${choiceLabel(p.choice, i).replace(/^./, (c) => c.toLowerCase())}${needsTarget(p.choice) && p.target ? `, to ${p.target}` : ''}.`;
  });
  return lines.length ? `Work in progress\n\n${lines.join('\n')}\n\n${carriedBy(dispatcher)} Based on board reports; may be out of date.` : '';
}

/**
 * What is published (criterion 11): the draft, except that an area set to move after its open work merges keeps its
 * current writer in the files, so there are never two writers. Returns { spec, deferred: [{ path, from, to }] }.
 */
export function publishable(draft, published, items, picks) {
  const out = clone(draft);
  const deferred = [];
  for (const i of items) {
    if (i.kind !== 'path-moved' || (picks.get(i.id)?.choice ?? i.recommended) !== 'move-after-merge' || i.severity === 'safe') continue;
    const path = i.id.split(':').slice(2).join(':');
    deferred.push({ path, from: i.role, to: (draft.ownership?.rows ?? []).find((r) => r.path === path)?.writer ?? '', pr: i.inFlight?.pr ?? null, owns: ownsAround(draft, path) });
    revert(out, published, i);
  }
  return { spec: out, deferred };
}

const overlaps = (a, b) => { const n = (x) => x.replace(/\*+$/, ''); return n(a).startsWith(n(b)) || n(b).startsWith(n(a)); };

/** Every custom brief's Owns lines that touch `path`, as the draft has them: { slug: [{ path, mode, note }] }. */
function ownsAround(spec, path) {
  const out = {};
  for (const [slug, r] of Object.entries(spec.roles)) if (r.brief !== undefined) out[slug] = ownsPaths(r.brief).paths.filter((x) => overlaps(x.path, path));
  return out;
}

/**
 * Puts a deferred move back into a draft that was read from disk (after a reload or a restart, the draft is the
 * published team, which keeps the old writer): the ownership row and the Owns lines the draft had when it was
 * published. Code review of #103. Returns true when it changed the draft.
 */
export function reapplyFollowUp(spec, f) {
  const row = (spec.ownership?.rows ?? []).find((r) => r.path === f.path);
  if (!row || row.writer !== f.from || !spec.roles[f.to]) return false;
  row.writer = f.to;
  for (const [slug, lines] of Object.entries(f.owns ?? {})) {
    const r = spec.roles[slug];
    if (r?.brief === undefined) continue;
    const now = ownsPaths(r.brief);
    r.brief = setOwnsPaths(r.brief, [...now.paths.filter((x) => !overlaps(x.path, f.path)), ...lines], now.prose);
  }
  return true;
}
