// Agent Team Studio, the editor. Plain ES modules, no build step. The team is one TeamSpec (packages/team-model),
// edited here and checked live with the kit's own rules; the server only reads, previews and publishes.
import { addMember, applyExtension, checkUpgrade, DEFAULT_TARGETS, displayName, membersOf, poolOf, resolveSpec, setDisplayName, setEnabled, setField, splitBrief, TARGETS, teamPacks, teamTargets, typeOf, validate } from './team-model.mjs';
import { t, tip } from './i18n.js';
import { drawLines, renderWiring, wireWiring } from './wiring.js';
import { createChat } from './chat.js';
import { createMeetings } from './meetings.js';
import { createRollout } from './rollout.js';
import { createGallery, rolesLine, rulesLine } from './gallery.js';
import { exportPack, imported, isCustom, openNewAgent, switchOnRefusal } from './agents.js';
import { createAgentEditor } from './agent-editor.js';
import { QUIET_S, assess, impactHtml, reapplyFollowUp, inFlightList, planText, popoverHtml, publishable, reasonOf, recommendations, revert, rowOf, staleNote, stateWord, taskOf } from './safety.js';
import { $, $$, apiUrl, ask, configure, env, feature, paint, request, requestJson, stateEl } from './env.js';
import { SHELL } from './shell.js';
import { infoButton, installTips } from './tooltip.js';

/** The glossary tooltip (a function named `tip` is shadowed where the card builds its own hover text). */
const glossary = (key) => tip(key);
import { bind, renderAreas, renderChecks, renderSystemInspector, renderSystemsStrip, roleSystemsHtml, wireBindings } from './panels.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const TIERS = ['deep', 'standard', 'routine', 'light'];
const GROUP_ORDER = ['executive', 'engineering', 'quality', 'product', 'design'];
const field = (md, name) => (new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+)$`, 'm').exec(md ?? '')?.[1] ?? '').trim();
const titleOf = (md, slug) => (/^#\s+(.+)$/m.exec(md ?? '')?.[1] ?? slug).replace(/\s*\(.*\)\s*$/, '').trim();
/** The kit's groups have a colour each; a group the team made up gets its own, the same every time (PRD 6.6 A5). */
const groupColor = (g) => {
  if (GROUP_ORDER.includes(g) || g === 'other' || !g) return `var(--g-${GROUP_ORDER.includes(g) ? g : 'other'})`;
  let h = 0;
  for (const c of g) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 55% var(--g-light, 48%))`;
};

