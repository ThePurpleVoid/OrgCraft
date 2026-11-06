// Agent Team Studio, the editor. Plain ES modules, no build step. The team is one TeamSpec (packages/team-model),
// edited here and checked live with the kit's own rules; the server only reads, previews and publishes.
import { checkUpgrade, resolveSpec, setEnabled, setField, splitBrief, validate } from './team-model.mjs';
import { createChat } from './chat.js';
import { exportPack, imported, isCustom, openNewAgent, switchOnRefusal } from './agents.js';
import { createAgentEditor } from './agent-editor.js';
import { QUIET_S, assess, impactHtml, inFlightList, planText, popoverHtml, publishable, reasonOf, recommendations, revert, rowOf, staleNote, stateWord, taskOf } from './safety.js';
import { bind, renderAreas, renderChecks, renderSystemInspector, renderSystemsStrip, roleSystemsHtml, wireBindings } from './panels.js';

const $ = (s) => document.querySelector(s);
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
let flow = { key: '', edges: [], unresolved: [] }; // hand-offs, from the server, for the spec they were made from
let sugg = null; // owned area and check suggestions from the repository
let scale = 1;
let live = null; // { on, source, where, board, error, es } when the live board is shown
let chat = null; // the chief-of-staff chat, made the first time it is opened
let editor = null; // the custom agent editor (agent-editor.js)
let lastEdit = { key: '', at: 0 }; // typing in one field folds into one undo step
// Change safety part 1: the team as last published (what is running), the board, and the open popover.
let published = null;
let board = null; // summarize() output from /v1/team/board, kept fresh by its stream; null until read
let pop = null; // the slug whose in-flight popover is open
let picks = new Map(); // impact step: item id -> { choice, target } (criteria 8 and 10)
let followUps = []; // areas published with "move after merge": [{ path, from, to, pr }] (criterion 11)
const followKey = () => `agent-team-followups:${S?.root ?? ''}`;
function saveFollowUps() { try { localStorage.setItem(followKey(), JSON.stringify(followUps)); } catch { /* private mode: this session only */ } }
function loadFollowUps() { try { followUps = JSON.parse(localStorage.getItem(followKey()) ?? '[]'); } catch { followUps = []; } }
/** Phones get the control room (chat, live board) and a read-only team: building the team needs a large screen. */
const small = matchMedia('(max-width: 640px)');

// ------------------------------------------------------------------------------------------------ model

