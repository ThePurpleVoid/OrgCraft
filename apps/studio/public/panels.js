// The Studio's data panels: systems (and who may use them), owned areas and checks. Each edits one part of the
// TeamSpec through ctx.change, so undo, redo and the live checks work the same as on the canvas.
//
// ctx: { spec(), change(fn), render(), team (roles on the team, from derive), esc, api(path, body), selectSystem(id), selectRole(slug) }

import { t, tip } from './i18n.js';
import { LEVELS } from './wiring.js';

export const SYSTEM_TYPES = [
  ['repository', 'Repository'], ['database', 'Database'], ['backend', 'Backend or API'], ['hosting', 'Frontend hosting'],
  ['observability', 'Monitoring'], ['mcp', 'Any MCP server'], ['other', 'Other'],
];
export const PERMS = ['read', 'write', 'deploy'];
export const defaultPermission = (type) => (type === 'hosting' ? 'deploy' : type === 'observability' ? 'read' : 'write');
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'system';
const typeName = (t) => SYSTEM_TYPES.find(([k]) => k === t)?.[1] ?? t;

// ------------------------------------------------------------------------------------------------ systems

/** The strip above the canvas in the Systems view: one chip per system, dragged onto roles to grant access. */
export function renderSystemsStrip(el, ctx, selectedSystem) {
  const { esc } = ctx;
  const res = ctx.spec().resources?.resources ?? [];
  const bindings = ctx.spec().resources?.bindings ?? [];
  const suggested = ctx.spec().canvas?.suggestedSystems ?? [];
  el.innerHTML = `${res.map((r) => `<button type="button" class="chip${r.id === selectedSystem ? ' selected' : ''}" draggable="true" data-system="${esc(r.id)}" title="Drag onto a role to let it use ${esc(r.name)}">
      <span class="chip-type">${esc(typeName(r.type))}</span> ${esc(r.name || r.id)} <span class="muted">${bindings.filter((b) => b.resource === r.id).length}</span></button>`).join('')}
    ${suggested.map((x, i) => `<button type="button" class="chip suggested" data-connect="${i}" title="Suggested by the template. Connect it to add it to the team."><span class="chip-type">${esc(typeName(systemType(x.type)))}</span> ${esc(x.name)} <span class="muted">to connect</span></button>`).join('')}
    <button type="button" class="chip add" id="add-system">+ Add a system</button>
    <span class="hint">${suggested.length ? 'Dashed: suggested by the template, with nothing set. Click one to connect it.' : res.length ? 'Drag a system onto a role to let it use it.' : 'Add the systems your team works with: repositories, databases, hosting, any MCP server.'}</span>`;
  el.onclick = (e) => {
    if (e.target.closest('#add-system')) return addSystem(ctx);
    const sug = e.target.closest('[data-connect]');
    if (sug) return connectSuggested(ctx, Number(sug.dataset.connect));
    const chip = e.target.closest('[data-system]');
    if (chip) ctx.selectSystem(chip.dataset.system);
  };
  el.ondragstart = (e) => { const chip = e.target.closest('[data-system]'); if (chip) { e.dataTransfer.setData('text/x-system', chip.dataset.system); e.dataTransfer.effectAllowed = 'link'; } };
}

/** A template's system types, in the Studio's words: a type the Studio has no word for is "Other", by its name. */
const TYPE_WORDS = { github: 'repository', gitlab: 'repository', git: 'repository', postgres: 'database', mysql: 'database', supabase: 'database', vercel: 'hosting', netlify: 'hosting', website: 'hosting', sentry: 'observability' };
export const systemType = (t) => (SYSTEM_TYPES.some(([k]) => k === t) ? t : TYPE_WORDS[t] ?? 'other');

/**
 * Connects a system the template suggested (templates story criterion 10): it becomes an ordinary system, with the
 * roles the template named allowed to use it, and leaves the suggestions. Settings and secrets stay empty.
 */