let S = null; // { root, kitVersion, kit, spec, git }
let spec = null;
let selected = null;
let query = '';
const undo = [];
const redo = [];
let view = null; // derived each render
let zoom = 'fit'; // or a number
let mode = 'org'; // org | flow | systems | areas | checks
let selectedSystem = null;
let wiring = null; // the teammate whose wiring view is open (B2.1), or null for the org chart
let flow = { key: '', edges: [], unresolved: [] }; // hand-offs, from the server, for the spec they were made from
let sugg = null; // owned area and check suggestions from the repository
let scale = 1;
let live = null; // { on, source, where, board, error, es } when the live board is shown
let chat = null; // the chief-of-staff chat, made the first time it is opened
let rolloutView = null; // the rollout page, made the first time it is opened
let meetings = null; // the Meetings view, made the first time it is opened
let prices = null; // packages/model-prices/prices.json, for meeting estimates
let editor = null; // the custom agent editor (agent-editor.js)
let lastEdit = { key: '', at: 0 }; // typing in one field folds into one undo step
// Change safety part 1: the team as last published (what is running), the board, and the open popover.
let published = null;
let board = null; // summarize() output from /v1/team/board, kept fresh by its stream; null until read
let pop = null; // the slug whose in-flight popover is open
let picks = new Map(); // impact step: item id -> { choice, target } (criteria 8 and 10)
let followUps = []; // areas published with "move after merge": [{ path, from, to, pr }] (criterion 11)
/** Where the team lives: the folder locally, owner/name of the repository when mounted in a host (S.repo, a URL). */
const where = () => S?.root ?? String(S?.repo ?? '').replace(/^https:\/\/[^/]+\//, '');
const followKey = () => `agent-team-followups:${where()}`;
function saveFollowUps() { try { localStorage.setItem(followKey(), JSON.stringify(followUps)); } catch { /* private mode: this session only */ } }
function loadFollowUps() { try { followUps = JSON.parse(localStorage.getItem(followKey()) ?? '[]'); } catch { followUps = []; } }
/** Phones get the control room (chat, live board) and a read-only team: building the team needs a large screen. */
const small = matchMedia('(max-width: 640px)');
// A repository with no team (templates story): the gallery, then a template on the canvas as a read-only preview,
// then the team as an unpublished draft.
let gallery = null;
let previewing = null; // the template card on the canvas, before "Use this template"
let made = null; // the template card the unpublished team came from; null for "almost empty"
let booted = false;
/** Editing is off on a phone and while a template is only being previewed. */
const locked = () => small.matches || !!previewing;
const lockedNote = () => (previewing ? 'This is a preview. Use this template to edit the team.' : 'Editing the team needs a larger screen');

// ------------------------------------------------------------------------------------------------ model

function derive() {
  const { roles } = resolveSpec(spec, S.kit);
  const bySlug = new Map(roles.map((r) => [r.slug, r]));
  const info = (slug) => {
    const r = spec.roles[slug];
    // A seat that is off is not resolved; its brief is still its role's brief with its own changes on top.
    const base = r.source === 'member' ? (spec.roles[r.type]?.brief ?? S.kit.roles[r.type]) : (r.brief ?? S.kit.roles[slug]);
    const md = bySlug.get(slug)?.md ?? (base && r.extension ? applyExtension(base, { ...r.extension, fields: (r.extension.fields ?? []).filter((f) => f.name !== 'Based on') }) : base) ?? '';
    const model = field(md, 'Model');
    const type = typeOf(spec, slug);
    return {
      slug, md, enabled: r.enabled, source: r.source, type,
      // ADR 0011: people see the teammate's name; the role it is based on is its subtitle.
      title: displayName(spec, S.kit, slug), typeTitle: titleOf(spec.roles[type]?.brief ?? S.kit.roles[type] ?? md, type),
      pool: poolOf(md), model, tier: (/^[a-z]+/i.exec(model)?.[0] ?? '').toLowerCase(),
      group: field(md, 'Group').toLowerCase() || 'other',
      reportsTo: (field(md, 'Reports to').split(/\s/)[0] ?? '').toLowerCase(),
      dormant: /^dormant/i.test(field(md, 'Status')),
      changed: !!(r.extension && ((r.extension.fields ?? []).length || (r.extension.sections ?? []).length || r.extension.title)),
    };
  };
  const all = Object.keys(spec.roles).sort().map(info);
  const safety = assess({ published, draft: spec, kit: S.kit, board, head: S.git?.head });
  const team = all.filter((r) => r.enabled && bySlug.has(r.slug));
  return { all, bySlug: new Map(all.map((r) => [r.slug, r])), team, issues: checksOf(spec), safety, draft: draftChanges(), looks: thingsToLook(team, bySlug) };
}

/**
 * B1.1-6: what changed since the last publish, per teammate (its seat: on or off, brief, changes, name) plus the
 * team's data files, so the canvas can draw changed cards dashed and count them. Nothing is published yet: all of it.
 */
function draftChanges() {
  const seat = (sp, slug) => { const r = sp?.roles?.[slug]; return r ? JSON.stringify([r.enabled, r.brief ?? null, r.extension ?? null]) : JSON.stringify([false, null, null]); };
  const slugs = new Set([...Object.keys(spec.roles), ...Object.keys(published?.roles ?? {})]);
  const changed = new Set([...slugs].filter((s) => seat(published, s) !== seat(spec, s)));
  const data = ['ownership', 'gates', 'resources', 'meetings', 'values', 'options', 'rules'].filter((k) => JSON.stringify(published?.[k] ?? null) !== JSON.stringify(spec[k] ?? null));
  return { changed, count: changed.size + data.length };
}

/**
 * B1.1-7: the live checks shown on the cards and under "Things to look at before you publish": a teammate whose
 * manager is not on the team (sync would hang it under the chief of staff), and two that report to each other.
 * They clear as soon as they are fixed, because they are computed from the draft on every change.
 */
function thingsToLook(team, resolved) {
  const out = [];
  const on = new Set(team.map((r) => r.slug));
  for (const r of team) {
    const raw = /\*\*Reports to:\*\*\s*\S+\s*\((\S+) is not part of this team\)/.exec(resolved.get(r.slug)?.md ?? '');
    if (raw && !on.has(raw[1])) out.push({ slug: r.slug, kind: 'nomanager', text: t('check.nomanager', { teammate: r.title }) });
  }
  const mgr = new Map(team.map((r) => [r.slug, r.reportsTo]));
  for (const r of team) { const m = mgr.get(r.slug); if (m && mgr.get(m) === r.slug && r.slug < m) out.push({ slug: r.slug, kind: 'loop', text: t('check.loop', { teammate: r.title, teammate2: team.find((x) => x.slug === m)?.title ?? m }) }); }
  return out;
}

/**
 * The team's checks, plus A7: a custom agent with the name of a role the pinned kit added since the team last synced
 * (and not marked in team.json "replaces") is an error, with two fixes in its editor. Sync refuses it the same way.
 */
function checksOf(sp) {
  const replaces = new Set(sp.options?.replaces ?? []);
  const clashes = checkUpgrade(sp, S.kit, S.kitRoles).filter((c) => !replaces.has(c.slug))
    .map((c) => ({ level: 'error', where: `roles/${c.slug}`, message: `the kit (${S.kitVersion}) adds a role called ${c.slug}, the same name as this agent: rename yours, or use the kit's`, fix: 'kit-clash' }));
  // The "replaces the kit's" note says the opposite of a clash (the replacement was never chosen), so the clash wins.
  const clashed = new Set(clashes.map((c) => c.where));
  return [...validate(sp, S.kit).filter((i) => !(clashed.has(i.where) && /^replaces the kit's/.test(i.message))), ...clashes];
}

/** Every change goes through here, so undo, redo and the redraw are in one place. */
/**
 * Every change goes through here, so undo, redo and the redraw are in one place. `key` folds a run of typing in one
 * field into one undo step; `quiet` updates what follows the text (checks, the editor's preview) without redrawing
 * the form being typed in.
 */
function change(fn, { quiet = false, key = '' } = {}) {
  if (locked()) { flash(lockedNote()); render(); return; }
  const now = Date.now();
  if (!key || key !== lastEdit.key || now - lastEdit.at > 1500) {
    undo.push(JSON.stringify(spec));
    if (undo.length > 200) undo.shift();
  }
  lastEdit = { key, at: now };
  redo.length = 0;
  const hotBefore = new Set(view?.safety?.hot.keys() ?? []);
  fn(spec);
  // Making a change that touches work in flight opens its explanation in place (criterion 4).
  if (!quiet) { const after = assess({ published, draft: spec, kit: S.kit, board, head: S.git?.head }); pop = [...after.hot.keys()].find((k) => !hotBefore.has(k)) ?? (after.hot.has(pop) ? pop : null); }
  if (quiet && editor?.slug) { view = derive(); renderIssues(); renderLibrary(); editor.live(); syncUndo(); return; }
  render();
}
function syncUndo() {
  $('#undo').disabled = !undo.length;
  $('#redo').disabled = !redo.length;
}
function step(from, to) {
  if (!from.length) return;
  lastEdit = { key: '', at: 0 };
  to.push(JSON.stringify(spec));
  spec = JSON.parse(from.pop());
  render();
}

function ext(slug) {
  const r = spec.roles[slug];
  return (r.extension ??= { fields: [], sections: [] });
}
function setExtField(slug, name, value) {
  const r = spec.roles[slug];
  if (r.brief !== undefined && !r.extension) {
    if (value === '') { r.brief = r.brief.replace(new RegExp(`^\\*\\*${name}:\\*\\*.*\\n`, 'm'), ''); return spec; }
    return setField(spec, slug, name, value);
  }
  const e = ext(slug);
  const kitValue = field(r.source === 'member' ? (spec.roles[r.type]?.brief ?? S.kit.roles[r.type]) : (S.kit.roles[slug] ?? r.brief), name);
  e.fields = e.fields.filter((f) => f.name !== name);
  if (value !== kitValue) e.fields.push({ name, value });
}
function setExtSection(slug, name, mode, text) {
  const e = ext(slug);
  e.sections = e.sections.filter((s) => s.name.toLowerCase() !== name.toLowerCase());
  if (text.trim()) e.sections.push({ name, mode, text: text.trim() });
}

/** True when `maybe` is `slug` or reports to it, directly or not. */
function under(slug, maybe) {
  for (let m = maybe; m && m !== 'owner'; m = view.bySlug.get(m)?.reportsTo) if (m === slug) return true;
  return false;
}
function setManager(slug, manager) {
  if (slug === manager) return;
  if (under(slug, manager)) return flash(`${view.bySlug.get(manager).title} reports to ${view.bySlug.get(slug).title}, so that would make a loop.`);
  change(() => {
    if (!spec.roles[slug].enabled) setEnabled(spec, slug, true);
    setExtField(slug, 'Reports to', manager);
  });
  selected = slug;
}

const ctx = {
  spec: () => spec,
  change: (fn) => change(fn),
  render: () => render(),
  get team() { return view.team; },
  esc,
  selectSystem: (id) => { selectedSystem = id; if (id) selected = null; render(); },
  selectRole: (slug) => select(slug),
};

// ------------------------------------------------------------------------------------------------ canvas

const W = 176, GX = 22, GY = 48, IND = 22;
let H = 54, ROW = H + 12; // a third line, the board state, when the team is running (change safety, criterion 1)

/**
 * An org chart that stays readable with forty roles. Managers of managers spread out sideways; a small subtree
 * (two levels, up to ten roles) is drawn as a lane, listed down a column and indented by depth; a manager's
 * direct reports that manage no one stack in one column beside its other reports.
 */
function layout(team) {
  const kids = new Map(team.map((r) => [r.slug, []]));
  kids.set('owner', []);
  const present = new Set(team.map((r) => r.slug));
  for (const r of team) (present.has(r.reportsTo) && r.reportsTo !== r.slug ? kids.get(r.reportsTo) : kids.get('owner')).push(r.slug);
  // A reporting loop never reaches the owner; hang the first role of each loop under the owner so it still shows.
  for (;;) {
    const seen = new Set();
    const visit = (s) => { for (const c of kids.get(s)) if (!seen.has(c)) { seen.add(c); visit(c); } };
    visit('owner');
    const lost = team.find((r) => !seen.has(r.slug));
    if (!lost) break;
    kids.set(lost.reportsTo, kids.get(lost.reportsTo).filter((c) => c !== lost.slug));
    kids.get('owner').push(lost.slug);
  }
  const rank = (s) => { const g = GROUP_ORDER.indexOf(view.bySlug.get(s).group); return g < 0 ? 9 : g; };
  const order = (a, b) => rank(a) - rank(b) || view.bySlug.get(a).title.localeCompare(view.bySlug.get(b).title);
  for (const list of kids.values()) list.sort(order);
  const size = (s) => kids.get(s).reduce((n, c) => n + 1 + size(c), 0);
  const depth = (s) => kids.get(s).reduce((n, c) => Math.max(n, 1 + depth(c)), 0);
  const isLane = (s) => s !== 'owner' && depth(s) <= 2 && size(s) <= 10;

  const pos = new Map();
  const edges = [];
  // Each block: { w, h, at(x, y) } where (x, y) is its top left corner and the head card sits at its top.
  const lane = (s) => {
    const rows = [];
    const walk = (p, d) => { for (const c of kids.get(p)) { rows.push([c, p, d]); walk(c, d + 1); } };
    walk(s, 1);
    const w = W + Math.max(0, ...rows.map((r) => r[2])) * IND;
    return { w, h: H + rows.length * ROW, head: W / 2, at(x, y) {
      pos.set(s, { x, y });
      rows.forEach(([c, p, d], i) => {
        const at = { x: x + d * IND, y: y + (i + 1) * ROW };
        pos.set(c, at);
        const a = pos.get(p);
        edges.push(`M${a.x + 12},${a.y + H} V${at.y + H / 2} H${at.x}`);
      });
    } };
  };
  const stack = (list) => ({ w: W + IND, h: list.length * ROW - 12, list });
  const block = (s) => {
    if (isLane(s)) return lane(s);
    const list = kids.get(s);
    const leaves = list.filter((c) => !kids.get(c).length);
    const parts = list.filter((c) => kids.get(c).length).map(block);
    if (leaves.length) parts.push(stack(leaves));
    const inner = parts.reduce((n, p) => n + p.w, 0) + GX * Math.max(0, parts.length - 1);
    const w = Math.max(W, inner);
    return { w, head: w / 2, h: H + (parts.length ? GY + Math.max(...parts.map((p) => p.h)) : 0), at(x, y) {
      const me = { x: x + (w - W) / 2, y };
      pos.set(s, me);
      let cx = x + (w - inner) / 2;
      const cy = y + H + GY;
      const bar = y + H + GY / 2;
      for (const p of parts) {
        if (p.list) {
          p.list.forEach((c, i) => {
            const at = { x: cx + IND, y: cy + i * ROW };
            pos.set(c, at);
            edges.push(`M${me.x + W / 2},${me.y + H} V${bar} H${cx + 8} V${at.y + H / 2} H${at.x}`);
          });
        } else {
          p.at(cx, cy);
          edges.push(`M${me.x + W / 2},${me.y + H} V${bar} H${cx + p.head} V${cy}`);
        }
        cx += p.w + GX;
      }
    } };
  };
  const root = block('owner');
  root.at(0, 0);
  return { pos, edges, w: root.w, h: root.h };
}

function systemsLine(slug) {
  const b = (spec.resources?.bindings ?? []).filter((x) => x.role === slug);
  return b.length ? b.map((x) => `${x.resource} ${x.permission}`).join(' · ') : 'no systems';
}

/** The newest live status of a role (any instance), and how many of its threads are active. */
function liveOf(slug) {
  const rows = ((live?.board ?? board)?.current ?? []).filter((c) => c.role === slug);
  if (!rows.length) return null;
  const active = rows.filter((c) => c.status !== 'done' && c.status !== 'idle');
  return { ...rows[0], threads: active.length };
}

const SELF_REPORTED = 'self-reported: no automatic reports from hooks, so this changes only when the role reports';

function liveLine(l) {
  if (!l) return 'no reports yet';
  const what = l.waiting_on ? `${l.status} on ${l.waiting_on}` : l.status;
  return `${what}${l.stale ? ' (quiet)' : ''}${l.self_reported ? ' · self-reported' : ''}${l.task ? ` · ${l.task}` : ''}`;
}

function nodeSvg(r, p, extra = '') {
  const sf = view.safety;
  // A running team (board reports): every card has a third line with its state, and amber when the draft touches its
  // work (change safety criteria 1 and 3). Otherwise, the Live toggle's two-line view as before.
  const three = sf.on && mode !== 'systems';
  const l = (live?.on || three) && mode !== 'systems' ? liveOf(r.slug) : undefined;
  const replaces = r.source === 'project-replaces-kit';
  const hot = three ? sf.hot.get(r.slug) : null;
  const own = three ? rowOf(board, r.slug) : null;
  if (three) extra += `${hot ? ' amber' : ''}${own ? ` live s-${own.status}${(own.age_s ?? 0) > QUIET_S ? ' quiet' : ''}` : ' live none'}${r.enabled ? '' : ' ghost'}`;
  else if (live?.on && mode !== 'systems') extra += l ? ` live s-${l.status}${l.stale ? ' stale' : ''}` : ' live none';
  // The reason replaces the tier on an amber card: it is what the owner needs to read there (criterion 3).
  // A role that reports for itself, with no hook events (another coding agent): its card says so (D46).
  const subtitle = r.off || !r.enabled ? t('canvas.off') : t('teammate.subtitle.ai', { role: r.typeTitle });
  const tier = r.off ? subtitle : three ? (hot ? reasonOf(hot[0]) : [r.tier, r.dormant ? 'dormant' : replaces ? 'replaces kit' : own?.self_reported ? 'self-reported' : ''].filter(Boolean).join(' · '))
    : l !== undefined ? liveLine(l) : mode === 'systems' ? systemsLine(r.slug) : subtitle;
  const state = three ? (own ? [stateWord(own), taskOf(own)].filter(Boolean).join(' · ') : '') : '';
  const look = view.looks.find((x) => x.slug === r.slug);
  const flag = view.issues.some((i) => i.level === 'error' && i.where === `roles/${r.slug}`) ? ' ⚠' : r.changed ? ' •' : '';
  if (view.draft.changed.has(r.slug)) extra += ' draft';
  if (look) extra += ' look';
  const tip = three && own ? `${r.title}: ${stateWord(own)}${taskOf(own) ? ` · ${taskOf(own)}` : ''}${own.branch ? ` · branch ${own.branch}` : ''}${own.pr ? ` · PR #${own.pr}` : ''}${hot ? ` · ${hot.map(reasonOf).join(', ')}` : ''}${own.self_reported ? ` · ${SELF_REPORTED}` : ''}` : '';
  return `<g class="node${r.slug === selected ? ' selected' : ''}${r.dormant ? ' dormant' : ''}${r.off ? ' off' : ''}${extra}" data-slug="${r.slug}" data-node="${r.slug}" transform="translate(${p.x},${p.y})" tabindex="0" role="button" aria-label="${esc(r.title)}, ${esc(r.off ? t('canvas.off') : t('teammate.subtitle.ai', { role: r.typeTitle }))}${hot ? `, ${esc(hot.map(reasonOf).join(', '))}, work in progress` : ''}${look ? `, ${esc(look.text)}` : ''}">
    <rect class="card" width="${W}" height="${H}"></rect>
    <rect class="stripe" width="4" height="${H - 16}" x="8" y="8" fill="${groupColor(r.group)}"></rect>
    <text class="title" x="20" y="23">${esc(r.title.length > 21 ? r.title.slice(0, 20) + '…' : r.title)}${flag}</text>
    <text class="meta" x="20" y="41"${tier === subtitle ? ` data-tip="${esc(glossary(r.off || !r.enabled ? 'grey.dot' : 'ai.teammate'))}"` : ''}>${esc(tier.length > 28 ? tier.slice(0, 27) + '…' : tier)}</text>
    ${look ? `<g class="badge-warn" transform="translate(${W - 10},-6)" data-tip="${esc(look.text)}"><circle r="9"></circle><text text-anchor="middle" y="4">!</text></g>` : ''}
    ${three ? `${state ? `<circle class="dot" cx="24" cy="${H - 15}" r="4"></circle><text class="state" x="33" y="${H - 11}">${esc(state.length > 25 ? state.slice(0, 24) + '…' : state)}</text>` : ''}${tip ? `<title>${esc(tip)}</title>` : ''}`
    : `${replaces && !l ? `<title>${esc(view.issues.find((i) => i.where === `roles/${r.slug}` && /replaces the kit/.test(i.message))?.message ?? 'Replaces the kit role of this name on this team')}</title>` : ''}
    ${l ? `<circle class="dot" cx="${W - 14}" cy="16" r="5"></circle>${l.threads > 1 ? `<text class="threads" x="${W - 24}" y="20" text-anchor="end">${l.threads}</text>` : ''}<title>${esc(`${r.title}: ${liveLine(l)}${l.pr ? ` · PR #${l.pr}` : ''}${l.issue ? ` · issue #${l.issue}` : ''}`)}</title>` : ''}`}
  </g>`;
}

/** What the wiring view reads and how it edits the draft. */
const wiringCtx = {
  spec: () => spec, view: () => view, kit: null, esc,
  change: (fn) => change(fn), render: () => render(),
  resolved: (slug) => view.bySlug.get(slug)?.md ?? '',
  setSection: (slug, name, m, text) => change(() => setExtSection(slug, name, m, text)),
  close: () => openWiring(null),
  locked: () => locked(),
};
let wiringWired = false;
/** Opens teammate `slug`'s wiring view in place of the chart (null closes it), with its own address (ALL-6). */
function openWiring(slug) {
  wiring = slug && spec.roles[slug] ? slug : null;
  if (wiring) selected = wiring;
  render();
  showPage(wiring ? `team?wiring=${encodeURIComponent(wiring)}` : 'team');
  (wiring ? $('#canvas h2') : $(`#canvas [data-node="${CSS.escape(selected ?? '')}"]`))?.focus?.();
}

function renderCanvas() {
  stateEl().dataset.wiring = wiring ? 'on' : '';
  if (wiring) {
    if (!wiringWired) { wireWiring($('#canvas'), wiringCtx, () => wiring); wiringWired = true; }
    renderWiring($('#canvas'), wiringCtx, wiring);
    // On a phone (or in a preview) the wiring reads but does not change (B1.7): wires open, nothing is added or deleted.
    if (locked()) for (const c of $$('#canvas :is(select, input, textarea, [data-del], #w-bind, #w-hand, .chip)')) { c.disabled = true; c.draggable = false; }
    $('#summary').textContent = view.draft.count ? t('canvas.changes', { n: view.draft.count }) : '';
    return;
  }
  const canvasMode = ['org', 'flow', 'systems'].includes(mode);
  stateEl().dataset.mode = mode;
  // B1.7 / B1.1-12: a phone gets the team as a list, top of the org first, read-only, and says so.
  if (small.matches && mode === 'org') { renderList(); return; }
  for (const b of $$('#views [data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === mode));
  $('#summary').textContent = view.draft.count ? t('canvas.changes', { n: view.draft.count }) : '';
  if (mode === 'systems') renderSystemsStrip($('#systems-strip'), ctx, selectedSystem);
  if (!canvasMode) {
    if (!sugg) loadSuggestions();
    (mode === 'areas' ? renderAreas : renderChecks)($('#canvas'), ctx, sugg);
    return;
  }
  const sf = view.safety;
  H = sf.on && mode !== 'systems' ? 70 : 54;
  ROW = H + 12;
  // A role switched off in the draft while it has work in flight stays on the canvas, greyed, so its work is seen.
  const ghosts = sf.on ? view.all.filter((r) => !r.enabled && sf.hot.has(r.slug)) : [];
  // B1.1-3: a teammate that is switched off keeps its place, dimmed, and says Off: a teammate of its own (a member),
  // one the team or its template lists as off, or one that is on in the published team.
  const shown = new Set([...view.team, ...ghosts].map((r) => r.slug));
  for (const r of view.all) {
    if (r.enabled || shown.has(r.slug)) continue;
    if (r.source === 'member' || (spec.layout?.exclude ?? []).includes(r.slug) || published?.roles?.[r.slug]?.enabled) { ghosts.push({ ...r, off: true }); shown.add(r.slug); }
  }
  const cards = [...view.team, ...ghosts];
  const lay = layout(cards);
  const { pos, w, h } = lay;
  let edges = lay.edges.map((d) => `<path class="edge" d="${d}"></path>`);
  if (mode === 'flow') {
    loadFlow();
    edges = edges.map((e) => e.replace('class="edge"', 'class="edge faint"')).concat(flow.edges.filter((x) => pos.has(x.from) && pos.has(x.to) && (!selected || x.from === selected || x.to === selected))
      .map((x) => handoff(pos.get(x.from), pos.get(x.to), !selected ? 'all' : x.from === selected ? 'out' : 'in')));
  }
  const PAD = 24;
  const fit = Math.min(1, ($('#canvas').clientWidth - 8) / (w + PAD * 2));
  scale = zoom === 'fit' ? Math.max(0.4, fit) : zoom;
  $('#zoom-level').textContent = `${Math.round(scale * 100)}%`;
  const owner = pos.get('owner');
  const nodes = cards.filter((r) => pos.has(r.slug)).map((r) => nodeSvg(r, pos.get(r.slug))).join('');
  $('#canvas').innerHTML = `<svg width="${(w + PAD * 2) * scale}" height="${(h + PAD * 2) * scale}" viewBox="${-PAD} ${-PAD} ${w + PAD * 2} ${h + PAD * 2}">
    <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrowhead"></path></marker><marker id="arrow-in" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrowhead in"></path></marker></defs>
    ${edges.join('')}
    <g class="node owner" data-slug="owner" transform="translate(${owner.x},${owner.y})"><rect class="card" width="${W}" height="${H}"></rect>
      <text class="title" x="20" y="23">${esc(spec.values?.OWNER || 'The owner')}</text><text class="meta" x="20" y="41">owner</text></g>
    ${nodes}</svg>`;
  if (live?.on) $('#summary').textContent += ` · ${liveSummary()}`;
  renderPopover();
  if (mode === 'flow') {
    const mine = selected ? flow.edges.filter((x) => x.from === selected || x.to === selected) : flow.edges;
    $('#summary').textContent += selected ? ` · ${view.bySlug.get(selected)?.title}: ${mine.filter((x) => x.from === selected).length} out, ${mine.filter((x) => x.to === selected).length} in` : ` · ${flow.edges.length} hand-offs`;
  }
}

/** The org as an indented list, for phones: each teammate under its manager, with its state and checks. */
function renderList() {
  for (const b of $$('#views [data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === mode));
  $('#summary').textContent = view.draft.count ? t('canvas.changes', { n: view.draft.count }) : '';
  const shown = [...view.team, ...view.all.filter((r) => !r.enabled && (r.source === 'member' || (spec.layout?.exclude ?? []).includes(r.slug)))];
  const on = new Set(shown.map((r) => r.slug));
  const kids = new Map([['owner', []], ...shown.map((r) => [r.slug, []])]);
  for (const r of shown) (on.has(r.reportsTo) && r.reportsTo !== r.slug ? kids.get(r.reportsTo) : kids.get('owner')).push(r);
  const seen = new Set();
  const item = (r, depth) => {
    if (seen.has(r.slug)) return '';
    seen.add(r.slug);
    const look = view.looks.find((x) => x.slug === r.slug);
    const off = !r.enabled;
    return `<li class="tree-item${off ? ' off' : ''}${view.draft.changed.has(r.slug) ? ' draft' : ''}" data-depth="${Math.min(depth, 6)}">
      <button type="button" class="tree-btn${r.slug === selected ? ' selected' : ''}" data-node="${esc(r.slug)}" data-slug="${esc(r.slug)}">
        <span class="name">${esc(r.title)}</span><span class="muted sub">${esc(off ? t('canvas.off') : t('teammate.subtitle.ai', { role: r.typeTitle }))}</span>
        ${look ? `<span class="badge-dot" title="${esc(look.text)}" aria-label="${esc(look.text)}">!</span>` : ''}</button></li>`
      + kids.get(r.slug).sort((a, b) => a.title.localeCompare(b.title)).map((c) => item(c, depth + 1)).join('');
  };
  $('#canvas').innerHTML = `<p class="hint phone-note">${esc(t('canvas.phone.readonly'))}</p><ul class="plain tree" aria-label="${esc(t('nav.team'))}">${kids.get('owner').map((r) => item(r, 0)).join('')}</ul>`;
}

function liveSummary() {
  if (live.error) return `live board unavailable: ${live.error}`;
  if (!live.board) return 'loading the live board…';
  const n = {};
  for (const c of live.board.current) if (view.bySlug.has(c.role)) n[c.status] = (n[c.status] ?? 0) + 1;
  const parts = ['working', 'waiting', 'blocked', 'review'].filter((k) => n[k]).map((k) => `${n[k]} ${k}`);
  return `live: ${parts.join(', ') || 'nobody working'} (${live.source === 'server' ? 'control plane' : 'this machine'})`;
}

/** The board, for change safety: read at start and on every change the stream reports. */
async function loadBoard() {
  try {
    const { r, body } = await ours(async () => { const r = await request('/v1/team/board'); return { r, body: await r.json() }; });
    const next = r.ok ? body.board ?? null : null;
    const was = !!board?.current?.length;
    board = next;
    if (!was && !board?.current?.length) return; // nothing running before or now: nothing to redraw
  } catch { board = null; }
  if (!view) return;
  // With the agent editor open, only what shows the board changes; the form being typed in is left alone.
  if (editor?.slug) { view = derive(); renderLibrary(); renderIssues(); return; }
  render();
}

async function loadLive() {
  try {
    const { r, body } = await ours(async () => { const r = await request('/v1/team/board'); return { r, body: await r.json() }; });
    Object.assign(live, { source: body.source, where: body.where, board: body.board ?? null, error: r.ok ? null : body.error });
  } catch (e) { live.error = e.message; }
  if (live.on) renderCanvas();
}

function toggleLive() {
  if (live?.on) { live.es?.close(); live = null; }
  else {
    live = { on: true, board: null, error: null };
    live.es = new EventSource(apiUrl('/v1/team/board/stream'));
    live.es.addEventListener('changed', loadLive);
    loadLive();
  }
  $('#live').setAttribute('aria-pressed', String(!!live?.on));
  renderCanvas();
}

/** A hand-off arrow between two cards, curving out to the side so it does not run along the reporting lines. */
function handoff(a, b, kind) {
  const x1 = a.x + W / 2, y1 = a.y + H / 2, x2 = b.x + W / 2, y2 = b.y + H / 2;
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
  // Start and end on the card edges, not their centres.
  const t = (ux, uy) => Math.min(Math.abs((W / 2) / (ux || 1e-9)), Math.abs((H / 2) / (uy || 1e-9)));
  const ux = dx / len, uy = dy / len, s = t(ux, uy) + 2;
  const sx = x1 + ux * s, sy = y1 + uy * s, ex = x2 - ux * s, ey = y2 - uy * s;
  const bend = Math.min(80, len / 4);
  const cx = (sx + ex) / 2 - uy * bend, cy = (sy + ey) / 2 + ux * bend;
  return `<path class="handoff ${kind}" marker-end="url(#${kind === 'in' ? 'arrow-in' : 'arrow'})" d="M${sx},${sy} Q${cx},${cy} ${ex},${ey}"></path>`;
}

let flowTimer = null;
function loadFlow() {
  const key = JSON.stringify(spec.roles);
  if (flow.key === key || flowTimer) return;
  flowTimer = setTimeout(async () => {
    try { flow = { key, ...(await api('/v1/team/graph', { spec })) }; } catch { flow = { key, edges: [], unresolved: [] }; }
    flowTimer = null;
    if (mode === 'flow') renderCanvas();
  }, 150);
}

async function loadSuggestions() {
  sugg = { areas: [], checks: [], fromMarkdown: [], loading: true };
  try { sugg = await api('/v1/team/suggestions', { spec }); } catch { sugg = { areas: [], checks: [], fromMarkdown: [] }; }
  if (mode === 'areas' || mode === 'checks') renderCanvas();
}

// Dragging a card onto another card makes it report there. Pointer events, so it works with touch too.
function wireCanvas() {
  const canvas = $('#canvas');
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('.node');
    if (!g || g.dataset.slug === 'owner' || !g.closest('svg')) return;
    drag = { slug: g.dataset.slug, g, x: e.clientX, y: e.clientY, moved: false, start: g.getAttribute('transform') };
    g.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    drag.g.classList.add('dragging');
    const [, x, y] = /translate\(([-\d.]+),([-\d.]+)\)/.exec(drag.start);
    drag.g.setAttribute('transform', `translate(${+x + dx / scale},${+y + dy / scale})`);
    for (const n of canvas.querySelectorAll('.node.drop')) n.classList.remove('drop');
    target(e)?.classList.add('drop');
  });
  const target = (e, d = drag) => {
    d.g.style.pointerEvents = 'none';
    const t = document.elementFromPoint(e.clientX, e.clientY)?.closest('.node');
    d.g.style.pointerEvents = '';
    return t && t !== d.g ? t : null;
  };
  canvas.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.moved) { pop = view.safety.hot.has(d.slug) ? d.slug : null; select(d.slug); return; }
    const t = target(e, d);
    if (t?.dataset.slug) setManager(d.slug, t.dataset.slug); else render();
  });
  canvas.addEventListener('click', (e) => { const b = e.target.closest('.tree-btn'); if (b) { select(b.dataset.slug); $('#inspector').scrollIntoView({ block: 'start' }); } });
  canvas.addEventListener('keydown', (e) => { const g = e.target.closest('.node'); if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(g.dataset.slug); } });
  // Dropping a role from the library: switch it on and put it under the card it lands on.
  canvas.addEventListener('dragover', (e) => { e.preventDefault(); for (const n of canvas.querySelectorAll('.node.drop')) n.classList.remove('drop'); e.target.closest?.('.node')?.classList.add('drop'); });
  canvas.addEventListener('drop', (e) => {
    e.preventDefault();
    const slug = e.dataTransfer.getData('text/x-role');
    const t = e.target.closest?.('.node');
    const system = e.dataTransfer.getData('text/x-system');
    if (system) { if (t && t.dataset.slug !== 'owner') { selected = t.dataset.slug; selectedSystem = null; bind(ctx, t.dataset.slug, system); render(); } return; }
    if (!slug) return;
    // A role from the catalog always adds a teammate (B1.2-2); dropped on a card, it reports there.
    addTeammate(slug, t?.dataset.slug);
  });
}

// ------------------------------------------------------------------------------------------------ library

/** The same state word as the card, on a library row (criterion 1). */
function libState(slug) {
  const row = view.safety.on && rowOf(board, slug);
  return row ? `<span class="state s-${esc(row.status)}${(row.age_s ?? 0) > QUIET_S ? ' quiet' : ''}">${esc(stateWord(row))}</span>` : '';
}

/**
 * The role catalog (B1.2): every role a teammate can be based on, by department, with "{n} on the team". A role never
 * leaves the catalog: dragging it (or pressing Enter on it) adds another teammate. The team's own roles come first;
 * the rest of the kit is under "Browse all roles…".
 */
function catalogRows() {
  const types = new Map();
  for (const r of view.all) {
    if (r.source === 'member' || r.source === 'missing') continue;
    const md = spec.roles[r.slug]?.brief ?? S.kit.roles[r.slug] ?? r.md;
    types.set(r.slug, { type: r.slug, title: titleOf(md, r.slug), group: field(md, 'Group').toLowerCase() || 'other', custom: isCustom(spec.roles[r.slug]), count: membersOf(spec, r.slug).length, used: r.enabled || membersOf(spec, r.slug, { enabledOnly: false }).length > 1 || (spec.layout?.exclude ?? []).includes(r.slug) });
  }
  return [...types.values()];
}

function renderLibrary() {
  const q = query.toLowerCase();
  const rows = catalogRows().filter((c) => !q || `${c.title} ${c.type} ${c.group}`.toLowerCase().includes(q));
  const byTitle = (a, b) => a.title.localeCompare(b.title);
  const order = (a, b) => ((GROUP_ORDER.indexOf(a) + 1 || 9) - (GROUP_ORDER.indexOf(b) + 1 || 9)) || a.localeCompare(b);
  const row = (c) => `<li><button type="button" class="lib-role cat-role${selected && typeOf(spec, selected) === c.type ? ' selected' : ''}" draggable="true" data-type="${esc(c.type)}" data-slug="${esc(c.type)}"${locked() ? ' aria-disabled="true"' : ''}
      aria-describedby="cat-how" data-tip="${esc(tip('role'))}">
      <span class="dot" data-paint="${groupColor(c.group)}" aria-hidden="true"></span><span class="name">${esc(c.title)}</span>${libState(c.type)}
      <span class="count${c.count ? '' : ' none'}">${esc(t('catalog.count', { n: c.count }))}</span>${c.custom ? `<span class="tag has-export">${esc(t('catalog.custom'))}</span>` : ''}</button>${c.custom ? `<button type="button" class="link export" data-export="${esc(c.type)}" aria-label="Export ${esc(c.title)} as a role pack" title="Export as a role pack">Export</button>` : ''}</li>`;
  const block = (list) => {
    const groups = new Map();
    for (const c of list) { if (!groups.has(c.group)) groups.set(c.group, []); groups.get(c.group).push(c); }
    return [...groups.keys()].sort(order).map((g) => `<h2 class="group-title" data-group="${esc(g)}"><span class="dot" data-paint="${groupColor(g)}" aria-hidden="true"></span>${esc(g)}</h2><ul class="plain cat-list">${groups.get(g).sort(byTitle).map(row).join('')}</ul>`).join('');
  };
  // While searching, everything that matches; otherwise the team's own roles, then the whole catalog folded.
  const ours = q ? rows : rows.filter((c) => c.used || c.custom);
  const rest = q ? [] : rows.filter((c) => !c.used && !c.custom);
  $('#library').innerHTML = (block(ours) + (rest.length ? `<details class="browse"${S.browseOpen ? ' open' : ''}><summary>${esc(t('catalog.browse'))}</summary>${block(rest)}</details>` : '')) || `<p class="muted">${esc(t('search.empty', { query }))}</p>`;
  paint($('#library'));
}

/** Adds a teammate with role `type`: the role's own seat when it is free (switched on), else "{Role} 2", "{Role} 3"… */
function addTeammate(type, manager) {
  if (locked()) return flash(lockedNote());
  let id = type;
  const own = spec.roles[type];
  const free = own && !own.enabled && membersOf(spec, type, { enabledOnly: false }).length === 1 && !(spec.layout?.exclude ?? []).includes(type);
  // A custom role with an error in its checks stays off until it is fixed (CPO story D2), however it is switched on.
  const why = free && isCustom(own) && switchOnRefusal(spec, S.kit, type);
  if (why) { render(); return flash(why); }
  change(() => {
    if (free) setEnabled(spec, type, true);
    else id = addMember(spec, S.kit, { type, ...(manager && manager !== 'owner' ? { reportsTo: manager } : {}) }).id;
    if (free && manager && manager !== 'owner') setExtField(type, 'Reports to', manager);
  });
  selected = id;
  render();
  announce(`${view.bySlug.get(id)?.title ?? id}: ${t('teammate.subtitle.ai', { role: view.bySlug.get(id)?.typeTitle ?? type })}`);
  return id;
}

const announce = (text) => note(text);

function wireLibrary() {
  $('#library').addEventListener('click', async (e) => {
    const out = e.target.closest('[data-export]');
    if (out) { e.preventDefault(); const said = await exportPack(spec, out.dataset.export); if (said !== 'cancelled') note(said); return; }
    // Pressing a role adds a teammate with it (the keyboard and screen-reader way to drag, B1.1-4), under the
    // teammate that is selected, or the team's lead. On a phone the team is read-only: it shows the role instead.
    const l = e.target.closest('.cat-role');
    if (!l) return;
    e.preventDefault();
    if (locked()) { const first = membersOf(spec, l.dataset.type)[0]; if (first) select(first); else flash(lockedNote()); if (small.matches) $('#inspector').scrollIntoView({ block: 'start' }); return; }
    const lead = view.team.find((r) => r.reportsTo === 'owner')?.slug;
    addTeammate(l.dataset.type, selected && spec.roles[selected]?.enabled ? selected : lead);
  });
  $('#library').addEventListener('dragstart', (e) => { const l = e.target.closest('.cat-role'); if (l) { e.dataTransfer.setData('text/x-role', l.dataset.type); e.dataTransfer.effectAllowed = 'copy'; } });
  $('#search').addEventListener('input', (e) => { query = e.target.value; renderLibrary(); });
  $('#new-agent').onclick = () => {
    if (locked()) return flash(lockedNote());
    openNewAgent({ spec: () => spec, kit: S.kit, kitVersion: S.kitVersion, roles: () => view.all, change, select, edit: openEditor });
  };
}

// ------------------------------------------------------------------------------------------------ inspector

/** "Now, on the live version": the role's work in flight, above its fields (change safety criterion 5). */
function nowOnLive(r) {
  const sf = view.safety;
  const row = sf.on && rowOf(board, r.slug);
  if (!row) return '';
  const hot = sf.hot.get(r.slug);
  return `<section class="now-live${hot ? ' amber' : ''}"><h2>Now, on the live version${sf.version ? ` (${esc(sf.version.split(',')[0])})` : ''}</h2>
    <ul>${inFlightList(row, spec, view.team.map((x) => ({ slug: x.slug, md: x.md })), r.slug).map((l) => `<li>${l}</li>`).join('')}</ul>
    ${hot ? `<p class="reason">${esc(hot.map(reasonOf).join(', '))}: you choose what happens to this work when you publish.</p>` : ''}
    ${row.self_reported ? '<p class="hint">Self-reported: no automatic reports from hooks, so this changes only when the role reports.</p>' : ''}
    <p class="hint">${esc(staleNote(sf.newest))}</p></section>`;
}

/** Switches one of the files sync writes for coding agents (other coding agents story, criterion 8). */
function setTarget(target, on) {
  change((sp) => {
    const next = TARGETS.filter((t) => (t === target ? on : teamTargets(sp.options).includes(t)));
    sp.options = { ...(sp.options ?? {}) };
    // Back to the default: no key, so the team's files are byte-identical to before (D45).
    if (next.join() === DEFAULT_TARGETS.join()) delete sp.options.targets; else sp.options.targets = next;
  });
}

/** The team's settings, read-only, when no role is picked (neutral protocols story criterion 5: no new choice yet). */
function teamHtml() {
  const v = spec.values ?? {};
  const from = spec.options?.from ? /^(.+)@(.*)$/.exec(spec.options.from) : null;
  const tpl = from && (S.templates ?? []).find((c) => c.id === from[1]);
  const rows = [
    ['Project', v.PROJECT_NAME], ['Owner', v.OWNER], ['Time zone', v.TIMEZONE], ['Kit', S.kitVersion],
    ['Shared rules', rulesLine(teamPacks(spec.options)).replace(/^Shared rules: /, '')],
    ...(from ? [['Started from', `${tpl?.title ?? from[1]}${from[2] ? ` (kit ${from[2]})` : ''}`]] : []),
  ].filter(([, x]) => x);
  return `<h2>Team</h2><dl class="team-facts">${rows.map(([k, x]) => `<dt>${esc(k)}</dt><dd>${esc(x)}</dd>`).join('')}</dl>
    <h2>Coding agents</h2>
    <label class="switch"><input type="checkbox" id="t-agents-md"${teamTargets(spec.options).includes('agents-md') ? ' checked' : ''}> Also keep AGENTS.md, for coding agents other than Claude Code</label>
    <p class="hint">Publish puts the team's instructions into AGENTS.md at the top of the repository. Text you added to that file yourself stays. Teammates working through those agents show "self-reported" on the board: without hooks, a card changes only when the role reports.</p>
    <p class="hint">Every team gets the core rules: one door for the owner's requests, the owner's words passed on unchanged, one owner per area, the four message kinds and the board. A team's template or preset adds the rest.</p>
    <p class="muted">Pick a role on the canvas or in the library.</p>`;
}

function renderInspector() {
  const el = $('#inspector');
  if (selectedSystem) return renderSystemInspector(el, ctx, selectedSystem);
  const r = selected && view.bySlug.get(selected);
  if (!r) {
    el.innerHTML = teamHtml();
    el.querySelector('#t-agents-md').onchange = (e) => setTarget('agents-md', e.target.checked);
    return;
  }
  const role = spec.roles[r.slug];
  const managers = view.team.filter((m) => m.slug !== r.slug && !under(r.slug, m.slug));
  const ownProject = role.brief !== undefined;
  // A teammate based on a role: the role's brief is the kit's (or the team's own role's), and the teammate's
  // changes sit on top of it as an extension, so kit upgrades still reach it (B1.3-8).
  const typeMd = spec.roles[r.type]?.brief ?? S.kit.roles[r.type];
  const kitMd = r.source === 'member' ? typeMd : S.kit.roles[r.slug];
  const seats = membersOf(spec, r.type).length;
  // B1.3-6: each field says whether it is the role's default or this team's change, with a reset.
  // A field is "your change" when this teammate's file sets it to something other than the role's own value.
  const own = (name) => { const f = (role.extension?.fields ?? []).find((x) => x.name === name); return !!f && f.value !== field(kitMd ?? '', name); };
  const mark = (name) => (ownProject && r.source !== 'member' ? '' : own(name)
    ? `<span class="fmark changed">${esc(t('inspector.changed'))}</span><button type="button" class="link" data-reset-field="${esc(name)}">${esc(t('inspector.reset'))}</button>`
    : `<span class="fmark">${esc(t('inspector.default'))}</span>`);
  const head = `<div class="teammate-head"><h2 class="flush">${esc(r.title)}</h2>
      ${r.title !== r.typeTitle ? `<p class="subtitle muted">${esc(r.typeTitle)}</p>` : ''}</div>
    ${nowOnLive(r)}
    <div class="field"><label for="i-name">${esc(t('inspector.name'))} ${infoButton(tip('teammate'), esc, t('inspector.name'))}</label><input id="i-name" maxlength="60" value="${esc(r.title)}" autocomplete="off" aria-describedby="i-name-msg"><span id="i-name-msg" class="field-msg" role="status"></span></div>
    <div class="field"><span>${esc(t('inspector.role'))} ${infoButton(tip('role'), esc, t('inspector.role'))}</span><span class="value">${esc(r.typeTitle)} <span class="muted">· ${esc(t('catalog.count', { n: seats }))}</span></span></div>
    <p class="row">${r.enabled ? '' : `<span class="pill off">${esc(t('canvas.off'))}</span>`}<button type="button" id="i-enabled" role="switch" aria-checked="${r.enabled}">${esc(r.enabled ? t('canvas.turnoff') : t('canvas.turnon'))}</button></p>
    <div class="field"><label for="i-manager">${esc(t('inspector.reportsto'))} ${mark('Reports to')}</label><button type="button" id="i-moveto" class="link" aria-controls="i-manager">${esc(t('canvas.moveto'))}</button><select id="i-manager">
      <option value="owner" ${r.reportsTo === 'owner' ? 'selected' : ''}>${esc(spec.values?.OWNER || 'The owner')}</option>
      ${managers.map((m) => `<option value="${m.slug}" ${m.slug === r.reportsTo ? 'selected' : ''}>${esc(m.title)}</option>`).join('')}</select></div>
    <div class="field"><label for="i-tier">${esc(t('inspector.model'))} ${mark('Model')}</label><select id="i-tier">${TIERS.map((x) => `<option ${x === r.tier ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
    <div class="field"><label for="i-pool">${esc(t('inspector.hands'))} ${infoButton(tip('control.same.job.more.hands'), esc, t('inspector.hands'))} ${mark('Pool')}</label><input id="i-pool" type="number" min="1" max="10" step="1" value="${Number.isInteger(r.pool) ? r.pool : 1}" inputmode="numeric"></div>
    <p class="row"><button type="button" id="i-wiring" class="primary">${esc(t('teammate.openwiring'))}</button></p>
    <p class="row"><button type="button" id="i-another" data-tip="${esc(tip('control.add.another.set.up.differently'))}">${esc(t('inspector.another'))}</button>${ownProject || (spec.roles[r.type]?.brief !== undefined) ? `<button type="button" id="i-editjob" data-type="${esc(r.type)}" data-tip="${esc(tip('control.edit.the.job.description'))}">${esc(t('inspector.editjob'))}</button>` : ''}</p>
    <p id="i-editjob-warn" class="notice warn" role="alert" hidden>${esc(t('inspector.editjob.warn', { n: seats }))} <button type="button" class="link" id="i-editjob-go">${esc(t('inspector.editjob'))}</button></p>
    <label class="row"><input type="checkbox" id="i-dormant" ${r.dormant ? 'checked' : ''}> Dormant until a request needs it</label>
    <p class="hint advanced">Id: <code>${esc(r.slug)}</code></p>`;
  let body;
  if (ownProject && small.matches) {
    body = `<p class="notice">Open the Studio on a larger screen to edit this agent.</p>`;
  } else if (ownProject) {
    body = `<p class="row"><button type="button" id="i-export">Export as a role pack</button></p>`;
  } else {
    const sections = splitBrief(kitMd).sections.filter((s) => !/^## every thread/i.test(s.heading));
    const mine = new Map((role.extension?.sections ?? []).map((s) => [s.name.toLowerCase(), s]));
    body = `<div class="row between"><h2>What it does</h2>${r.changed ? '<button id="i-reset" type="button">Reset to kit</button>' : ''}</div>` +
      sections.map((s) => {
        const name = s.heading.replace(/^##\s+/, '');
        const shown = name.replace(/\s*\(writes\)$/i, ''); // "Owns (writes)" reads as "Owns" (ALL-5)
        const m = mine.get(name.toLowerCase());
        // B1.3-3: Rules is where an owner adds a rule, so it starts open.
        return `<details class="section"${m || /^rules$/i.test(shown) ? ' open' : ''}><summary>${esc(shown)}${m ? `<span class="badge changed">${esc(t('inspector.changed'))} · ${m.mode === 'replace' ? 'replaced' : 'added to'}</span>` : ''}</summary>
          <div class="kit-text">${esc(s.body.join('\n').trim())}</div>
          <div class="field"><span>Your text</span><textarea data-section="${esc(name)}" aria-label="${esc(shown)}: your text" rows="3" placeholder="Added after the kit's text">${esc(m?.text ?? '')}</textarea></div>
          <label class="row hint"><input type="checkbox" data-replace="${esc(name)}" ${m?.mode === 'replace' ? 'checked' : ''}> Replace the kit's text instead of adding to it</label></details>`;
      }).join('');
  }
  el.innerHTML = head + (r.enabled ? roleSystemsHtml(ctx, r.slug) : '') + body;
  wireBindings(el, ctx);
  $('#i-enabled').onclick = () => switchRole(r.slug, !r.enabled);
  $('#i-tier').onchange = (e) => change(() => setExtField(r.slug, 'Model', r.model.replace(/^[a-z]+/i, e.target.value) || e.target.value));
  $('#i-manager').onchange = (e) => setManager(r.slug, e.target.value);
  // B1.1-4: the keyboard and screen-reader way to drag a card onto another.
  $('#i-moveto').onclick = () => { const m = $('#i-manager'); m.focus(); try { m.showPicker?.(); } catch { /* not every browser opens it */ } };
  const name = $('#i-name');
  name.onchange = () => {
    const v = name.value;
    try { const probe = JSON.parse(JSON.stringify(spec)); setDisplayName(probe, r.slug, v, S.kit); } catch (err) {
      $('#i-name-msg').textContent = err.status === 409 ? t('teammate.dupname', { name: err.message.replace(/^Another teammate is already called /, '') }) : err.message;
      name.setAttribute('aria-invalid', 'true'); return;
    }
    name.removeAttribute('aria-invalid');
    change(() => setDisplayName(spec, r.slug, v, S.kit));
  };
  $('#i-pool').onchange = (e) => { const n = Math.max(1, Math.min(10, Math.round(+e.target.value || 1))); change(() => setExtField(r.slug, 'Pool', n === 1 ? '' : String(n))); };
  $('#i-another').onclick = () => addTeammate(r.type, r.reportsTo);
  $('#i-wiring').onclick = () => openWiring(r.slug);
  const job = $('#i-editjob');
  // B1.3-5: the job description is the role's, shared by every teammate based on it, so say so before opening it.
  if (job) job.onclick = () => { if (seats > 1) { $('#i-editjob-warn').hidden = false; $('#i-editjob-go').focus(); } else openEditor(r.type); };
  const go = $('#i-editjob-go');
  if (go) go.onclick = () => openEditor(r.type);
  for (const b of el.querySelectorAll('[data-reset-field]')) b.onclick = () => change(() => { const e2 = spec.roles[r.slug].extension; e2.fields = e2.fields.filter((f) => f.name !== b.dataset.resetField || (r.source === 'member' && f.name === 'Based on')); });
  $('#i-dormant').onchange = (e) => change(() => setExtField(r.slug, 'Status', e.target.checked ? `dormant until the owner or the lane's executive opens it for a request.` : 'active'));
  const reset = $('#i-reset');
  // A teammate based on a role keeps what makes it a seat (its role, manager and name); the rest goes back to the role's.
  if (reset) reset.onclick = () => change(() => { const x = spec.roles[r.slug]; if (x.source === 'member') x.extension = { ...x.extension, sections: [{ name: 'Owns (writes)', mode: 'replace', text: 'Nothing yet.' }] }; else delete x.extension; });
  const out = $('#i-export');
  if (out) out.onclick = async () => { const said = await exportPack(spec, r.slug); if (said !== 'cancelled') note(said); };
  const brief = $('#i-brief');
  if (brief) brief.onchange = (e) => change(() => { spec.roles[r.slug].brief = e.target.value; });
  for (const ta of el.querySelectorAll('textarea[data-section]')) {
    ta.onchange = () => { const name = ta.dataset.section; const replace = el.querySelector(`input[data-replace="${CSS.escape(name)}"]`).checked; change(() => setExtSection(r.slug, name, replace ? 'replace' : 'append', ta.value)); };
  }
  for (const cb of el.querySelectorAll('input[data-replace]')) {
    cb.onchange = () => { const name = cb.dataset.replace; const ta = el.querySelector(`textarea[data-section="${CSS.escape(name)}"]`); if (ta.value.trim()) change(() => setExtSection(r.slug, name, cb.checked ? 'replace' : 'append', ta.value)); };
  }
}

