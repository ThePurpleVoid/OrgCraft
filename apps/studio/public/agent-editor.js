// The custom agent editor (PRD 6.6 A2, A3; mockup 02; CPO story criteria 4 to 8, 10, 15). A page of its own over the
// team view: the brief's sections on the left with their state, the fields in the middle, and on the right the exact
// file publish writes, updated on every keystroke, with the team's checks for this agent.
//
// Every edit goes through the editor's change(): typing is folded into one undo step per field, and does not redraw
// the form (so focus and the caret stay put); adding or removing a row redraws it.
import {
  briefSection, compileLayer, ownsPaths, pathConflicts, scheduleProblem, setBriefField, setBriefSection, setBriefTitle,
  setOwnsPaths, setSignoffEvidence, setWakesOn, signoffEvidence, splitBrief, wakesOn,
} from './team-model.mjs';
import { roleSystemsHtml, wireBindings } from './panels.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const field = (md, name) => (new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+)$`, 'm').exec(md ?? '')?.[1] ?? '').trim();
const titleOf = (md, slug) => (/^#\s+(.+)$/m.exec(md ?? '')?.[1] ?? slug).trim();
const TIERS = ['light', 'routine', 'standard', 'deep'];
const TIER_HINT = {
  light: 'Light fits short, mechanical tasks. It costs least.',
  routine: 'Routine fits well-defined, repeated work.',
  standard: 'Standard fits most work, including review. Deep costs about 3× as much per task.',
  deep: 'Deep fits planning and hard judgement calls. It costs about 3× standard per task.',
};
const DORMANT = "dormant until the owner or the lane's executive opens it for a request.";
const GROUP = /^[a-z][a-z0-9 -]{0,30}$/;
const KINDS = ['HANDOFF', 'BUG', 'SIGNOFF', 'BLOCKED'];

/** The sections, in order, with the words an owner in any industry reads (CPO story D6). */
const SECTIONS = [
  { id: 'identity', name: 'Identity' },
  { id: 'place', name: 'Place in the team' },
  { id: 'owns', name: 'What it owns' },
  { id: 'tools', name: 'Tools and systems' },
  { id: 'wakes', name: 'Wakes on' },
  { id: 'hands', name: 'Hands to' },
  { id: 'rules', name: 'Rules' },
  { id: 'evidence', name: 'Sign-off evidence' },
];

/** Which section an issue from the checks belongs to. */
function sectionOf(message) {
  if (/^what it owns/i.test(message)) return 'owns';
  if (/^wakes on/i.test(message)) return 'wakes';
  if (/sign-?off/i.test(message)) return 'evidence';
  if (/hands to/i.test(message)) return 'hands';
  if (/identity/i.test(message)) return 'identity';
  if (/model tier|reports to|reporting line|slug|replaces the kit/i.test(message)) return 'place';
  if (/overlaps|writer|owns/i.test(message)) return 'owns';
  return 'identity';
}

/**
 * Sets a section's text. Unlike setBriefSection, emptying a field keeps the section where it is (with no text), so
 * clearing and retyping does not move it to the end of the brief.
 */
function setText(md, name, text) {
  if (String(text ?? '').trim()) return setBriefSection(md, name, text);
  const b = splitBrief(md);
  const s = b.sections.find((x) => x.heading.replace(/^##\s+/, '').replace(/\(.*?\)/g, '').trim().toLowerCase() === name.toLowerCase());
  if (!s) return md;
  s.body = [];
  return [...b.header, ...b.sections.flatMap((x) => [x.heading, ...x.body, ''])].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** Lines from a section as a list: "- a" bullets, or the comma-separated items of a one-line section. */
function items(text) {
  return String(text ?? '').split('\n').flatMap((l) => (/^\s*[-*]\s/.test(l) ? [l.replace(/^\s*[-*]\s*/, '')] : l.split(','))).map((x) => x.trim()).filter(Boolean);
}

/**
 * app: { spec(), kit, roles() (derived: slug, title, group, enabled, reportsTo), team(), issues() (the current checks),
 *        change(fn, { quiet, key }), ctx (for the bindings panel), api(path, body), close(), setOn(slug) }.
 */
export function createAgentEditor(root, app) {
  let slug = null;
  const origins = new Map(); // slug → { from, md }: what a copy started from, to mark what differs
  let unresolved = { key: '', list: [] };
  let graphTimer = null;

  const brief = () => app.spec().roles[slug]?.brief ?? '';
  // The kit template's example text, by section: a field still holding it shows empty, with the text as its hint.
  const tpl = new Map(splitBrief(app.kit.template ?? '').sections.map((x) => [x.heading.replace(/^##\s+/, '').replace(/\(.*?\)/g, '').trim().toLowerCase(), x.body.join('\n').trim()]));
  const example = (name, text) => !!text.trim() && tpl.get(name) === text.trim();
  const own = (name, md) => { const t = briefSection(md, name); return example(name, t) ? '' : t; };
  const hint = (name, fallback) => (tpl.get(name) ?? fallback).replace(/^- /, '');
  const edit = (fn, key) => app.change((s) => { s.roles[slug].brief = fn(s.roles[slug].brief); }, { quiet: !!key, key: key && `${slug}:${key}` });

  function open(s, origin) {
    slug = s;
    if (origin) origins.set(s, origin);
    document.body.classList.add('editing');
    root.hidden = false;
    draw();
    root.querySelector('#e-title')?.focus();
  }
  function close() {
    slug = null;
    document.body.classList.remove('editing');
    root.hidden = true;
    root.innerHTML = '';
  }

  // ---------------------------------------------------------------------------------------------- drawing

  function draw() {
    if (!slug) return;
    if (!app.spec().roles[slug]) return close(); // undone out of existence
    const scroll = root.querySelector('.ed-form')?.scrollTop ?? 0;
    const md = brief();
    const role = app.spec().roles[slug];
    const roles = app.roles();
    const team = app.team();
    const origin = origins.get(slug);
    const groups = [...new Set([...roles.map((r) => r.group), field(md, 'Group').toLowerCase()].filter((g) => g && g !== 'other'))].sort();
    const managers = team.filter((r) => r.slug !== slug);
    const tier = (/^[a-z]+/i.exec(field(md, 'Model'))?.[0] ?? '').toLowerCase();
    const dormant = /^dormant/i.test(field(md, 'Status'));
    const owns = ownsPaths(md);
    const w = wakesOn(md);
    const has = (t) => w.triggers.find((x) => x.type === t);
    const evidence = signoffEvidence(md).filter((e) => !example('sign-off evidence', `- ${e}`));
    const tools = items(own('tools', md));
    const resources = app.spec().resources?.resources ?? [];
    const bound = new Set((app.spec().resources?.bindings ?? []).filter((b) => b.role === slug).map((b) => b.resource));
    const free = resources.filter((r) => !bound.has(r.id));
    const wake = (type, label, value, placeholder) => `<div class="wake"><label class="row"><input type="checkbox" data-wake="${type}" ${has(type) ? 'checked' : ''}> ${label}</label>${value ? `<input data-wake-value="${type}" value="${esc(has(type)?.value ?? '')}" placeholder="${esc(placeholder)}" aria-label="${esc(label)}: ${esc(placeholder)}">` : ''}</div>`;

    root.innerHTML = `
      <div class="ed-head">
        <div><strong id="e-heading">${esc(titleOf(md, slug))}</strong> <code class="muted">${esc(slug)}</code></div>
        <span id="e-count" class="pill"></span>
        ${role.enabled ? '' : '<button type="button" id="e-add" class="primary">Add to the team</button>'}
        <button type="button" id="e-back"${role.enabled ? ' class="primary"' : ''}>Back to the team</button>
      </div>
      <div class="ed">
        <nav class="ed-nav" aria-label="Sections">
          ${SECTIONS.map((s) => `<a href="#sec-${s.id}" data-sec="${s.id}"><span>${s.name}</span><span class="s" data-state="${s.id}"></span></a>`).join('')}
          ${origin ? `<p class="hint">Copied from ${esc(origin.title ?? origin.from)}. Sections you have not changed still read like it; the preview marks what differs.</p>` : ''}
          ${role.enabled ? '' : '<p class="hint">Switched off: it is not on the team until you add it. Its checks must pass first.</p>'}
        </nav>
        <div class="ed-form">
          <section id="sec-identity"><h2>Identity</h2>
            <label>Name <input id="e-title" value="${esc(titleOf(md, slug))}" maxlength="60" autocomplete="off"></label>
            <p class="hint">The slug <code>${esc(slug)}</code> names its file and its place on the board, so it stays as it is once published.</p>
            <label>What this agent owns and how it is judged <textarea id="e-identity-text" rows="4" placeholder="${esc(hint('identity', 'What it is responsible for, and the outcome it is judged on, written to the agent.'))}">${esc(own('identity', md))}</textarea></label>
          </section>

          <section id="sec-place"><h2>Place in the team</h2>
            <div class="cols">
              <div><span class="lbl" id="e-tier-l">Model tier</span>
                <div class="seg" role="radiogroup" aria-labelledby="e-tier-l">${TIERS.map((t) => `<button type="button" role="radio" aria-checked="${t === tier}" data-tier="${t}">${t}</button>`).join('')}</div>
                <p class="hint">${esc(TIER_HINT[tier] ?? 'Pick a tier.')}</p></div>
              <div><span class="lbl" id="e-status-l">When it starts</span>
                <div class="seg" role="radiogroup" aria-labelledby="e-status-l"><button type="button" role="radio" aria-checked="${!dormant}" data-status="on">On</button><button type="button" role="radio" aria-checked="${dormant}" data-status="dormant">Dormant until asked</button></div></div>
              <label>Group <select id="e-group">${groups.map((g) => `<option ${g === field(md, 'Group').toLowerCase() ? 'selected' : ''}>${esc(g)}</option>`).join('')}<option value="+">New group…</option></select></label>
              <label>Reports to <select id="e-manager"><option value="owner">The owner</option>${managers.map((m) => `<option value="${esc(m.slug)}" ${m.slug === field(md, 'Reports to').split(/\s/)[0] ? 'selected' : ''}>${esc(m.title)}</option>`).join('')}</select></label>
              <label id="e-newgroup-l" hidden>New group name <input id="e-newgroup" maxlength="31" autocomplete="off"></label>
            </div>
          </section>

          <section id="sec-owns"><h2>What it owns</h2>
            <p class="hint">The areas this agent writes: a folder or a file. Every area has exactly one writer; everyone else asks the writer.</p>
            ${owns.paths.map((p, i) => {
              const clash = p.mode === 'writes' ? pathConflicts(app.spec(), slug, p.path) : [];
              return `<div class="area-row"><code>${esc(p.path)}</code>
                <select data-mode="${i}" aria-label="What it does with ${esc(p.path)}"><option value="writes" ${p.mode === 'writes' ? 'selected' : ''}>writes</option><option value="reads" ${p.mode === 'reads' ? 'selected' : ''}>reads</option></select>
                <button type="button" class="link" data-remove-area="${i}">Remove</button></div>
                ${clash.length ? `<div class="conflict" role="alert"><strong>${esc(clash.map((c) => c.writer).join(', '))} already ${clash.length > 1 ? 'write' : 'writes'} ${esc(clash[0].path)}.</strong> Two writers on one area breaks the one-writer rule. Make this one "reads", or pick a narrower area.</div>` : ''}`;
            }).join('') || '<p class="muted">No areas yet.</p>'}
            <div class="add-row"><input id="e-area" placeholder="for example contracts/ or docs/handbook.md" aria-label="Area to add" autocomplete="off" spellcheck="false"><button type="button" id="e-area-add">Add an area</button></div>
            ${owns.prose && !example('owns', owns.prose) ? `<p class="hint">Also in this section: ${esc(owns.prose)}</p>` : ''}
          </section>

          <section id="sec-tools"><h2>Tools and systems</h2>
            <div class="chips">${tools.map((t, i) => `<span class="chip">${esc(t)}<button type="button" data-remove-tool="${i}" aria-label="Remove ${esc(t)}">×</button></span>`).join('')}
              <span class="add-row inline"><input id="e-tool" placeholder="Add a tool, skill or MCP server" aria-label="Tool to add" autocomplete="off"><button type="button" id="e-tool-add">Add</button></span></div>
            <div class="ed-systems">${roleSystemsHtml(app.ctx, slug).replace('<h2>Systems</h2>', '')}</div>
            ${free.length ? `<div class="add-row"><select id="e-bind" aria-label="System to connect"><option value="">Connect a system…</option>${free.map((r) => `<option value="${esc(r.id)}">${esc(r.name || r.id)}</option>`).join('')}</select>
              <select id="e-bind-perm" aria-label="Permission"><option>read</option><option>write</option><option>deploy</option></select><button type="button" id="e-bind-add">Connect</button></div>` : ''}
            <p class="hint">Without a connection it gets no tools and no secrets for that system. Secrets show only by name.</p>
          </section>

          <section id="sec-wakes"><h2>Wakes on</h2>
            <p class="hint">What starts a task for this agent.</p>
            <div class="wakes">
              ${wake('handoff', 'A HANDOFF to this agent')}
              ${wake('meeting', 'A meeting it is invited to')}
              ${wake('issue-label', 'An issue or task with a label', true, 'label, for example contract-review')}
              ${wake('schedule', 'A schedule', true, 'days and time, for example mon-fri 09:30')}
              ${wake('pr-paths', 'A pull request that changes these areas', true, 'for example apps/web/**, tests/a11y/')}
              ${wake('label', 'A pull request with a label', true, 'label, for example a11y')}
            </div>
            <p id="e-wake-problem" class="result error" role="alert"></p>
            <label>Anything else (kept as written; the runner does not read it) <textarea id="e-wakes-text" rows="2">${esc(w.text.map((l) => l.replace(/^[-*]\s*/, '')).join('\n'))}</textarea></label>
          </section>

          <section id="sec-hands"><h2>Hands to</h2>
            <p class="hint">Who this agent sends work to, and with which message.</p>
            <textarea id="e-hands-text" aria-label="Hands to" rows="3" placeholder="${esc(hint('hands to', 'The roles it passes work to'))}, for example web-dev (BUG), qa-web (SIGNOFF)">${esc(own('hands to', md))}</textarea>
            <div class="add-row"><select id="e-hand-role" aria-label="Role">${team.filter((r) => r.slug !== slug).map((r) => `<option value="${esc(r.slug)}">${esc(r.title)}</option>`).join('')}</select>
              <select id="e-hand-kind" aria-label="Message">${KINDS.map((k) => `<option>${k}</option>`).join('')}</select><button type="button" id="e-hand-add">Add</button></div>
          </section>

          <section id="sec-rules"><h2>Rules <span class="opt">optional</span></h2>
            <textarea id="e-rules-text" aria-label="Rules" rows="3" placeholder="${esc(hint('rules', 'Two to five rules specific to this agent'))}">${esc(own('rules', md))}</textarea>
          </section>

          <section id="sec-evidence"><h2>Sign-off evidence</h2>
            <p class="hint">What this agent attaches to a SIGNOFF. A sign-off without it is sent back.</p>
            ${evidence.map((e, i) => `<div class="area-row"><span>${esc(e)}</span><button type="button" class="link" data-remove-evidence="${i}">Remove</button></div>`).join('')}
            <div class="add-row"><input id="e-evidence" placeholder="for example a screenshot of each changed screen, or the signed document" aria-label="Evidence to add" autocomplete="off"><button type="button" id="e-evidence-add">Add</button></div>
          </section>

          <details class="ed-raw"><summary>The whole brief as markdown</summary>
            <textarea id="e-raw" rows="16" spellcheck="false">${esc(md)}</textarea></details>
        </div>
        <aside class="ed-prev" aria-label="Brief preview">
          <div class="row" style="justify-content:space-between"><h2>Brief preview</h2><span class="badge">${role.source === 'project-replaces-kit' ? 'replaces a kit role' : 'custom role'}</span></div>
          <p class="hint"><code>.agent-team/roles/${esc(slug)}.md</code>. Exactly the file publish writes.</p>
          <pre id="e-preview" class="brief"></pre>
          <h2>Checks</h2>
          <ul id="e-checks" class="ed-checks"></ul>
        </aside>
      </div>`;
    wire();
    live();
    const f = root.querySelector('.ed-form');
    if (f) f.scrollTop = scroll;
  }

  /** The parts that follow every keystroke: the preview, the checks, the section states and the heading. */
  function live() {
    if (!slug || !app.spec().roles[slug]) return;
    const md = brief();
    const file = compileLayer(app.spec(), app.kit)[`roles/${slug}.md`] ?? md;
    const origin = origins.get(slug);
    const before = origin ? new Set(origin.md.split('\n').map((l) => l.trim())) : null;
    root.querySelector('#e-preview').innerHTML = file.split('\n').map((l) => {
      const cls = [/^#/.test(l) ? 'h' : '', before && l.trim() && !before.has(l.trim()) ? 'diff' : ''].filter(Boolean).join(' ');
      return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
    }).join('\n');
    root.querySelector('#e-heading').textContent = titleOf(md, slug);

    const mine = app.issues().filter((i) => i.where === `roles/${slug}`);
    loadUnresolved();
    const hands = unresolved.list.map((p) => ({ level: 'warning', message: `Hands to names "${p}", which is not a role on this team` }));
    const examples = [['identity', 'Identity'], ['owns', 'What it owns'], ['hands to', 'Hands to']]
      .filter(([k]) => example(k, k === 'owns' ? ownsPaths(md).prose : briefSection(md, k)) && !(k === 'owns' && ownsPaths(md).paths.length))
      .map(([, label]) => ({ level: 'warning', message: `${label} still has the template's example text: write this agent's own` }));
    // The template's example evidence line is not evidence, though the kit's check counts any "- " line.
    const realEvidence = signoffEvidence(md).some((e) => !example('sign-off evidence', `- ${e}`));
    if (/signoff/i.test(briefSection(md, 'hands to')) && !realEvidence && !mine.some((i) => /sign-?off evidence/i.test(i.message))) {
      examples.push({ level: 'warning', message: 'sends SIGNOFF but lists no sign-off evidence (screenshots, logs, links)' });
    }
    const all = [...mine, ...hands, ...examples];
    const errors = all.filter((i) => i.level === 'error');
    const count = root.querySelector('#e-count');
    count.className = `pill ${errors.length ? 'error' : all.length ? 'warn' : 'ok'}`;
    count.textContent = errors.length ? `${errors.length} to fix${all.length > errors.length ? ` · ${all.length - errors.length} warning${all.length - errors.length > 1 ? 's' : ''}` : ''}` : all.length ? `${all.length} warning${all.length > 1 ? 's' : ''}` : 'Checks pass';
    const add = root.querySelector('#e-add');
    if (add) { add.disabled = errors.length > 0; add.title = errors.length ? 'Fix the checks first' : ''; }

    // The checks this agent passes, and the ones it does not (criterion 8).
    const fails = (re) => all.filter((i) => re.test(i.message));
    const rows = [
      ['Reports to a manager on the team; no loop', fails(/reports to|reporting line|has no "Reports to"/i)],
      ['A model tier the kit knows', fails(/model tier/i)],
      ['Every area has one writer', fails(/overlaps|two writers/i)],
      ['Hands to roles that are on this team', fails(/hands to/i)],
      ['Wakes on lines the runner reads', fails(/^wakes on/i)],
      ['Sign-off evidence for an agent that signs off', fails(/sign-?off/i)],
      ['No secrets in the text', fails(/secret/i)],
    ];
    const known = new Set(rows.flatMap(([, f]) => f));
    const other = all.filter((i) => !known.has(i));
    root.querySelector('#e-checks').innerHTML = [
      ...other.map((i) => `<li class="${i.level}">${esc(i.message)}</li>`),
      ...rows.map(([label, f]) => (f.length ? f.map((i) => `<li class="${i.level}">${esc(i.message)}</li>`).join('') : `<li class="pass">${esc(label)}.</li>`)),
    ].join('');

    // Section states: done, optional, or what is left to fix.
    const per = new Map();
    for (const i of all) per.set(sectionOf(i.message), [...(per.get(sectionOf(i.message)) ?? []), i]);
    const filled = {
      identity: !!own('identity', md).trim(), place: true, owns: ownsPaths(md).paths.length > 0,
      tools: !!own('tools', md).trim(), wakes: wakesOn(md).triggers.length > 0, hands: !!own('hands to', md).trim(),
      rules: !!own('rules', md).trim(), evidence: signoffEvidence(md).some((e) => !example('sign-off evidence', `- ${e}`)),
    };
    for (const el of root.querySelectorAll('[data-state]')) {
      const id = el.dataset.state;
      const list = per.get(id) ?? [];
      const err = list.filter((i) => i.level === 'error').length;
      el.className = `s ${err ? 'bad' : list.length ? 'warn' : filled[id] ? 'done' : 'todo'}`;
      el.textContent = err ? `${err} to fix` : list.length ? `${list.length} to check` : filled[id] ? 'done' : 'optional';
    }
    const raw = root.querySelector('#e-raw');
    if (raw && document.activeElement !== raw) raw.value = md;
  }

  /** Names in Hands to the team does not have, from the same graph the Flow view draws (debounced). */
  function loadUnresolved() {
    const key = JSON.stringify(app.spec().roles);
    if (unresolved.key === key || graphTimer) return;
    graphTimer = setTimeout(async () => {
      graphTimer = null;
      try {
        const g = await app.api('/v1/team/graph', { spec: app.spec() });
        unresolved = { key, list: [...new Set((g.unresolved ?? []).filter((u) => u.role === slug).map((u) => u.phrase))] };
      } catch { unresolved = { key, list: [] }; }
      live();
    }, 400);
  }

  // ---------------------------------------------------------------------------------------------- wiring

  function wire() {
    const $ = (s) => root.querySelector(s);
    const typed = (sel, key, fn) => { const el = $(sel); if (el) el.oninput = () => edit((md) => fn(md, el.value), key); };
    typed('#e-title', 'title', (md, v) => (v.trim() ? setBriefTitle(md, v.trim()) : md));
    // Sync needs an Identity, so a cleared one goes back to the template's example (and the checks say so).
    typed('#e-identity-text', 'identity', (md, v) => setText(md, 'Identity', v.trim() ? v : tpl.get('identity') ?? ''));
    typed('#e-rules-text', 'rules', (md, v) => setText(md, 'Rules', v));
    typed('#e-hands-text', 'hands', (md, v) => setText(md, 'Hands to', v));
    typed('#e-wakes-text', 'wakes-text', (md, v) => { const w = wakesOn(md); return setWakesOn(md, { triggers: w.triggers, text: v.split('\n').filter((l) => l.trim()).map((l) => `- ${l.trim()}`) }); });
    const raw = $('#e-raw');
    raw.onchange = () => { app.change((s) => { s.roles[slug].brief = raw.value; }); };

    for (const b of root.querySelectorAll('[data-tier]')) b.onclick = () => edit((md) => setBriefField(md, 'Model', (field(md, 'Model') || b.dataset.tier).replace(/^[a-z]+/i, b.dataset.tier)));
    for (const b of root.querySelectorAll('[data-status]')) b.onclick = () => edit((md) => setBriefField(md, 'Status', b.dataset.status === 'on' ? 'active' : DORMANT));
    $('#e-manager').onchange = (e) => edit((md) => setBriefField(md, 'Reports to', e.target.value));
    $('#e-group').onchange = (e) => {
      if (e.target.value === '+') { $('#e-newgroup-l').hidden = false; $('#e-newgroup').focus(); return; }
      edit((md) => setBriefField(md, 'Group', e.target.value));
    };
    $('#e-newgroup').onchange = (e) => { const g = e.target.value.trim().toLowerCase(); if (GROUP.test(g)) edit((md) => setBriefField(md, 'Group', g)); else e.target.setCustomValidity('Lower-case letters, digits, spaces and hyphens'), e.target.reportValidity(); };

    // What it owns
    const setPaths = (fn) => edit((md) => { const o = ownsPaths(md); return setOwnsPaths(md, fn(o.paths), example('owns', o.prose) ? '' : o.prose); });
    for (const sel of root.querySelectorAll('[data-mode]')) sel.onchange = () => setPaths((ps) => ps.map((p, i) => (i === Number(sel.dataset.mode) ? { ...p, mode: sel.value } : p)));
    for (const b of root.querySelectorAll('[data-remove-area]')) b.onclick = () => setPaths((ps) => ps.filter((_, i) => i !== Number(b.dataset.removeArea)));
    const addArea = () => {
      const v = $('#e-area').value.trim().replace(/^\.?\//, '');
      if (!v || /\s/.test(v) || v.includes('..')) { $('#e-area').setCustomValidity('A folder or file in the repository, with no spaces or ".."'); return $('#e-area').reportValidity(); }
      setPaths((ps) => (ps.some((p) => p.path === v) ? ps : [...ps, { path: v, mode: 'writes', note: '' }]));
    };
    $('#e-area-add').onclick = addArea;
    $('#e-area').onkeydown = (e) => { $('#e-area').setCustomValidity(''); if (e.key === 'Enter') { e.preventDefault(); addArea(); } };

    // Tools and systems
    const setTools = (fn) => edit((md) => setBriefSection(md, 'Tools', fn(items(own('tools', md))).map((t) => `- ${t}`).join('\n')));
    for (const b of root.querySelectorAll('[data-remove-tool]')) b.onclick = () => setTools((ts) => ts.filter((_, i) => i !== Number(b.dataset.removeTool)));
    const addTool = () => { const v = $('#e-tool').value.trim(); if (v) setTools((ts) => (ts.includes(v) ? ts : [...ts, v])); };
    $('#e-tool-add').onclick = addTool;
    $('#e-tool').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addTool(); } };
    wireBindings(root.querySelector('.ed-systems'), app.ctx);
    const bind = $('#e-bind-add');
    if (bind) bind.onclick = () => {
      const id = $('#e-bind').value;
      if (!id) return;
      app.change((s) => { s.resources.bindings ??= []; s.resources.bindings.push({ role: slug, resource: id, permission: $('#e-bind-perm').value }); });
    };

    // Wakes on
    const setTriggers = () => {
      const triggers = [];
      let problem = '';
      for (const cb of root.querySelectorAll('[data-wake]')) {
        if (!cb.checked) continue;
        const input = root.querySelector(`[data-wake-value="${cb.dataset.wake}"]`);
        const value = input?.value.trim() ?? '';
        if (input && !value) { problem ||= `${cb.parentElement.textContent.trim()}: say which.`; continue; }
        if (cb.dataset.wake === 'schedule' && scheduleProblem(value)) { problem ||= `A schedule: ${scheduleProblem(value)}.`; continue; }
        triggers.push(value ? { type: cb.dataset.wake, value } : { type: cb.dataset.wake });
      }
      $('#e-wake-problem').textContent = problem;
      edit((md) => setWakesOn(md, { triggers, text: wakesOn(md).text }), 'wakes');
    };
    for (const cb of root.querySelectorAll('[data-wake]')) cb.onchange = () => { const v = root.querySelector(`[data-wake-value="${cb.dataset.wake}"]`); if (cb.checked && v && !v.value.trim()) v.focus(); setTriggers(); };
    for (const v of root.querySelectorAll('[data-wake-value]')) v.oninput = () => { const cb = root.querySelector(`[data-wake="${v.dataset.wakeValue}"]`); if (v.value.trim()) cb.checked = true; setTriggers(); };

    // Hands to
    $('#e-hand-add').onclick = () => {
      const r = $('#e-hand-role').value;
      if (!r) return;
      edit((md) => { const cur = own('hands to', md).trim(); return setBriefSection(md, 'Hands to', `${cur ? `${cur}${/[,\n]$/.test(cur) ? '' : ','} ` : ''}${r} (${$('#e-hand-kind').value})`); });
    };

    // Sign-off evidence
    const setEvidence = (fn) => edit((md) => setSignoffEvidence(md, fn(signoffEvidence(md).filter((e) => !example('sign-off evidence', `- ${e}`)))));
    for (const b of root.querySelectorAll('[data-remove-evidence]')) b.onclick = () => setEvidence((es) => es.filter((_, i) => i !== Number(b.dataset.removeEvidence)));
    const addEvidence = () => { const v = $('#e-evidence').value.trim(); if (v) setEvidence((es) => [...es, v]); };
    $('#e-evidence-add').onclick = addEvidence;
    $('#e-evidence').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addEvidence(); } };

    // The section list scrolls the form; the buttons leave or add.
    for (const a of root.querySelectorAll('[data-sec]')) a.onclick = (e) => { e.preventDefault(); root.querySelector(`#sec-${a.dataset.sec}`).scrollIntoView({ block: 'start', behavior: 'smooth' }); };
    $('#e-back').onclick = () => app.close();
    const add = $('#e-add');
    if (add) add.onclick = () => app.setOn(slug);
  }

  return { open, close, draw, live, get slug() { return slug; } };
}