export function connectSuggested(ctx, i) {
  const x = ctx.spec().canvas?.suggestedSystems?.[i];
  if (!x) return;
  const taken = new Set((ctx.spec().resources?.resources ?? []).map((r) => r.id));
  const base = slugify(x.name) || 'system';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  const type = systemType(x.type);
  const on = new Set(ctx.team.map((r) => r.slug));
  ctx.change((s) => {
    s.resources ??= { resources: [], bindings: [] };
    s.resources.resources ??= [];
    s.resources.bindings ??= [];
    s.resources.resources.push({ id, type, name: x.name, config: {}, secrets: [] });
    for (const role of x.for ?? []) if (on.has(role)) s.resources.bindings.push({ role, resource: id, permission: defaultPermission(type) });
    s.canvas.suggestedSystems.splice(i, 1);
    if (!s.canvas.suggestedSystems.length) delete s.canvas.suggestedSystems;
  });
  ctx.selectSystem(id);
}

function addSystem(ctx) {
  const taken = new Set((ctx.spec().resources?.resources ?? []).map((r) => r.id));
  let id = 'system';
  for (let i = 2; taken.has(id); i++) id = `system-${i}`;
  ctx.change((spec) => {
    spec.resources ??= { resources: [], bindings: [] };
    spec.resources.resources ??= [];
    spec.resources.bindings ??= [];
    spec.resources.resources.push({ id, type: 'database', name: 'New system', config: {}, secrets: [] });
  });
  ctx.selectSystem(id);
}

/** Lets `role` use `resource`; a second drop of the same pair keeps the existing permission. */
export function bind(ctx, role, resource) {
  const spec = ctx.spec();
  const r = spec.resources?.resources?.find((x) => x.id === resource);
  if (!r) return;
  if (spec.resources.bindings?.some((b) => b.role === role && b.resource === resource)) return;
  ctx.change((s) => { s.resources.bindings ??= []; s.resources.bindings.push({ role, resource, permission: defaultPermission(r.type) }); });
}

