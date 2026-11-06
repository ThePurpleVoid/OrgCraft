// New agent (PRD 6.6 A1, A5, A6; mockup 01): start a custom agent from the kit's template, from a copy of a role as
// this team runs it, or from a file another team shared (a role .md, or a role pack: the .md files and pack.json).
// The brief is built by the team model's own helpers, so the file publish writes is the one the CLI would.
import { addAgent, checkPack, checkSlug, draftRole, readPack, rolePack, SLUG, slugify, validate } from './team-model.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const field = (md, name) => (new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+)$`, 'm').exec(md ?? '')?.[1] ?? '').trim();
const titleOf = (md) => (/^#\s+(.+)$/m.exec(md ?? '')?.[1] ?? '').replace(/\s*\(.*\)\s*$/, '').trim();
const GROUP = /^[a-z][a-z0-9 -]{0,30}$/;

/** A custom agent: a project role, with its own brief. */
export const isCustom = (role) => role?.brief !== undefined;

/** Agents imported in this session, tagged "imported" until they are published (CPO story D2). */
export const imported = new Set();

/** Why `slug` cannot be switched on: the first error the checks find with it on, or '' (CPO story D2). */
export function switchOnRefusal(spec, kit, slug) {
  const trial = structuredClone(spec);
  trial.roles[slug].enabled = true;
  const e = validate(trial, kit).find((i) => i.level === 'error' && i.where === `roles/${slug}`);
  return e ? `${slug} cannot be switched on yet: ${e.message}` : '';
}

/**
 * Exports a custom agent as a role pack: a folder with <slug>.md and pack.json (names and paths, never secrets or
 * binding details beyond resource types). Where the browser can write a folder it does; elsewhere both files download.
 */
export async function exportPack(spec, slug) {
  const files = rolePack(spec, slug);
  if (globalThis.showDirectoryPicker) {
    let parent;
    try { parent = await showDirectoryPicker({ id: 'role-packs', mode: 'readwrite' }); } catch { return 'cancelled'; }
    const dir = await parent.getDirectoryHandle(slug, { create: true });
    for (const [name, text] of Object.entries(files)) {
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(text);
      await w.close();
    }
    return `Saved the folder ${slug}/ with ${Object.keys(files).join(' and ')}.`;
  }
  for (const [name, text] of Object.entries(files)) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: name.endsWith('.json') ? 'application/json' : 'text/markdown' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  return `Downloaded ${Object.keys(files).join(' and ')}. Put them in a folder named ${slug} to share it as a pack.`;
}

/** Text files from a file input, by base name (a folder's pack.json and .md files, or loose .md files). */
async function readFiles(list) {
  const files = {};
  for (const f of list) {
    if (!/\.(md|json)$/i.test(f.name) || /^(_|README\.md$)/.test(f.name)) continue;
    if (f.size > 256 * 1024) throw new Error(`${f.name} is larger than 256 KB; a brief is a few KB`);
    files[f.name] = await f.text();
  }
  if (!Object.keys(files).some((n) => n.endsWith('.md'))) throw new Error('no role .md file in what you picked');
  return files;
}

/**
 * Opens the New agent dialog. `app` gives the editor's state and actions:
 * { spec(), kit, kitVersion (the team's pinned kit), roles(): the derived roles, change(fn), select(slug), edit(slug, origin) }.
 */
export function openNewAgent(app) {
  const dlg = document.getElementById('agent-dialog');
  const st = { start: 'blank', from: null, q: '', imported: null, importError: '', packIssues: [], slugEdited: false, replaceKit: false };
  const spec = app.spec();
  const kit = app.kit;
  const roles = app.roles();
  const team = roles.filter((r) => r.enabled);
  const groups = [...new Set(roles.map((r) => r.group).filter((g) => g && g !== 'other'))].sort();

  dlg.innerHTML = `<form class="dialog agent-dialog" method="dialog">
    <h2 id="agent-title">New agent</h2>
    <p class="muted">An agent is a role on this team with its own brief. Pick where to start; you can change everything afterwards.</p>
    <div class="starts" role="radiogroup" aria-labelledby="agent-title">
      <div class="start" data-start="blank"><label><input type="radio" name="start" value="blank" checked> <strong>Blank</strong></label>
        <p>Start from the kit's role template: identity, owns, tools, wakes on, hands to, rules.</p></div>
      <div class="start" data-start="copy"><label><input type="radio" name="start" value="copy"> <strong>Copy a role</strong></label>
        <p>Start from a role close to what you need. Your agent is a separate role; the one you copy stays as it is.</p>
        <input type="search" id="a-copy-q" placeholder="Search roles" aria-label="Role to copy">
        <div id="a-copy-list" class="copy-list" role="listbox" aria-label="Roles"></div></div>
      <div class="start" data-start="import"><label><input type="radio" name="start" value="import"> <strong>Import a file</strong></label>
        <p>A brief another team shared: a <code>.md</code> role file or a role pack folder. Checked before it is added.</p>
        <label class="file">Role files <input type="file" id="a-files" multiple accept=".md,.json,text/markdown,application/json"></label>
        <label class="file">Or a role pack folder <input type="file" id="a-folder" webkitdirectory></label></div>
    </div>
    <div id="a-one" class="agent-fields">
      <label class="wide">Name <input id="a-name" autocomplete="off" maxlength="60"></label>
      <label>Slug (file name and board name) <input id="a-slug" class="mono" autocomplete="off" maxlength="48" spellcheck="false"></label>
      <label>Group <select id="a-group">${groups.map((g) => `<option>${esc(g)}</option>`).join('')}<option value="+">New group…</option></select></label>
      <label id="a-newgroup-l" hidden>New group name <input id="a-newgroup" autocomplete="off" maxlength="31" placeholder="for example localization"></label>
      <label>Reports to <select id="a-manager"><option value="owner">The owner</option>${team.map((r) => `<option value="${esc(r.slug)}">${esc(r.title)}</option>`).join('')}</select></label>
      <p id="a-check" class="check-line" role="status"></p>
      <label id="a-replace-l" class="row hint" hidden><input type="checkbox" id="a-replace" style="width:auto"> Replace the kit's role of this name on this team (a kit upgrade will not change yours)</label>
    </div>
    <p id="a-off" class="hint agent-note" hidden>An imported agent is added switched off, under Your agents. Switch it on when its checks pass.</p>
    <div id="a-pack" class="pack-list" hidden></div>
    <p id="a-error" class="result error" role="alert"></p>
    <div class="dialog-foot"><span id="a-where" class="muted"></span>
      <span class="dialog-actions"><button type="button" data-act="cancel">Cancel</button><button type="button" class="primary" id="a-go">Continue to the brief</button></span></div>
  </form>`;
  const $ = (s) => dlg.querySelector(s);
  const name = $('#a-name'), slug = $('#a-slug'), group = $('#a-group'), manager = $('#a-manager');

  const roleBy = (s) => roles.find((r) => r.slug === s);
  const groupValue = () => (group.value === '+' ? $('#a-newgroup').value.trim().toLowerCase() : group.value);

  /** What will be added: [{ slug, md, issues }] with the team's own checks, or an error that stops it. */
  function plan() {
    if (st.start === 'import' && st.imported?.length > 1) {
      return st.imported.map((a) => {
        const c = checkSlug(spec, kit, a.slug, { replaceKit: false });
        return { slug: a.slug, md: a.md, check: c };
      });
    }
    const s = slug.value.trim();
    const c = checkSlug(spec, kit, s, { replaceKit: st.replaceKit });
    if (!name.value.trim()) return { error: 'Give the agent a name.' };
    if (!c.ok) return { error: c.message, check: c };
    if (st.start === 'copy' && !st.from) return { error: 'Pick the role to copy.' };
    if (st.start === 'import' && !st.imported) return { error: st.importError || 'Pick a role file or a role pack folder.' };
    const g = groupValue();
    if (!GROUP.test(g)) return { error: 'A group name uses lower-case letters, digits, spaces and hyphens.' };
    const md = draftRole(spec, kit, { start: st.start, from: st.from, md: st.imported?.[0]?.md, title: name.value.trim(), slug: s, group: g, reportsTo: manager.value });
    return [{ slug: s, md, check: c }];
  }

  /** The team's checks on the new agents, before anything is added: errors block, warnings are shown. */
  function issuesFor(list) {
    const trial = structuredClone(spec);
    for (const a of list) addAgent(trial, a.slug, a.md);
    const mine = new Set(list.map((a) => `roles/${a.slug}`));
    return validate(trial, kit).filter((i) => mine.has(i.where));
  }

  function draw() {
    for (const el of dlg.querySelectorAll('.start')) el.classList.toggle('on', el.dataset.start === st.start);
    const q = st.q.toLowerCase();
    const list = roles.filter((r) => !q || `${r.title} ${r.slug} ${r.group}`.toLowerCase().includes(q)).slice(0, 40);
    $('#a-copy-list').innerHTML = list.map((r) => `<button type="button" role="option" aria-selected="${r.slug === st.from}" data-from="${esc(r.slug)}"><span>${esc(r.title)}</span><span class="tag">${esc(r.group)}</span></button>`).join('') || '<p class="muted">No roles match.</p>';
    const many = st.start === 'import' && st.imported?.length > 1;
    $('#a-one').hidden = many;
    $('#a-pack').hidden = !many;
    const s = slug.value.trim();
    const inKit = SLUG.test(s) && s in kit.roles;
    $('#a-replace-l').hidden = !inKit;
    if (!inKit) { st.replaceKit = false; $('#a-replace').checked = false; }
    $('#a-newgroup-l').hidden = group.value !== '+';
    const p = plan();
    let issues = [];
    if (many) {
      issues = issuesFor(p.filter((a) => a.check.ok));
      $('#a-pack').innerHTML = `<p><strong>${p.length} agents in this pack.</strong> They are added switched off, under Your agents; switch each on when you want it.</p>` +
        p.map((a) => {
          const said = (st.packIssues ?? []).filter((i) => i.where === `roles/${a.slug}`).map((i) => i.message);
          return `<div class="pack-role ${a.check.ok ? 'ok' : 'bad'}"><code>${esc(a.slug)}</code> <span>${esc(titleOf(a.md))}</span><span class="muted">${esc([a.check.message, ...said].join(' · '))}</span></div>`;
        }).join('');
      $('#a-where').textContent = `Saved as .agent-team/roles/<slug>.md for each, when you publish.`;
    } else {
      const c = s ? checkSlug(spec, kit, s, { replaceKit: st.replaceKit }) : null;
      const line = $('#a-check');
      line.textContent = c ? c.message.replace('No kit role uses it.', `No role in kit ${app.kitVersion} uses it.`) : 'The slug names the file and the role on the board.';
      line.className = `check-line ${c ? (c.ok ? 'ok' : 'bad') : ''}`;
      $('#a-where').innerHTML = SLUG.test(s) ? `Saved as <code>.agent-team/roles/${esc(s)}.md</code> when you publish.` : '';
      if (Array.isArray(p)) issues = issuesFor(p);
    }
    const errors = issues.filter((i) => i.level === 'error');
    // A blank or copied agent is added switched on, so any error stops it. An import arrives switched off and is fixed
    // in the editor, so only a secret stops it: that is refused, not cleaned (CPO story D2, D11).
    const stops = st.start === 'import' ? errors.filter((i) => /secret/.test(i.message)) : errors;
    const blocking = Array.isArray(p) ? (many ? !p.some((a) => a.check.ok) && 'None of these can be added: every slug is taken.' : '') : p.error;
    const first = stops[0] ?? errors[0];
    $('#a-error').textContent = st.importError || (first ? `${stops.length ? '' : 'To fix before it can be switched on: '}${first.where.replace(/^roles\//, '')}: ${first.message}` : '');
    $('#a-error').classList.toggle('later', !st.importError && !stops.length);
    $('#a-go').disabled = !!(st.importError || stops.length || blocking);
    $('#a-go').textContent = many ? 'Add them, switched off' : st.start === 'import' ? 'Add it, switched off' : 'Continue to the brief';
    $('#a-off').hidden = st.start !== 'import' || many;
    $('#a-go').title = blocking || '';
  }

  dlg.onchange = async (e) => {
    const t = e.target;
    // Text fields redraw on input. Redrawing again on their change (blur) would replace the copy list under a click.
    if (t.matches('input[type=search], input:not([type])')) return;
    if (t.name === 'start') st.start = t.value;
    if (t.id === 'a-replace') st.replaceKit = t.checked;
    if (t.id === 'a-files' || t.id === 'a-folder') {
      st.start = 'import';
      dlg.querySelector('input[value="import"]').checked = true;
      st.imported = null;
      st.importError = '';
      try {
        const files = await readFiles(t.files);
        // The pack's own checks first (kit 0.10): a pack.json that is not a pack, or a role file with no title, stops it.
        st.packIssues = checkPack(files, spec, kit);
        const bad = st.packIssues.find((i) => i.level === 'error' && !/^roles\//.test(i.where));
        if (bad) throw new Error(`${bad.where} ${bad.message}`);
        const got = readPack(files);
        if (!got.length) throw new Error('the pack lists no roles');
        for (const a of got) if (!SLUG.test(a.slug)) throw new Error(`"${a.slug}" is not a valid slug: rename the file to lower-case letters, digits and hyphens`);
        st.imported = got;
        if (got.length === 1) {
          name.value = titleOf(got[0].md) || got[0].slug;
          slug.value = got[0].slug;
          st.slugEdited = true;
          const g = field(got[0].md, 'Group').toLowerCase();
          if (g && GROUP.test(g)) setGroup(g);
          const m = (field(got[0].md, 'Reports to').split(/\s/)[0] ?? '').toLowerCase();
          if ([...manager.options].some((o) => o.value === m)) manager.value = m;
        }
      } catch (err) {
        st.importError = `That file cannot be imported: ${err.message}`;
      }
    }
    if (t.id === 'a-group' && t.value === '+') setTimeout(() => $('#a-newgroup').focus());
    draw();
  };
  dlg.oninput = (e) => {
    if (e.target.id === 'a-name' && !st.slugEdited) slug.value = slugify(name.value);
    if (e.target.id === 'a-slug') st.slugEdited = !!slug.value;
    if (e.target.id === 'a-copy-q') st.q = e.target.value;
    draw();
  };
  dlg.onclick = (e) => {
    const card = e.target.closest('.start');
    if (card && card.dataset.start !== st.start && !e.target.closest('input[type=file]')) {
      st.start = card.dataset.start;
      card.querySelector('input[type=radio]').checked = true;
      draw();
    }
    const pick = e.target.closest('[data-from]');
    if (pick) {
      st.from = pick.dataset.from;
      const r = roleBy(st.from);
      if (r) { setGroup(r.group); if ([...manager.options].some((o) => o.value === r.reportsTo)) manager.value = r.reportsTo; }
      draw();
      dlg.querySelector(`[data-from="${CSS.escape(st.from)}"]`)?.focus();
    }
    if (e.target.dataset.act === 'cancel') dlg.close();
  };
  function setGroup(g) {
    if (![...group.options].some((o) => o.value === g)) group.insertBefore(new Option(g, g), group.querySelector('option[value="+"]'));
    group.value = g;
  }
  $('#a-go').onclick = () => {
    const p = plan();
    if (!Array.isArray(p)) return draw();
    const add = p.filter((a) => a.check.ok);
    const off = st.start === 'import';
    app.change((s) => { for (const a of add) { addAgent(s, a.slug, a.md); if (off) s.roles[a.slug].enabled = false; } });
    if (off) for (const a of add) imported.add(a.slug);
    dlg.close();
    if (add.length > 1) return app.select(add[0].slug);
    // One agent: straight into its editor. A copy remembers what it started from, so the preview can mark what differs.
    const src = st.start === 'copy' ? roleBy(st.from) : null;
    app.edit(add[0].slug, src ? { from: src.slug, title: src.title, md: src.md } : undefined);
  };

  // Defaults: the group and manager of whoever the owner is likely adding to (the first lane under the top role).
  const top = team.find((r) => r.reportsTo === 'owner');
  if (groups.includes('engineering')) group.value = 'engineering';
  const cto = team.find((r) => r.reportsTo === top?.slug && r.group === group.value) ?? top;
  if (cto) manager.value = cto.slug;
  draw();
  dlg.showModal();
  name.focus();
}