function derive() {
  const { roles } = resolveSpec(spec, S.kit);
  const bySlug = new Map(roles.map((r) => [r.slug, r]));
  const info = (slug) => {
    const r = spec.roles[slug];
    const md = bySlug.get(slug)?.md ?? r.brief ?? S.kit.roles[slug] ?? '';
    const model = field(md, 'Model');
    return {
      slug, md, enabled: r.enabled, source: r.source,
      title: titleOf(md, slug), model, tier: (/^[a-z]+/i.exec(model)?.[0] ?? '').toLowerCase(),
      group: field(md, 'Group').toLowerCase() || 'other',
      reportsTo: (field(md, 'Reports to').split(/\s/)[0] ?? '').toLowerCase(),
      dormant: /^dormant/i.test(field(md, 'Status')),
      changed: !!(r.extension && ((r.extension.fields ?? []).length || (r.extension.sections ?? []).length || r.extension.title)),
    };
  };
  const all = Object.keys(spec.roles).sort().map(info);
  const safety = assess({ published, draft: spec, kit: S.kit, board, head: S.git?.head });
  return { all, bySlug: new Map(all.map((r) => [r.slug, r])), team: all.filter((r) => r.enabled && bySlug.has(r.slug)), issues: checksOf(spec), safety };
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
  if (small.matches) { flash('Editing the team needs a larger screen'); render(); return; }
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
  if (r.brief !== undefined && !r.extension) return setField(spec, slug, name, value);
  const e = ext(slug);
  const kitValue = field(S.kit.roles[slug] ?? r.brief, name);
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

function liveLine(l) {
  if (!l) return 'no reports yet';
  const what = l.waiting_on ? `${l.status} on ${l.waiting_on}` : l.status;
  return `${what}${l.stale ? ' (quiet)' : ''}${l.task ? ` · ${l.task}` : ''}`;
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
  const tier = three ? (hot ? reasonOf(hot[0]) : [r.tier, r.dormant ? 'dormant' : replaces ? 'replaces kit' : ''].filter(Boolean).join(' · '))
    : l !== undefined ? liveLine(l) : mode === 'systems' ? systemsLine(r.slug) : r.tier ? `${r.tier}${r.dormant ? ' · dormant' : ''}${replaces ? ' · replaces kit' : ''}` : '';
  const state = three ? (own ? [stateWord(own), taskOf(own)].filter(Boolean).join(' · ') : '') : '';
  const flag = view.issues.some((i) => i.level === 'error' && i.where === `roles/${r.slug}`) ? ' ⚠' : r.changed ? ' •' : '';
  const tip = three && own ? `${r.title}: ${stateWord(own)}${taskOf(own) ? ` · ${taskOf(own)}` : ''}${own.branch ? ` · branch ${own.branch}` : ''}${own.pr ? ` · PR #${own.pr}` : ''}${hot ? ` · ${hot.map(reasonOf).join(', ')}` : ''}` : '';
  return `<g class="node${r.slug === selected ? ' selected' : ''}${r.dormant ? ' dormant' : ''}${extra}" data-slug="${r.slug}" transform="translate(${p.x},${p.y})" tabindex="0" role="button" aria-label="${esc(r.title)}${hot ? `, ${esc(hot.map(reasonOf).join(', '))}, work in progress` : ''}">
    <rect class="card" width="${W}" height="${H}"></rect>
    <rect class="stripe" width="4" height="${H - 16}" x="8" y="8" fill="${groupColor(r.group)}"></rect>
    <text class="title" x="20" y="23">${esc(r.title.length > 21 ? r.title.slice(0, 20) + '…' : r.title)}${flag}</text>
    <text class="meta" x="20" y="41">${esc(tier.length > 28 ? tier.slice(0, 27) + '…' : tier)}</text>
    ${three ? `${state ? `<circle class="dot" cx="24" cy="${H - 15}" r="4"></circle><text class="state" x="33" y="${H - 11}">${esc(state.length > 25 ? state.slice(0, 24) + '…' : state)}</text>` : ''}${tip ? `<title>${esc(tip)}</title>` : ''}`
    : `${replaces && !l ? `<title>${esc(view.issues.find((i) => i.where === `roles/${r.slug}` && /replaces the kit/.test(i.message))?.message ?? 'Replaces the kit role of this name on this team')}</title>` : ''}
    ${l ? `<circle class="dot" cx="${W - 14}" cy="16" r="5"></circle>${l.threads > 1 ? `<text class="threads" x="${W - 24}" y="20" text-anchor="end">${l.threads}</text>` : ''}<title>${esc(`${r.title}: ${liveLine(l)}${l.pr ? ` · PR #${l.pr}` : ''}${l.issue ? ` · issue #${l.issue}` : ''}`)}</title>` : ''}`}
  </g>`;
}

function renderCanvas() {
  const canvasMode = ['org', 'flow', 'systems'].includes(mode);
  document.body.dataset.mode = mode;
  for (const b of document.querySelectorAll('#views [data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === mode));
  $('#summary').textContent = `${view.team.length} roles on · ${view.all.length - view.team.length} off · kit ${S.kitVersion}`;
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
    const r = await fetch('/v1/team/board');
    const body = await r.json();
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
    const r = await fetch('/v1/team/board');
    const body = await r.json();
    Object.assign(live, { source: body.source, where: body.where, board: body.board ?? null, error: r.ok ? null : body.error });
  } catch (e) { live.error = e.message; }
  if (live.on) renderCanvas();
}

function toggleLive() {
  if (live?.on) { live.es?.close(); live = null; }
  else {
    live = { on: true, board: null, error: null };
    live.es = new EventSource('/v1/team/board/stream');
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
    if (t) setManager(slug, t.dataset.slug);
    else { change(() => setEnabled(spec, slug, true)); selected = slug; render(); }
  });
}

// ------------------------------------------------------------------------------------------------ library

/** The same state word as the card, on a library row (criterion 1). */
function libState(slug) {
  const row = view.safety.on && rowOf(board, slug);
  return row ? `<span class="state s-${esc(row.status)}${(row.age_s ?? 0) > QUIET_S ? ' quiet' : ''}">${esc(stateWord(row))}</span>` : '';
}

function renderLibrary() {
  const q = query.toLowerCase();
  const groups = new Map();
  const mine = [];
  for (const r of view.all) {
    if (q && !`${r.title} ${r.slug} ${r.group}`.toLowerCase().includes(q)) continue;
    if (isCustom(spec.roles[r.slug])) { mine.push(r); continue; }
    if (!groups.has(r.group)) groups.set(r.group, []);
    groups.get(r.group).push(r);
  }
  const row = (r) => `<label class="lib-role${r.slug === selected ? ' selected' : ''}" draggable="true" data-slug="${r.slug}">
      <input type="checkbox" ${r.enabled ? 'checked' : ''} data-toggle="${r.slug}" aria-label="${r.enabled ? 'Switch off' : 'Switch on'} ${esc(r.title)}">
      <span class="name">${esc(r.title)}</span>${libState(r.slug)}<span class="tag${isCustom(spec.roles[r.slug]) ? ' has-export' : ''}">${r.source === 'project-replaces-kit' ? 'replaces kit' : imported.has(r.slug) ? 'imported' : isCustom(spec.roles[r.slug]) ? 'custom' : r.source === 'kit' ? '' : 'yours'}${r.dormant ? ' dormant' : ''}</span>${isCustom(spec.roles[r.slug]) ? `<button type="button" class="link export" data-export="${r.slug}" aria-label="Export ${esc(r.title)} as a role pack" title="Export as a role pack">Export</button>` : ''}</label>`;
  const byTitle = (a, b) => a.title.localeCompare(b.title);
  const keys = [...groups.keys()].sort((a, b) => ((GROUP_ORDER.indexOf(a) + 1 || 9) - (GROUP_ORDER.indexOf(b) + 1 || 9)) || a.localeCompare(b));
  // Your agents: the custom roles on this team, on or off (PRD 6.6 A6), each still in its own group's colour.
  const yours = mine.length ? `<div class="group-title yours"><span class="dot" style="background:var(--warn)"></span>Your agents</div>` +
    mine.sort(byTitle).map((r) => row(r).replace('<span class="name">', `<span class="dot" style="background:${groupColor(r.group)}" title="${esc(r.group)}"></span><span class="name">`)).join('') : '';
  // A group only custom agents use (a new one, D8) gets its own section in its colour, like a kit group, listing its
  // agents again (criterion 13). These rows open the agent; switching it on or off stays in Your agents.
  const kitGroups = new Set(view.all.filter((r) => !isCustom(spec.roles[r.slug])).map((r) => r.group));
  const fresh = [...new Set(mine.map((r) => r.group))].filter((g) => g && !kitGroups.has(g));
  const ref = (r) => `<button type="button" class="lib-ref${r.slug === selected ? ' selected' : ''}" data-slug="${esc(r.slug)}" draggable="true"><span class="name">${esc(r.title)}</span><span class="tag">${imported.has(r.slug) ? 'imported' : 'custom'}${r.enabled ? '' : ' · off'}${r.dormant ? ' · dormant' : ''}</span></button>`;
  const section = (g) => (groups.has(g)
    ? `<div class="group-title"><span class="dot" style="background:${groupColor(g)}"></span>${esc(g)}</div>` + groups.get(g).sort(byTitle).map(row).join('')
    : `<div class="group-title" data-group="${esc(g)}"><span class="dot" style="background:${groupColor(g)}"></span>${esc(g)}</div>` + mine.filter((r) => r.group === g).sort(byTitle).map(ref).join(''));
  const order = [...keys, ...fresh].sort((a, b) => ((GROUP_ORDER.indexOf(a) + 1 || 9) - (GROUP_ORDER.indexOf(b) + 1 || 9)) || a.localeCompare(b));
  $('#library').innerHTML = (yours + order.map(section).join('')) || '<p class="muted">No roles match.</p>';
}

function wireLibrary() {
  $('#library').addEventListener('change', (e) => {
    const slug = e.target.dataset.toggle;
    if (slug) switchRole(slug, e.target.checked);
  });
  $('#library').addEventListener('click', async (e) => {
    const out = e.target.closest('[data-export]');
    if (out) { e.preventDefault(); const said = await exportPack(spec, out.dataset.export); if (said !== 'cancelled') note(said); return; }
    const l = e.target.closest('.lib-role, .lib-ref');
    if (l && !e.target.dataset.toggle) {
      e.preventDefault();
      // A custom agent opens in its editor (on a large screen); any other role in the inspector.
      if (isCustom(spec.roles[l.dataset.slug]) && !small.matches) return openEditor(l.dataset.slug);
      select(l.dataset.slug);
      // On a phone the inspector sits below the canvas: bring it into view, or the tap seems to do nothing.
      if (small.matches) $('#inspector').scrollIntoView({ block: 'start' });
    }
  });
  $('#library').addEventListener('dragstart', (e) => { const l = e.target.closest('.lib-role, .lib-ref'); if (l) { e.dataTransfer.setData('text/x-role', l.dataset.slug); e.dataTransfer.effectAllowed = 'copy'; } });
  $('#search').addEventListener('input', (e) => { query = e.target.value; renderLibrary(); });
  $('#new-agent').onclick = () => {
    if (small.matches) return flash('Editing the team needs a larger screen');
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
    <p class="hint">${esc(staleNote(sf.newest))}</p></section>`;
}

function renderInspector() {
  const el = $('#inspector');
  if (selectedSystem) return renderSystemInspector(el, ctx, selectedSystem);
  const r = selected && view.bySlug.get(selected);
  if (!r) { el.innerHTML = '<p class="muted">Pick a role on the canvas or in the library.</p>'; return; }
  const role = spec.roles[r.slug];
  const managers = view.team.filter((m) => m.slug !== r.slug && !under(r.slug, m.slug));
  const ownProject = role.brief !== undefined;
  const kitMd = S.kit.roles[r.slug];
  const head = `<div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(r.title)}</h2>
      <span class="badge${r.changed ? ' changed' : ''}">${ownProject ? 'your role' : r.changed ? 'kit role, changed' : 'kit role'}</span></div>
    <p class="muted"><code>${esc(r.slug)}</code></p>
    ${nowOnLive(r)}
    <label class="row"><input type="checkbox" id="i-enabled" style="width:auto" ${r.enabled ? 'checked' : ''}> On this team</label>
    <div class="field"><span>Model tier</span><select id="i-tier">${TIERS.map((t) => `<option ${t === r.tier ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
    <div class="field"><span>Reports to</span><select id="i-manager">
      <option value="owner" ${r.reportsTo === 'owner' ? 'selected' : ''}>The owner</option>
      ${managers.map((m) => `<option value="${m.slug}" ${m.slug === r.reportsTo ? 'selected' : ''}>${esc(m.title)}</option>`).join('')}</select></div>
    <label class="row"><input type="checkbox" id="i-dormant" style="width:auto" ${r.dormant ? 'checked' : ''}> Dormant until a request needs it</label>`;
  let body;
  if (ownProject && small.matches) {
    body = `<p class="notice">Open the Studio on a larger screen to edit this agent.</p>`;
  } else if (ownProject) {
    body = `<p class="row"><button type="button" id="i-edit" class="primary">Edit this agent</button><button type="button" id="i-export">Export as a role pack</button></p>`;
  } else {
    const sections = splitBrief(kitMd).sections.filter((s) => !/^## every thread/i.test(s.heading));
    const mine = new Map((role.extension?.sections ?? []).map((s) => [s.name.toLowerCase(), s]));
    body = `<div class="row" style="justify-content:space-between"><h2>What it does</h2>${r.changed ? '<button id="i-reset" type="button">Reset to kit</button>' : ''}</div>` +
      sections.map((s) => {
        const name = s.heading.replace(/^##\s+/, '');
        const m = mine.get(name.toLowerCase());
        return `<details class="section"${m ? ' open' : ''}><summary>${esc(name)}${m ? `<span class="badge changed">${m.mode === 'replace' ? 'replaced' : 'added to'}</span>` : ''}</summary>
          <div class="kit-text">${esc(s.body.join('\n').trim())}</div>
          <div class="field"><span>Your text</span><textarea data-section="${esc(name)}" rows="3" placeholder="Added after the kit's text">${esc(m?.text ?? '')}</textarea></div>
          <label class="row hint"><input type="checkbox" data-replace="${esc(name)}" style="width:auto" ${m?.mode === 'replace' ? 'checked' : ''}> Replace the kit's text instead of adding to it</label></details>`;
      }).join('');
  }
  el.innerHTML = head + (r.enabled ? roleSystemsHtml(ctx, r.slug) : '') + body;
  wireBindings(el, ctx);
  $('#i-enabled').onchange = (e) => switchRole(r.slug, e.target.checked);
  $('#i-tier').onchange = (e) => change(() => setExtField(r.slug, 'Model', r.model.replace(/^[a-z]+/i, e.target.value) || e.target.value));
  $('#i-manager').onchange = (e) => setManager(r.slug, e.target.value);
  $('#i-dormant').onchange = (e) => change(() => setExtField(r.slug, 'Status', e.target.checked ? `dormant until the owner or the lane's executive opens it for a request.` : 'active'));
  const reset = $('#i-reset');
  if (reset) reset.onclick = () => change(() => { delete spec.roles[r.slug].extension; });
  const ed = $('#i-edit');
  if (ed) ed.onclick = () => openEditor(r.slug);
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
  $('#issues').innerHTML = list.length ? list.map((i) => `<li class="${i.level}" data-where="${esc(i.where)}"><strong>${i.level}</strong> · ${esc(i.where)}: ${esc(i.message)}</li>`).join('') : '<li class="none">No problems.</li>';
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
  if (editor?.slug) { renderLibrary(); renderIssues(); syncUndo(); editor.draw(); return; }
  renderCanvas();
  renderLibrary();
  renderInspector();
  renderIssues();
  $('#undo').disabled = !undo.length;
  $('#redo').disabled = !redo.length;
  if (small.matches) for (const el of document.querySelectorAll('#inspector :is(input, select, textarea, button), #library input')) el.disabled = true;
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

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

/** The roles on in the draft, for hand-off targets (criterion 10: never one that is off). */
const onRoles = () => view.team.map((r) => ({ slug: r.slug, title: r.title }));
const roleTitle = (slug) => view.bySlug.get(slug)?.title ?? slug;

/** The impact step and the commit message it adds (criteria 8 and 9). */
function renderImpact() {
  const items = view.safety.on ? view.safety.items : [];
  for (const id of [...picks.keys()]) if (!items.some((i) => i.id === id)) picks.delete(id);
  const rec = recommendations(items, spec, onRoles());
  for (const [id, p] of rec) if (!picks.has(id)) picks.set(id, p);
  $('#impact').innerHTML = impactHtml({ items, picks, on: onRoles(), titleOf: roleTitle, board, newest: view.safety.newest, spec, roles: view.team.map((x) => ({ slug: x.slug, md: x.md })) });
  const plan = planText(items, picks, roleTitle);
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
    picks = recommendations(view.safety.items, spec, onRoles());
    renderImpact();
    previewPublish();
  });
}

/** The file review, of what will be published: a deferred move keeps its writer in these files (criterion 11). */
async function previewPublish() {
  try {
    const { spec: out } = publishable(spec, published, view.safety.on ? view.safety.items : [], picks);
    const { changes, issues } = await api('/v1/team/preview', { spec: out });
    const errors = issues.filter((i) => i.level === 'error');
    $('#confirm').disabled = !changes.length || errors.length > 0;
    $('#changes').innerHTML = errors.length ? `<p class="result error" style="padding:10px">Fix ${errors.length} error${errors.length > 1 ? 's' : ''} before publishing.</p>` :
      changes.length ? changes.map((c) => `<details><summary><span class="st ${c.status}">${c.status}</span>${esc(c.path)}</summary><pre class="diff">${diff(c.before, c.after)}</pre></details>`).join('')
        : '<p class="muted" style="padding:10px">Nothing to publish: the repository already has this team.</p>';
  } catch (e) {
    $('#changes').innerHTML = `<p class="result error" style="padding:10px">${esc(e.message)}</p>`;
    $('#confirm').disabled = true;
  }
}

async function openPublish() {
  const dlg = $('#publish-dialog');
  $('#publish-result').textContent = '';
  $('#publish-result').className = 'result';
  $('#changes').innerHTML = '<p class="muted" style="padding:10px">Working out what changes…</p>';
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
    out.textContent = r.commit ? `Committed ${r.commit} on ${r.branch} (${r.files.length} files). Push it and open a pull request: git push -u origin ${r.branch}` : `Nothing changed on ${r.branch}.`;
    const fresh = await api('/v1/team');
    S = fresh;
    published = structuredClone(fresh.spec);
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
    out.textContent = e.message;
    $('#confirm').disabled = false;
  }
}

// ------------------------------------------------------------------------------------------------ start

function setPage(page) {
  const p = page === 'chat' ? 'chat' : 'team';
  document.body.dataset.page = p;
  for (const b of document.querySelectorAll('#pages [data-page]')) b.setAttribute('aria-pressed', String(b.dataset.page === p));
  if (p === 'chat') { chat ??= createChat({ root: $('#chat-page') }); chat.open(); }
  else render();
  if (location.hash !== `#${p}`) history.replaceState(null, '', p === 'team' ? location.pathname : '#chat');
}

async function start() {
  try {
    S = await api('/v1/team');
  } catch (e) {
    document.body.innerHTML = `<main style="padding:24px"><h1>Agent Team Studio</h1><p>${esc(e.message)}</p></main>`;
    return;
  }
  spec = S.spec;
  published = structuredClone(S.spec);
  loadFollowUps();
  wireImpact();
  loadBoard();
  try { new EventSource('/v1/team/board/stream').addEventListener('changed', loadBoard); } catch { /* no stream: the first read stands */ }
  $('#project').textContent = `${spec.values?.PROJECT_NAME ?? ''} · ${S.root}${S.git.branch ? ` · ${S.git.branch}` : ''}`;
  wireCanvas();
  wireLibrary();
  $('#zoom-in').onclick = () => { zoom = Math.min(1.5, scale + 0.1); renderCanvas(); };
  $('#zoom-out').onclick = () => { zoom = Math.max(0.3, scale - 0.1); renderCanvas(); };
  $('#zoom-fit').onclick = () => { zoom = zoom === 'fit' ? 1 : 'fit'; renderCanvas(); };
  addEventListener('resize', () => zoom === 'fit' && renderCanvas());
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
  $('#live').onclick = toggleLive;
  $('#confirm').onclick = confirmPublish;
  $('#issues').addEventListener('click', (e) => {
    const w = e.target.closest('li')?.dataset.where ?? '';
    const m = /^roles\/(.+)$/.exec(w);
    if (m && view.bySlug.has(m[1])) return select(m[1]);
    const to = /^ownership/.test(w) ? 'areas' : /^gates/.test(w) ? 'checks' : /^(resources|bindings)/.test(w) ? 'systems' : null;
    if (to) setMode(to);
    const r = /^resources\/(.+)$/.exec(w);
    if (r) ctx.selectSystem(r[1]);
  });
  $('#views').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) setMode(b.dataset.view); });
  $('#pages').addEventListener('click', (e) => { const b = e.target.closest('[data-page]'); if (b) setPage(b.dataset.page); });
  addEventListener('hashchange', () => setPage(location.hash.slice(1)));
  small.addEventListener('change', () => { document.body.classList.toggle('small', small.matches); render(); });
  document.body.classList.toggle('small', small.matches);
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    e.preventDefault();
    if (e.shiftKey) step(redo, undo); else step(undo, redo);
  });
  render();
  setPage(location.hash.slice(1));
}

start();