/** The inspector for one system: what it is, its settings, the names of its secrets, and who may use it. */
export function renderSystemInspector(el, ctx, id) {
  const { esc } = ctx;
  const spec = ctx.spec();
  const r = spec.resources?.resources?.find((x) => x.id === id);
  if (!r) { el.innerHTML = '<p class="muted">That system was removed.</p>'; return; }
  const bound = (spec.resources.bindings ?? []).filter((b) => b.resource === id);
  const config = Object.entries(r.config ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');
  el.innerHTML = `<div class="row between"><h2 class="flush">${esc(r.name || r.id)}</h2><span class="badge">system</span></div>
    <div class="field"><span>Name</span><input id="s-name" value="${esc(r.name)}"></div>
    <div class="field"><span>Id (how roles and files refer to it)</span><input id="s-id" value="${esc(r.id)}" pattern="[a-z0-9-]+"></div>
    <div class="field"><span>Type</span><select id="s-type">${SYSTEM_TYPES.map(([k, v]) => `<option value="${k}" ${k === r.type ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="field"><span>Settings, one key=value per line (no secrets here)</span><textarea id="s-config" rows="3" placeholder="project=my-app">${esc(config)}</textarea></div>
    <div class="field"><span>Secret names (set the values in the environment, never here)</span><input id="s-secrets" value="${esc((r.secrets ?? []).join(', '))}" placeholder="DATABASE_URL, SUPABASE_SERVICE_KEY"></div>
    <h2>Who may use it</h2>
    ${bound.length ? `<ul class="bindings">${bound.map((b) => bindingRow(ctx, b, 'role')).join('')}</ul>` : '<p class="hint">No role yet. Drag this system onto a role on the canvas.</p>'}
    <div class="row end spaced"><button type="button" id="s-remove">Remove system</button></div>`;
  const update = (fn) => ctx.change((s) => fn(s.resources.resources.find((x) => x.id === id), s));
  el.querySelector('#s-name').onchange = (e) => update((x) => { x.name = e.target.value.trim(); });
  el.querySelector('#s-type').onchange = (e) => update((x) => { x.type = e.target.value; });
  el.querySelector('#s-id').onchange = (e) => {
    const next = slugify(e.target.value);
    if (next === id || spec.resources.resources.some((x) => x.id === next)) { e.target.value = id; return; }
    update((x, s) => { x.id = next; for (const b of s.resources.bindings ?? []) if (b.resource === id) b.resource = next; });
    ctx.selectSystem(next);
  };
  el.querySelector('#s-config').onchange = (e) => update((x) => {
    x.config = Object.fromEntries(e.target.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf('='); return i < 0 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  });
  el.querySelector('#s-secrets').onchange = (e) => update((x) => { x.secrets = e.target.value.split(/[,\s]+/).map((v) => v.trim()).filter(Boolean); });
  el.querySelector('#s-remove').onclick = () => {
    ctx.change((s) => { s.resources.resources = s.resources.resources.filter((x) => x.id !== id); s.resources.bindings = (s.resources.bindings ?? []).filter((b) => b.resource !== id); });
    ctx.selectSystem(null);
  };
  wireBindings(el, ctx);
}

/** A role's systems, for the role inspector. */
export function roleSystemsHtml(ctx, slug) {
  const bound = (ctx.spec().resources?.bindings ?? []).filter((b) => b.role === slug);
  return `<h2>Systems</h2>${bound.length ? `<ul class="bindings">${bound.map((b) => bindingRow(ctx, b, 'system')).join('')}</ul>` : '<p class="hint">None. In the Systems view, drag a system onto this role.</p>'}`;
}

function bindingRow(ctx, b, show) {
  const { esc } = ctx;
  const res = ctx.spec().resources?.resources?.find((x) => x.id === b.resource);
  const role = ctx.team.find((r) => r.slug === b.role);
  const label = show === 'role' ? (role?.title ?? b.role) : (res?.name || b.resource);
  return `<li><span class="grow">${esc(label)}</span>
    <select data-binding="${esc(b.role)}|${esc(b.resource)}" aria-label="${esc(t('wiring.level'))}">${LEVELS.map(([p, k]) => `<option value="${p}" ${p === b.permission ? 'selected' : ''} title="${esc(tip(p === 'write' ? 'change' : p === 'deploy' ? 'act' : 'read'))}">${esc(t(k))}</option>`).join('')}</select>
    <button type="button" class="icon" data-unbind="${esc(b.role)}|${esc(b.resource)}" aria-label="Remove">×</button></li>`;
}

export function wireBindings(el, ctx) {
  for (const sel of el.querySelectorAll('select[data-binding]')) {
    sel.onchange = () => { const [role, resource] = sel.dataset.binding.split('|'); ctx.change((s) => { s.resources.bindings.find((b) => b.role === role && b.resource === resource).permission = sel.value; }); };
  }
  for (const btn of el.querySelectorAll('[data-unbind]')) {
    btn.onclick = () => { const [role, resource] = btn.dataset.unbind.split('|'); ctx.change((s) => { s.resources.bindings = s.resources.bindings.filter((b) => !(b.role === role && b.resource === resource)); }); };
  }
}

// ------------------------------------------------------------------------------------------------ owned areas

/** Owned areas: which role writes each part of the repository. One writer per area; everything else is a request. */
export function renderAreas(el, ctx, sugg) {
  const { esc } = ctx;
  const spec = ctx.spec();
  const own = spec.ownership;
  const team = ctx.team;
  const writers = (cur) => {
    const known = team.some((r) => r.slug === cur);
    return `${team.map((r) => `<option value="${r.slug}" ${r.slug === cur ? 'selected' : ''}>${esc(r.title)}</option>`).join('')}
      ${cur && !known ? `<option value="${esc(cur)}" selected>${esc(cur)}</option>` : ''}<option value="" ${cur ? '' : 'selected'}>Pick a role</option>`;
  };
  if (!own) {
    const md = sugg?.fromMarkdown ?? [];
    el.innerHTML = `<div class="panel"><h1>Owned areas</h1>
      <p>Each area of the repository has exactly one role that writes it. Anyone else sends that role a request. Today this team's areas are hand-written in <code>docs/team/ownership.md</code>.</p>
      <p>Manage them here instead, and publishing writes <code>.agent-team/ownership.json</code> and generates <code>ownership.md</code> from it.</p>
      <div class="row"><button type="button" class="primary" id="a-fresh">Start from this repository's folders</button>
        ${md.length ? `<button type="button" id="a-start">Import ownership.md (${md.length} areas)</button>` : ''}</div></div>`;
    el.querySelector('#a-fresh').onclick = () => ctx.change((s) => { s.ownership = { rows: [] }; });
    el.querySelector('#a-start')?.addEventListener('click', () => ctx.change((s) => { s.ownership = { rows: md.map((r) => ({ ...r })) }; }));
    return;
  }
  const rows = own.rows ?? [];
  const dupes = new Set(rows.map((r) => r.path).filter((p, i, a) => a.indexOf(p) !== i));
  const unowned = (sugg?.areas ?? []).filter((a) => !rows.some((r) => r.path === a.path));
  const noArea = team.filter((r) => r.group !== 'executive' && !r.dormant && !rows.some((x) => x.writer === r.slug));
  el.innerHTML = `<div class="panel"><h1>Owned areas</h1>
    <p class="hint">One writer per area. A role changes only what it owns; anything else is a request to the owner.</p>
    ${unowned.length ? `<div class="callout"><div class="row between"><strong>${unowned.length} folder${unowned.length > 1 ? 's have' : ' has'} no owner yet</strong>
        <button type="button" id="a-accept-all" ${unowned.some((u) => u.writer) ? '' : 'disabled'}>Accept all suggestions</button></div>
      <ul class="suggest">${unowned.map((u, i) => `<li><code>${esc(u.path)}</code> <span class="grow hint">${esc(u.why)}</span>
        <select data-sugg="${i}">${writers(u.writer)}</select> <button type="button" data-accept="${i}">Add</button></li>`).join('')}</ul></div>` : ''}
    <table class="grid"><thead><tr><th>Area (path)</th><th>Writer</th><th>Notes</th><th></th></tr></thead><tbody>
    ${rows.map((r, i) => `<tr class="${dupes.has(r.path) ? 'bad' : ''}"><td><input data-row="${i}" data-k="path" value="${esc(r.path)}"></td>
      <td><select data-row="${i}" data-k="writer">${writers(r.writer)}</select></td>
      <td><input data-row="${i}" data-k="notes" value="${esc(r.notes ?? '')}"></td>
      <td><button type="button" class="icon" data-del="${i}" aria-label="Remove">×</button></td></tr>`).join('')}
    </tbody></table>
    <div class="row"><button type="button" id="a-add">+ Add an area</button>
      ${noArea.length ? `<span class="hint">Owns nothing yet: ${noArea.map((r) => esc(r.title)).join(', ')}</span>` : ''}</div></div>`;
  for (const inp of el.querySelectorAll('[data-row]')) {
    inp.onchange = () => ctx.change((s) => { s.ownership.rows[+inp.dataset.row][inp.dataset.k] = inp.value.trim(); });
  }
  for (const b of el.querySelectorAll('[data-del]')) b.onclick = () => ctx.change((s) => { s.ownership.rows.splice(+b.dataset.del, 1); });
  el.querySelector('#a-add').onclick = () => ctx.change((s) => { s.ownership.rows.push({ path: '', writer: '', notes: '' }); });
  const accept = (list) => ctx.change((s) => { for (const u of list) if (u.writer) s.ownership.rows.push({ path: u.path, writer: u.writer, notes: '' }); });
  for (const sel of el.querySelectorAll('[data-sugg]')) sel.onchange = () => { unowned[+sel.dataset.sugg].writer = sel.value; };
  for (const b of el.querySelectorAll('[data-accept]')) b.onclick = () => accept([unowned[+b.dataset.accept]]);
  el.querySelector('#a-accept-all')?.addEventListener('click', () => accept(unowned));
}

// ------------------------------------------------------------------------------------------------ checks

/**
 * Checks: what must pass before a change merges, grouped into named sets (gates.json targets), with how many of each
 * kind of machine slot may run at once (pools). The merge gate runs the sets listed in "all".
 */
export function renderChecks(el, ctx, sugg) {
  const { esc } = ctx;
  const g = ctx.spec().gates;
  if (!g) {
    el.innerHTML = `<div class="panel"><h1>Checks</h1>
      <p>Checks are what must pass before a change merges: tests, lint, a build. Today this team's checks are written in bash in <code>.agent-team/config.sh</code>, which keeps working.</p>
      <p>Manage them here instead, and publishing writes <code>.agent-team/gates.json</code>. A set defined here replaces the bash one of the same name.</p>
      <div class="row"><button type="button" class="primary" id="c-start">${sugg?.checks?.length ? `Start from this repository's build files (${sugg.checks.length} checks)` : 'Start with an empty list'}</button></div></div>`;
    el.querySelector('#c-start').onclick = () => ctx.change((s) => { s.gates = fromSuggestions(sugg?.checks ?? []); });
    return;
  }
  const pools = Object.entries(g.pools ?? {});
  const poolOpts = (cur) => `<option value="" ${cur ? '' : 'selected'}>any machine</option>${pools.map(([p]) => `<option ${p === cur ? 'selected' : ''}>${esc(p)}</option>`).join('')}`;
  const have = new Set(Object.values(g.targets ?? {}).flat().map((s) => s.run));
  const fresh = (sugg?.checks ?? []).filter((c) => !have.has(c.run));
  el.innerHTML = `<div class="panel"><h1>Checks</h1>
    <p class="hint">What must pass before a change merges. The merge gate runs the sets that are switched on; a role can run one set with <code>scripts/agent-team/merge-gate.sh &lt;set&gt;</code>.</p>
    ${fresh.length ? `<div class="callout"><div class="row between"><strong>Found in the build files: ${fresh.map((c) => `<code>${esc(c.run)}</code>`).join(', ')}</strong>
      <button type="button" id="c-add-found">Add them</button></div></div>` : ''}
    ${Object.entries(g.targets ?? {}).map(([t, steps]) => `<section class="set">
      <div class="row between"><h2 class="flush">${esc(t)}</h2>
        <span class="row"><label class="row hint"><input type="checkbox" data-all="${esc(t)}" ${(g.all ?? []).includes(t) ? 'checked' : ''}> Runs on every merge</label>
        <button type="button" class="icon" data-del-set="${esc(t)}" aria-label="Remove set">×</button></span></div>
      <table class="grid"><thead><tr><th>Check</th><th>Command</th><th>Machine slot</th><th></th></tr></thead><tbody>
      ${steps.map((s, i) => `<tr><td><input data-step="${esc(t)}|${i}" data-k="name" value="${esc(s.name)}"></td>
        <td><input class="mono" data-step="${esc(t)}|${i}" data-k="run" value="${esc(s.run)}"></td>
        <td><select data-step="${esc(t)}|${i}" data-k="pool">${poolOpts(s.pool)}</select></td>
        <td><button type="button" class="icon" data-del-step="${esc(t)}|${i}" aria-label="Remove">×</button></td></tr>`).join('')}
      </tbody></table><button type="button" data-add-step="${esc(t)}">+ Add a check</button></section>`).join('')}
    <div class="row"><input id="c-new-set" placeholder="New set, e.g. web" class="narrow"><button type="button" id="c-add-set">+ Add a set</button></div>
    <h2>Machine slots</h2><p class="hint">How many checks of each kind may run at the same time on this machine (builds, browsers, a shared backend).</p>
    <table class="grid narrow"><tbody>${pools.map(([p, n]) => `<tr><td><code>${esc(p)}</code></td><td><input type="number" min="1" data-pool="${esc(p)}" value="${n}"></td>
      <td><button type="button" class="icon" data-del-pool="${esc(p)}" aria-label="Remove">×</button></td></tr>`).join('')}</tbody></table>
    <div class="row"><input id="c-new-pool" placeholder="New slot, e.g. browser" class="narrow"><button type="button" id="c-add-pool">+ Add a slot</button></div></div>`;
  const edit = (fn) => ctx.change((s) => fn(s.gates));
  const key = (v) => { const [t, i] = v.split('|'); return [t, +i]; };
  for (const inp of el.querySelectorAll('[data-step]')) inp.onchange = () => { const [t, i] = key(inp.dataset.step); edit((x) => { x.targets[t][i][inp.dataset.k] = inp.value.trim(); if (!x.targets[t][i].pool) delete x.targets[t][i].pool; }); };
  for (const b of el.querySelectorAll('[data-del-step]')) b.onclick = () => { const [t, i] = key(b.dataset.delStep); edit((x) => { x.targets[t].splice(i, 1); }); };
  for (const b of el.querySelectorAll('[data-add-step]')) b.onclick = () => edit((x) => { x.targets[b.dataset.addStep].push({ name: 'new check', run: 'true' }); });
  for (const b of el.querySelectorAll('[data-del-set]')) b.onclick = () => edit((x) => { delete x.targets[b.dataset.delSet]; x.all = (x.all ?? []).filter((a) => a !== b.dataset.delSet); });
  for (const c of el.querySelectorAll('[data-all]')) c.onchange = () => edit((x) => { x.all = (x.all ?? []).filter((a) => a !== c.dataset.all); if (c.checked) x.all.push(c.dataset.all); });
  for (const inp of el.querySelectorAll('[data-pool]')) inp.onchange = () => edit((x) => { x.pools[inp.dataset.pool] = Math.max(1, Math.round(+inp.value || 1)); });
  for (const b of el.querySelectorAll('[data-del-pool]')) b.onclick = () => edit((x) => { delete x.pools[b.dataset.delPool]; for (const st of Object.values(x.targets ?? {}).flat()) if (st.pool === b.dataset.delPool) delete st.pool; });
  el.querySelector('#c-add-set').onclick = () => { const n = slugify(el.querySelector('#c-new-set').value); if (n && !g.targets?.[n]) edit((x) => { x.targets ??= {}; x.targets[n] = []; }); };
  el.querySelector('#c-add-pool').onclick = () => { const n = slugify(el.querySelector('#c-new-pool').value); if (n && !(n in (g.pools ?? {}))) edit((x) => { x.pools ??= {}; x.pools[n] = 1; }); };
  el.querySelector('#c-add-found')?.addEventListener('click', () => edit((x) => merge(x, fromSuggestions(fresh))));
}

function fromSuggestions(list) {
  const g = { all: [], pools: {}, targets: {} };
  for (const c of list) {
    (g.targets[c.target] ??= []).push(c.pool ? { name: c.name, run: c.run, pool: c.pool } : { name: c.name, run: c.run });
    if (c.pool) g.pools[c.pool] ??= c.pool === 'browser' ? 2 : 1;
    if (!g.all.includes(c.target)) g.all.push(c.target);
  }
  return g;
}
function merge(into, from) {
  into.targets ??= {}; into.pools ??= {}; into.all ??= [];
  for (const [t, steps] of Object.entries(from.targets)) (into.targets[t] ??= []).push(...steps);
  for (const [p, n] of Object.entries(from.pools)) into.pools[p] ??= n;
  for (const t of from.all) if (!into.all.includes(t)) into.all.push(t);
}