/** The top bar's "N changes · M touch work in progress" and the draft banner (change safety criteria 2 and 6). */
function renderSafety() {
  const sf = view.safety;
  const m = [...sf.hot.values()].reduce((n, l) => n + l.length, 0);
  const pill = $('#impact-pill');
  pill.hidden = !m;
  pill.textContent = `${sf.changes.length} change${sf.changes.length === 1 ? '' : 's'} · ${m} touch${m === 1 ? 'es' : ''} work in progress`;
  const banner = $('#draft-banner');
  banner.hidden = !(sf.on && sf.changes.length);
  banner.textContent = `Editing a draft. The team keeps running the live version${sf.version ? ` (${sf.version})` : ''} until you publish.${m ? ' Amber: your change touches that role\'s current work.' : ''}`;
}

/** The explanation by an amber card (criterion 4), placed next to it on the canvas. */
function renderPopover() {
  $('#canvas').querySelector('.impact-pop')?.remove();
  const items = pop && view.safety.hot.get(pop);
  const card = items && $('#canvas').querySelector(`.node[data-slug="${CSS.escape(pop)}"]`);
  if (!card) { pop = null; return; }
  const r = view.bySlug.get(pop);
  const html = popoverHtml({ slug: pop, title: r?.title ?? pop, items, row: rowOf(board, pop), spec, roles: view.team.map((x) => ({ slug: x.slug, md: x.md })), newest: view.safety.newest });
  const canvas = $('#canvas');
  canvas.insertAdjacentHTML('beforeend', html);
  const el = canvas.querySelector('.impact-pop');
  const c = card.getBoundingClientRect(), b = canvas.getBoundingClientRect();
  el.style.left = `${Math.min(c.right - b.left + canvas.scrollLeft + 10, canvas.scrollWidth - 340)}px`;
  // Flip up when it would run past the bottom of the visible canvas, then bring it into view.
  const top = c.top - b.top + canvas.scrollTop;
  const up = c.bottom - b.top + canvas.scrollTop - el.offsetHeight;
  const bottom = Math.min(b.bottom, window.innerHeight);
  el.style.top = `${Math.max(0, c.top + el.offsetHeight > bottom && up >= 0 ? up : top)}px`;
}

/** Criterion 11: an area published to move after its open work merges needs one more publish; until then, a reminder. */
function reminders() {
  const writer = (sp, path) => (sp?.ownership?.rows ?? []).find((r) => r.path === path)?.writer;
  followUps = followUps.filter((f) => writer(published, f.path) === f.from && writer(spec, f.path) === f.to);
  return followUps.map((f) => ({ level: 'warning', where: 'ownership', message: `${f.path} moves from ${f.from} to ${f.to} after ${f.pr ? `PR #${f.pr} merges` : 'its current work is done'}. Publish again then, so it has one writer.` }));
}

function renderIssues() {
  renderSafety();
  const list = [...view.issues, ...reminders()];
  const errors = list.filter((i) => i.level === 'error').length;
  const pill = $('#checks');
  pill.className = `pill ${errors ? 'error' : 'ok'}`;
  pill.textContent = errors ? `${errors} error${errors > 1 ? 's' : ''}, ${list.length - errors} warnings` : `No problems${list.length ? ` · ${list.length} warnings` : ''}`;
  const looks = view.looks.map((l) => `<li class="warning look" data-where="roles/${esc(l.slug)}"><button type="button" class="link" data-look="${esc(l.slug)}">${esc(l.text)}</button></li>`).join('');
  $('#issues').innerHTML = looks + (list.length ? list.map((i) => `<li class="${i.level}" data-where="${esc(i.where)}"><strong>${i.level}</strong> · ${esc(i.where)}: ${esc(i.message)}</li>`).join('') : looks ? '' : '<li class="none">No problems.</li>');
}

let flashTimer = null;
function flash(text) {
  const pill = $('#checks');
  pill.className = 'pill error';
  pill.textContent = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(renderIssues, 3500);
}

/** A short confirmation in the checks pill, in the ok colour. */
function note(text) {
  const pill = $('#checks');
  pill.className = 'pill ok';
  pill.textContent = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(renderIssues, 5000);
}

/** Switches a role on or off. A custom agent with an error in its checks stays off until it is fixed (CPO story D2). */
function switchRole(slug, on) {
  const why = on && isCustom(spec.roles[slug]) && switchOnRefusal(spec, S.kit, slug);
  if (why) { render(); return flash(why); }
  change(() => setEnabled(spec, slug, on));
}

function setMode(m) {
  mode = m;
  if (m !== 'systems') selectedSystem = null;
  if (m === 'areas' || m === 'checks') sugg = null; // fresh suggestions for the current team
  render();
}

function select(slug) { selected = slug; selectedSystem = null; render(); }

/** Opens a custom agent in the editor. `origin` ({ from, title, md }) is the role a copy started from. */
function openEditor(slug, origin) {
  editor ??= createAgentEditor($('#agent-editor'), {
    spec: () => spec, kit: S.kit, roles: () => view.all, team: () => view.team,
    // A switched-off agent is checked as if it were on, so the editor shows what stands between it and the team.
    issues: () => (spec.roles[editor.slug]?.enabled ? view.issues : checksOf({ ...spec, roles: { ...spec.roles, [editor.slug]: { ...spec.roles[editor.slug], enabled: true } } })),
    change, ctx, api,
    close: () => { editor.close(); render(); },
    setOn: (s) => { switchRole(s, true); },
  });
  selected = slug;
  view = derive();
  editor.open(slug, origin);
  render();
}

function render() {
  view = derive();
  if (stateEl().dataset.page === 'meetings') { renderIssues(); syncUndo(); meetings?.render(); return; }
  if (editor?.slug) { renderLibrary(); renderIssues(); syncUndo(); editor.draw(); return; }
  renderCanvas();
  renderLibrary();
  renderInspector();
  renderIssues();
  $('#undo').disabled = !undo.length;
  $('#redo').disabled = !redo.length;
  // Read-only: nothing that changes the team works, but looking does (the wiring view, the info buttons).
  if (locked()) for (const el of $$('#inspector :is(input, select, textarea, button):not(#i-wiring, .info), #library input')) el.disabled = true;
  renderTemplateBar();
}

// ------------------------------------------------------------------------------------------------ publish

/** A line diff with three lines of context (LCS; fine for files of a few hundred lines). */
function diff(a, b) {
  const x = (a ?? '').split('\n'), y = (b ?? '').split('\n');
  if (x.length * y.length > 4_000_000) return '<span class="gap">(large change; open the file after publishing)</span>';
  const n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { ops.push([' ', x[i]]); i++; j++; }
    else if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) { ops.push(['+', y[j]]); j++; }
    else { ops.push(['-', x[i]]); i++; }
  }
  const keep = ops.map((o, k) => o[0] !== ' ' || ops.slice(Math.max(0, k - 3), k + 4).some((p) => p[0] !== ' '));
  let out = '', gap = false;
  ops.forEach((o, k) => {
    if (!keep[k]) { if (!gap) out += '<span class="gap">…</span>\n'; gap = true; return; }
    gap = false;
    out += o[0] === '+' ? `<span class="add">+ ${esc(o[1])}</span>\n` : o[0] === '-' ? `<span class="del">- ${esc(o[1])}</span>\n` : `  ${esc(o[1])}\n`;
  });
  return out;
}

/** The Studio API (env.js): the data, or an Error with the server's reason, its status and its type (409 stale…). */
async function api(path, body) {
  // The handler reads the team at the commit the page read (embed spec 4): preview, suggestions and publish send it.
  if (body && S?.git?.head?.sha && /^\/v1\/team\/(preview|suggestions|publish)$/.test(path)) body = { base: S.git.head.sha, ...body };
  const { res, data } = await ours(async () => {
    const res = await requestJson(path, body);
    let data = {};
    try { data = await res.json(); } catch { /* not JSON */ }
    return { res, data };
  });
  if (!res.ok) throw Object.assign(new Error(env.embedded && res.status === 401 ? 'You are not signed in to this site any more. Sign in again, then reopen this page.' : data.error ?? data.title ?? (res.statusText || `HTTP ${res.status}`)), { status: res.status, type: data.type });
  return data;
}

/**
 * Runs `work` for the mount that started it. If the Studio was destroyed (or destroyed and mounted again, as React
 * StrictMode and quick route changes do) before it settles, its result or error never comes back: the caller simply
 * stops, and nothing it would have done touches the new mount's page.
 */
async function ours(work) {
  const mine = life;
  let out, failed = false, error;
  try { out = await work(); } catch (e) { failed = true; error = e; }
  if (life !== mine || !mine) return new Promise(() => {});
  if (failed) throw error;
  return out;
}

/** The roles on in the draft, for hand-off targets (criterion 10: never one that is off). */
const onRoles = () => view.team.map((r) => ({ slug: r.slug, title: r.title }));
// A deep link straight to the Rollout page arrives before anything has rendered the team, so build it here if needed.
const roleTitle = (slug) => (view ??= derive()).bySlug.get(slug)?.title ?? slug;
/** The rollout page reads the board and the repository through the local Studio's server; an embedded Studio has neither yet. */
const rolloutOn = () => !env.embedded && feature('live', S.features);
const managerOfRole = (slug) => view.bySlug.get(slug)?.reportsTo ?? '';

/** The impact step and the commit message it adds (criteria 8 and 9). */
/** The role that takes the owner's requests: the one that reports to the owner, when there is exactly one. */
function dispatcher() {
  const top = view.team.filter((r) => r.reportsTo === 'owner');
  return top.length === 1 ? top[0].title.toLowerCase() : '';
}

function renderImpact() {
  const items = view.safety.on ? view.safety.items : [];
  for (const id of [...picks.keys()]) if (!items.some((i) => i.id === id)) picks.delete(id);
  const rec = recommendations(items, spec, onRoles(), managerOfRole);
  for (const [id, p] of rec) if (!picks.has(id)) picks.set(id, p);
  $('#impact').innerHTML = impactHtml({ items, picks, on: onRoles(), titleOf: roleTitle, board, newest: view.safety.newest, spec, roles: view.team.map((x) => ({ slug: x.slug, md: x.md })), dispatcher: dispatcher() });
  const plan = planText(items, picks, roleTitle, dispatcher());
  $('#plan').hidden = !plan;
  $('#plan').innerHTML = plan ? `<details open><summary>Commit message: Work in progress</summary><pre>${esc(plan)}</pre></details>` : '';
  return plan;
}

function wireImpact() {
  const box = $('#impact');
  box.addEventListener('change', (e) => {
    const r = e.target.closest('[data-pick]');
    const t = e.target.closest('[data-target]');
    if (r) { const p = picks.get(r.dataset.pick) ?? {}; picks.set(r.dataset.pick, { ...p, choice: r.value }); }
    if (t) { const p = picks.get(t.dataset.target) ?? {}; picks.set(t.dataset.target, { ...p, target: t.value }); }
    if (r || t) { renderImpact(); previewPublish(); }
  });
  box.addEventListener('click', (e) => {
    if (e.target.id !== 'impact-recommend') return;
    picks = recommendations(view.safety.items, spec, onRoles(), managerOfRole);
    renderImpact();
    previewPublish();
  });
}

/** The file review, of what will be published: a deferred move keeps its writer in these files (criterion 11). */
async function previewPublish() {
  try {
    const { spec: out } = publishable(spec, published, view.safety.on ? view.safety.items : [], picks);
    const { changes, issues, needsCode } = await api('/v1/team/preview', { spec: out });
    const errors = issues.filter((i) => i.level === 'error');
    // Mounted in a host that publishes through the team's deployment: a change to the commands the team runs is
    // published from the deployment's own Studio, never through the host (embed spec section 6).
    const elsewhere = needsCode && S.features?.publishCode === false;
    $('#confirm').disabled = !changes.length || errors.length > 0 || elsewhere;
    $('#changes').innerHTML = errors.length ? `<p class="result error pad">Fix ${errors.length} error${errors.length > 1 ? 's' : ''} before publishing.</p>` :
      changes.length ? changes.map((c) => `<details><summary><span class="st ${c.status}">${c.status}</span>${esc(c.path)}</summary><pre class="diff">${diff(c.before, c.after)}</pre></details>`).join('')
        : '<p class="muted pad">Nothing to publish: the repository already has this team.</p>';
    if (elsewhere && !errors.length) {
      const note = document.createElement('p');
      note.className = 'result pad';
      note.textContent = 'This change adds or changes commands the team runs, so it is published from the team\'s own Studio, not from this site. ';
      if (/^https:\/\//.test(S.features.studio ?? '')) {
        const a = document.createElement('a');
        a.href = S.features.studio; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = 'Use the deployment\'s Studio';
        note.append(a, '.');
      }
      $('#changes').prepend(note);
    }
  } catch (e) {
    $('#changes').innerHTML = `<p class="result error pad">${esc(e.message)}</p>`;
    $('#confirm').disabled = true;
  }
}

async function openPublish() {
  if (locked()) return flash(lockedNote());
  const dlg = $('#publish-dialog');
  $('#publish-result').textContent = '';
  $('#publish-result').className = 'result';
  $('#changes').innerHTML = '<p class="muted pad">Working out what changes…</p>';
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  $('#branch').value ||= `agent-team/publish-${stamp}`;
  $('#message').value ||= 'Update the agent team (Agent Team Studio)';
  renderImpact();
  dlg.showModal();
  await previewPublish();
}

async function confirmPublish() {
  const out = $('#publish-result');
  $('#confirm').disabled = true;
  out.className = 'result';
  out.textContent = 'Publishing…';
  try {
    const items = view.safety.on ? view.safety.items : [];
    const plan = renderImpact();
    const { spec: toPublish, deferred } = publishable(spec, published, items, picks);
    const draft = spec;
    const message = plan ? `${$('#message').value.trim()}\n\n${plan}` : $('#message').value;
    const r = await api('/v1/team/publish', { spec: toPublish, branch: $('#branch').value.trim(), message });
    out.className = 'result ok';
    if (r.pr?.url && /^https:\/\//.test(r.pr.url)) {
      // Mounted in a host (and gh locally): the pull request is open. The link is set through the DOM, never markup.
      out.textContent = `Opened a pull request for ${r.files.length} file${r.files.length === 1 ? '' : 's'} on ${r.branch}: `;
      const a = document.createElement('a');
      a.href = r.pr.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = r.pr.number ? `#${r.pr.number}` : r.pr.url;
      out.append(a, '. Review and merge it as usual.');
    } else out.textContent = r.commit ? `Committed ${r.commit} on ${r.branch} (${r.files.length} files). Push it and open a pull request: git push -u origin ${r.branch}` : r.branch ? `Nothing changed on ${r.branch}.` : 'Nothing changed: the repository already has this team.';
    const fresh = await api('/v1/team');
    const wasNew = !!S.noTeam;
    S = fresh;
    published = structuredClone(fresh.spec);
    // The first publish of a new team: from here on it is the repository's team, with its board.
    if (wasNew) { made = null; stateEl().classList.remove('no-team'); loadBoard(); }
    // A deferred move stays in the draft, so the next publish carries it; the checks remind until then (criterion 11).
    spec = deferred.length ? draft : fresh.spec;
    followUps = [...followUps.filter((f) => !deferred.some((d) => d.path === f.path)), ...deferred];
    saveFollowUps();
    picks = new Map();
    undo.length = 0; redo.length = 0;
    sugg = null;
    render();
  } catch (e) {
    out.className = 'result error';
    out.textContent = e.type === 'stale' ? 'The team changed in the repository since this page read it. Reload the page to get the latest, then publish again; your changes here are not kept.' : e.message;
    $('#confirm').disabled = e.type === 'stale';
  }
}

// ------------------------------------------------------------------------------------------------ start

/**
 * A page and what to show on it: "chat?card=ID", "chat?budget", "team?role=SLUG", "meetings?id=ID". The links in
 * emails and Slack messages (kit #101: /teams/{team}/inbox?card=…, /budget, /board?role=…, /meetings/{id}) arrive
 * here as these, through linkHash.
 */
export function parsePage(raw) {
  const [page, q = ''] = String(raw ?? '').split('?');
  return { page, params: new URLSearchParams(q) };
}

/** The page shown: in the URL's hash locally, here when the Studio is mounted in a host page (urlState false). */
let page = 'team';
const pageFromUrl = () => (env.urlState ? location.hash.slice(1) : page);
/** Says where the Studio is: the hash locally, onNavigate to the host otherwise. Never both. */
function showPage(p) {
  const was = page;
  page = p;
  if (env.urlState) {
    const want = p === 'team' || p === 'gallery' ? '' : `#${p}`;
    if (location.hash !== want) history.replaceState(null, '', want || location.pathname + location.search);
  } else if (was !== p) {
    try { env.onNavigate?.(p); } catch { /* the host's callback */ }
  }
}

async function setPage(raw) {
  if (!spec) return showGallery();
  const { page: asked, params } = parsePage(raw);
  const p = (asked === 'meetings' || (asked === 'chat' && !S.noTeam && feature('chat', S.features)) || (asked === 'rollout' && !S.noTeam && rolloutOn())) && !previewing ? asked : 'team';
  if (meetings?.dirty && stateEl().dataset.page === 'meetings' && p !== 'meetings' && !(await ask('Discard the changes to this meeting?', { ok: 'Discard', cancel: 'Keep editing' }))) { if (env.urlState) history.replaceState(null, '', '#meetings'); return; }
  stateEl().dataset.page = p;
  for (const b of $$('#pages [data-page]')) { b.setAttribute('aria-pressed', String(b.dataset.page === p)); if (b.dataset.page === p) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
  $('#more-btn')?.classList.toggle('current', p === 'meetings' || p === 'rollout');
  // ALL-3: one h1 per screen, the page's name (the gallery has its own).
  const title = $(`#pages [data-page="${p}"]`)?.textContent.trim();
  if (title && $('#page-title')) $('#page-title').textContent = title;
  closeMore();
  if (p !== 'rollout') rolloutView?.close();
  if (p === 'rollout') {
    rolloutView ??= createRollout({ root: $('#rollout-page'), titleOf: roleTitle, apiUrl });
    rolloutView.open();
  } else if (p === 'chat') {
    chat ??= createChat({ root: $('#chat-page'), runs: feature('runs', S.features) });
    if (params.has('card') || params.has('budget')) chat.focus({ card: params.get('card'), budget: params.has('budget') });
    chat.open();
  } else {
    if (p === 'meetings') meetings ??= createMeetings({ root: $('#meetings-page'), ctx: meetingsCtx });
    const role = params.get('role');
    if (p === 'team' && role && spec.roles?.[role]) { selected = role; selectedSystem = null; }
    wiring = p === 'team' && params.get('wiring') && spec.roles?.[params.get('wiring')] ? params.get('wiring') : null;
    if (wiring) selected = wiring;
    render();
    if (p === 'team' && role && !spec.roles?.[role]) flash('That role is not on this team any more.');
    const shown = p === 'meetings' && params.get('id') ? meetings.show(params.get('id')) : 'shown';
    if (shown === 'missing') flash('That meeting is not in this team any more.');
    if (shown === 'dirty') flash('Save or cancel the meeting you are editing, then open the link again.');
  }
  showPage(p === 'team' && wiring ? `team?wiring=${encodeURIComponent(wiring)}` : p);
}

function closeMore() { const m = $('#more-menu'); if (m && !m.hidden) { m.hidden = true; $('#more-btn').setAttribute('aria-expanded', 'false'); } }

/** What the Meetings view reads from the team and how it edits the draft. */
const meetingsCtx = {
  spec: () => spec,
  team: () => view.team,
  resolved: () => resolveSpec(spec, S.kit).roles,
  change: (fn) => change(fn, { quiet: true }),
  prices: () => prices,
  small: () => small.matches,
  dailyCapUsd: () => spec.options?.budgets?.dailyUsd,
  timezone: () => spec.values?.TIMEZONE || 'UTC',
};

/** What the host turned off, and what the server does not offer, as classes the stylesheet hides by. */
function applyFeatures() {
  for (const f of ['publish', 'chat', 'runs', 'live']) stateEl().classList.toggle(`no-${f}`, !feature(f, S.features));
  stateEl().classList.toggle('no-rollout', !rolloutOn());
}

/** The view a failed start shows, inside the Studio's own root (never the host's body). */
function fatal(message) {
  env.root.innerHTML = `<main class="fatal"><h1>Agent Team Studio</h1><p role="alert"></p></main>`;
  env.root.querySelector('.fatal p').textContent = message;
}

async function start() {
  try {
    S = await api('/v1/team');
  } catch (e) {
    fatal(e.status === 503 ? `${e.message}. Ask whoever runs this site to connect it.` : e.message);
    return;
  }
  applyFeatures();
  // Next to this module wherever it is served: /model-prices.json locally, /assets/<kit version>/ in a host.
  ours(() => fetch(new URL('./model-prices.json', import.meta.url)).then((r) => (r.ok ? r.json() : null))).then((t) => { prices = t; if (stateEl()?.dataset.page === 'meetings') meetings?.render(); }).catch(() => {});
  small.addEventListener('change', () => { stateEl().classList.toggle('small', small.matches); if (spec) render(); }, { signal: life.signal });
  stateEl().classList.toggle('small', small.matches);
  wireTemplates();
  if (S.noTeam) return showGallery();
  load(S.spec);
  setPage(initialPage ?? pageFromUrl());
}

// ------------------------------------------------------------------------------------------------ mount

let life = null; // AbortController for every listener outside the root; null when not mounted
let initialPage = null;
let boardStream = null;

/**
 * Mounts the Studio in `el` (docs/specs/studio-embed.md section 4). One Studio per page.
 *   api, headers, features, embedded, urlState, onNavigate: see env.js. page: the page to open first ('chat?card=…').
 * Returns { destroy(), navigate(page) }.
 */
export function mount(el, opts = {}) {
  if (!el || typeof el.append !== 'function') throw new Error('AgentTeamStudio.mount needs an element');
  if (life) throw new Error('the Studio is already mounted on this page; destroy() it first');
  configure({ ...opts, root: el });
  life = new AbortController();
  initialPage = typeof opts.page === 'string' ? opts.page : null;
  el.classList.add('ats');
  if (env.embedded) el.classList.add('ats-embedded');
  el.innerHTML = SHELL;
  installTips(el, life.signal);
  start();
  return {
    destroy,
    /** Opens a page, as a link would ('team', 'meetings', 'chat?card=ID', 'team?role=SLUG'). */
    navigate: (raw) => (spec ? setPage(String(raw ?? '')) : undefined),
  };
}

/** Takes the Studio off the page: its listeners, streams and markup. The element is left as it was given. */
function destroy() {
  if (!life) return;
  life.abort();
  life = null;
  boardStream?.close(); boardStream = null;
  live?.es?.close(); live = null;
  chat?.close?.();
  rolloutView?.close();
  clearTimeout(flashTimer); clearTimeout(flowTimer); flowTimer = null;
  const el = env.root;
  el.innerHTML = '';
  el.classList.remove('ats', 'ats-embedded', 'small', 'no-team', 'previewing', 'editing', 'no-publish', 'no-chat', 'no-runs', 'no-live', 'no-rollout');
  delete el.dataset.page; delete el.dataset.mode;
  S = spec = selected = selectedSystem = view = sugg = chat = rolloutView = meetings = editor = gallery = previewing = made = published = board = pop = null;
  query = ''; undo.length = 0; redo.length = 0; zoom = 'fit'; mode = 'org'; scale = 1; page = 'team'; initialPage = null;
  flow = { key: '', edges: [], unresolved: [] }; picks = new Map(); followUps = []; booted = false; lastEdit = { key: '', at: 0 };
}

// ------------------------------------------------------------------------------------------------ templates

/** The gallery: a repository with no team starts here (templates story D32). */
function showGallery() {
  previewing = null;
  stateEl().classList.remove('previewing');
  stateEl().classList.add('no-team');
  stateEl().dataset.page = 'gallery';
  $('#project').textContent = `${where()}${S.git?.branch ? ` · ${S.git.branch}` : ''}`;
  gallery ??= createGallery({ root: $('#gallery-page'), ctx: { cards: () => S.templates ?? [], groups: () => S.groups ?? {}, onPick: pickTemplate, onAlmostEmpty: () => useTemplate('almost-empty') } });
  gallery.render();
  showPage('gallery');
}

const cardOf = (id) => (S.templates ?? []).find((c) => c.id === id) ?? null;

/** A template on the real canvas, read-only, with its lists in the bar above (D31). Nothing is written. */
async function pickTemplate(id) {
  try {
    const { spec: sp } = await api('/v1/team/from-template', { id });
    previewing = cardOf(id);
    stateEl().classList.add('previewing');
    load(sp);
    selected = null;
    setPage('team');
  } catch (e) { flash(e.message); }
}

/** "Use this template": the create form, then the team as an unpublished draft (D31, criterion 7). */
function useTemplate(id) {
  if (small.matches) return flash('Create the team on a larger screen.');
  const card = id === 'almost-empty' ? null : cardOf(id);
  const dlg = $('#create-dialog');
  const folder = where().split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  let zone = 'UTC';
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { /* keep UTC */ }
  $('#create-title').textContent = card ? `Use the ${card.title} template` : 'Start almost empty';
  $('#create-what').textContent = card ? `${rolesLine(card)}. You can change everything before you publish.` : 'A chief of staff only. Add roles from the library before you publish.';
  $('#c-project').value = folder;
  $('#c-owner').value = '';
  $('#c-zone').value = zone;
  $('#create-result').textContent = '';
  dlg.dataset.template = id;
  dlg.showModal();
  $('#c-project').focus();
}

async function createTeam() {
  const dlg = $('#create-dialog');
  const zone = $('#c-zone').value.trim() || 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); } catch { $('#create-result').textContent = `"${zone}" is not a time zone this browser knows, for example Europe/Lisbon or America/New_York.`; return; }
  const project = $('#c-project').value.trim();
  if (!project) { $('#create-result').textContent = 'Give the project a name.'; return; }
  try {
    const id = dlg.dataset.template;
    const { spec: sp } = await api('/v1/team/from-template', { id, project, owner: $('#c-owner').value.trim() || undefined, timezone: zone });
    made = id === 'almost-empty' ? null : cardOf(id);
    previewing = null;
    stateEl().classList.remove('previewing');
    dlg.close();
    load(sp);
    selected = null;
    setPage('team');
  } catch (e) { $('#create-result').textContent = e.message; }
}

/** The bar above the canvas while previewing a template, and the note on a team that is not published yet. */
function renderTemplateBar() {
  const bar = $('#template-bar');
  if (previewing) {
    const c = previewing;
    // Reporting order: whoever reports to the owner first, then their reports, level by level.
    const depth = (slug) => { let d = 0; for (let m = view.bySlug.get(slug)?.reportsTo; m && m !== 'owner' && view.bySlug.has(m) && d < 20; m = view.bySlug.get(m).reportsTo) d++; return d; };
    const byOrder = (list) => list.map((s) => ({ s, d: depth(s), t: view.bySlug.get(s)?.title ?? s })).sort((x, y) => x.d - y.d || x.t.localeCompare(y.t)).map((x) => x.t);
    const meetingsLine = (c.meetings ?? []).map((m) => `${m.title} (${m.when.replace(/`/g, '')})`).join(', ');
    bar.hidden = false;
    bar.innerHTML = `<div class="tb-text"><strong>Preview: ${esc(c.title)}</strong> <span class="muted">${esc(rolesLine(c))}</span>
      <dl>
        <div><dt>Roles that start on</dt><dd>${esc(byOrder(c.roles.filter((s) => !c.dormant.includes(s))).join(', '))}</dd></div>
        ${c.dormant.length ? `<div><dt>Dormant until you start them</dt><dd>${esc(byOrder(c.dormant).join(', '))}</dd></div>` : ''}
        <div><dt>Shared rules</dt><dd>${esc(rulesLine(c.packs).replace(/^Shared rules: /, ''))}</dd></div>
        ${c.systems.length ? `<div><dt>Systems to connect</dt><dd>${esc(c.systems.map((s) => s.name).join(', '))}</dd></div>` : ''}
        ${meetingsLine ? `<div><dt>Starter meetings</dt><dd>${esc(meetingsLine)}</dd></div>` : ''}
      </dl></div>
      <div class="tb-actions"><button type="button" id="tb-back">Back to the starting teams</button>${small.matches ? '<span class="hint">Create the team on a larger screen.</span>' : `<button type="button" id="tb-use" class="primary" data-template="${esc(c.id)}">Use this template</button>`}</div>`;
    return;
  }
  if (S.noTeam) {
    bar.hidden = false;
    bar.innerHTML = `<div class="tb-text"><strong>${made ? `A new team from the ${esc(made.title)} template.` : 'A new team.'}</strong> <span class="muted">Nothing is written to the repository until you publish.</span></div>
      <div class="tb-actions"><button type="button" id="tb-back">Start over</button></div>`;
    return;
  }
  bar.hidden = true;
}

function wireTemplates() {
  $('#template-bar').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'tb-use') return useTemplate(b.dataset.template);
    if (b.id === 'tb-back') {
      return (async () => {
        if (!previewing && undo.length && !(await ask('Discard this team? Nothing has been written yet.', { ok: 'Discard', cancel: 'Keep it', danger: true }))) return;
        made = null;
        spec = null;
        showGallery();
      })();
    }
  });
  $('#create-form').addEventListener('submit', (e) => { e.preventDefault(); createTeam(); });
  $('#create-cancel').onclick = () => $('#create-dialog').close();
}

/** Opens a team in the editor: the repository's, a template preview, or a new draft. Wires the page once. */
function load(initial) {
  spec = initial;
  published = structuredClone(initial);
  undo.length = 0; redo.length = 0;
  sugg = null; selected = null; selectedSystem = null; pop = null; picks = new Map();
  stateEl().classList.toggle('no-team', !!S.noTeam);
  $('#project').textContent = `${spec.values?.PROJECT_NAME ?? ''} · ${where()}${S.git?.branch ? ` · ${S.git.branch}` : ''}`;
  if (booted) return;
  booted = true;
  loadFollowUps();
  // A move published to happen after its open work merges lives on in the draft, even across a reload or a restart.
  for (const f of followUps) reapplyFollowUp(spec, f);
  wireImpact();
  if (!S.noTeam && feature('live', S.features)) {
    loadBoard();
    try { boardStream = new EventSource(apiUrl('/v1/team/board/stream')); boardStream.addEventListener('changed', loadBoard); } catch { /* no stream: the first read stands */ }
  }
  wireCanvas();
  wireLibrary();
  $('#zoom-in').onclick = () => { zoom = Math.min(1.5, scale + 0.1); renderCanvas(); };
  $('#zoom-out').onclick = () => { zoom = Math.max(0.3, scale - 0.1); renderCanvas(); };
  $('#zoom-fit').onclick = () => { zoom = zoom === 'fit' ? 1 : 'fit'; renderCanvas(); };
  addEventListener('resize', () => zoom === 'fit' && renderCanvas(), { signal: life.signal });
  $('#undo').onclick = () => step(undo, redo);
  $('#redo').onclick = () => step(redo, undo);
  $('#publish').onclick = openPublish;
  $('#impact-pill').onclick = openPublish;
  $('#canvas').addEventListener('click', (e) => {
    const b = e.target.closest('.impact-pop [data-pop]');
    if (!b) return;
    e.stopPropagation();
    const slug = b.closest('.impact-pop').dataset.slug;
    if (b.dataset.pop === 'close') { pop = null; return renderPopover(); }
    if (b.dataset.pop === 'review') { pop = null; renderPopover(); return openPublish(); }
    const item = view.safety.hot.get(slug)?.find((i) => i.id === b.dataset.item);
    if (item) { change((sp) => revert(sp, published, item)); pop = null; render(); }
  });
  $('#canvas').addEventListener('pointerdown', (e) => { if (e.target.closest('.impact-pop')) e.stopPropagation(); }, true);
  // Back to the team's settings (QA of #119): a click on the canvas's empty space or on the owner, or Escape.
  $('#canvas').addEventListener('click', (e) => {
    if (e.target.closest('.impact-pop, button, a, input')) return;
    const n = e.target.closest('.node');
    if ((!n || n.dataset.slug === 'owner') && (selected || selectedSystem)) select(null);
  });
  $('#live').onclick = toggleLive;
  $('#confirm').onclick = confirmPublish;
  $('#issues').addEventListener('click', (e) => {
    const w = e.target.closest('li')?.dataset.where ?? '';
    const m = /^roles\/(.+?)(\.extend\.md)?$/.exec(w);
    if (m && view.bySlug.has(m[1])) return select(m[1]);
    const to = /^ownership/.test(w) ? 'areas' : /^gates/.test(w) ? 'checks' : /^(resources|bindings)/.test(w) ? 'systems' : null;
    if (to) setMode(to);
    const r = /^resources\/(.+)$/.exec(w);
    if (r) ctx.selectSystem(r[1]);
  });
  $('#views').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) setMode(b.dataset.view); });
  $('#pages').addEventListener('click', (e) => {
    if (e.target.closest('#more-btn')) { const m = $('#more-menu'); const show = m.hidden; m.hidden = !show; $('#more-btn').setAttribute('aria-expanded', String(show)); if (show) m.querySelector('button')?.focus(); return; }
    const b = e.target.closest('[data-page]'); if (b) setPage(b.dataset.page);
  });
  $('#pages').addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#more-menu').hidden) { closeMore(); $('#more-btn').focus(); } });
  env.root.addEventListener('click', (e) => { if (!e.target.closest('.more-wrap')) closeMore(); });
  if (env.urlState) addEventListener('hashchange', () => setPage(location.hash.slice(1)), { signal: life.signal });
  // Keys only when the Studio has focus or nothing does: a host page's own fields keep their Ctrl+Z.
  document.addEventListener('keydown', (e) => {
    if (env.embedded && !env.root.contains(document.activeElement) && document.activeElement !== document.body) return;
    if (e.key === 'Escape' && (selected || selectedSystem) && !$('dialog[open]') && $('#agent-editor').hidden && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return select(null);
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    e.preventDefault();
    if (e.shiftKey) step(redo, undo); else step(undo, redo);
  }, { signal: life.signal });
}
