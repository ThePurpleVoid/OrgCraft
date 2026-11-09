// The wiring view (B2.1, B2.2; demo step D5): one teammate in the middle, what wakes it on the left, and what it can
// use and who it hands work to on the right. Every wire is data the team already has:
//   - triggers: the teammate's structured "## Wakes on" lines;
//   - handoffs in and out: the structured "## Hands to" lines (ADR 0011, team-json-0.22 §1.3);
//   - systems: resources.json bindings, shown as Read, Change or Act (read, write and deploy in the file).
// Edits go through ctx.change, so undo, redo and the live checks work as on the canvas. Nothing here holds a secret:
// systems show their name only (B2.1-10).
//
// ctx: { spec(), change(fn), kit, view(), esc, select(slug), close(), setSection(slug, name, mode, text), resolved(slug) }
import { handsTo, membersOf, typeOf, wakesOn } from './team-model.mjs';
import { t, tip } from './i18n.js';
import { hintHtml } from './tooltip.js';

/** Read, Change and Act (the owner's words) for the file's read, write and deploy. */
export const LEVELS = [['read', 'perm.read'], ['write', 'perm.change'], ['deploy', 'perm.act']];
const levelWord = (p) => t(LEVELS.find(([k]) => k === p)?.[1] ?? 'perm.read');
const levelTip = (p) => tip(p === 'write' ? 'change' : p === 'deploy' ? 'act' : 'read');
/** Systems whose text comes from outside the team: the team reads it as information, never as instructions. */
const OUTSIDE = new Set(['email', 'chat', 'support', 'forms', 'webhook', 'website', 'social']);

let open = null; // { kind, key } of the wire whose inspector is open

/** Everything the view draws for teammate `slug`, from the draft. */
export function wiresOf(ctx, slug) {
  const spec = ctx.spec();
  const view = ctx.view();
  const roster = Object.keys(spec.roles);
  const md = ctx.resolved(slug);
  const type = typeOf(spec, slug);
  const onTeam = new Set(view.team.map((r) => r.slug));
  const out = handsTo(md, roster);
  const wakes = wakesOn(md);
  const triggers = wakes.triggers.map((x, i) => ({ kind: 'trigger', key: `t${i}`, label: x.value ? `${x.type}: ${x.value}` : x.type, trigger: x }));
  // Incoming: a teammate that names this one, or names its role while this is the only teammate with it.
  const alone = membersOf(spec, type).length === 1;
  const incoming = view.team.filter((r) => r.slug !== slug).flatMap((r) => handsTo(ctx.resolved(r.slug), roster).targets
    .filter((x) => x.to === slug || (alone && x.to === type))
    .map((x) => ({ kind: 'in', key: `in:${r.slug}`, from: r.slug, label: r.title, what: x.what ?? '' })));
  const systems = (spec.resources?.bindings ?? []).filter((b) => b.role === slug).map((b) => {
    const res = (spec.resources?.resources ?? []).find((x) => x.id === b.resource);
    return { kind: 'system', key: `s:${b.resource}`, resource: b.resource, label: res?.name || b.resource, type: res?.type ?? 'other', permission: b.permission };
  });
  const outside = systems.filter((s) => OUTSIDE.has(s.type)).map((s) => ({ kind: 'outside', key: `o:${s.resource}`, label: `${t('wire.outside')}: ${s.label}` }));
  const handoffs = out.targets.map((x, i) => ({
    kind: 'out', key: `out:${i}`, to: x.to, what: x.what ?? '',
    label: x.to === 'owner' ? (spec.values?.OWNER || 'The owner') : view.bySlug.get(x.to)?.title ?? x.to,
    off: x.to !== 'owner' && !onTeam.has(x.to) && !membersOf(spec, x.to).some((m) => onTeam.has(m)),
    several: x.to !== 'owner' && !spec.roles[x.to]?.source?.startsWith('member') && membersOf(spec, x.to).filter((m) => onTeam.has(m)).length > 1,
  }));
  // Lines the brief writes as prose ("A spec", "Shared core dev, backend tester…") are shown as notes: the team
  // reads them, but they are not wires until someone draws them (team-json-0.22 §6.4).
  return { md, type, triggers, incoming, outside, systems, handoffs, notes: out.text, wakeNotes: wakes.text };
}

/** The warnings this teammate's wiring raises before Publish (B2.1-8), in the CPO's words. */
export function wiringWarnings(ctx, slug, w = wiresOf(ctx, slug)) {
  const view = ctx.view();
  const me = view.bySlug.get(slug)?.title ?? slug;
  const out = [];
  for (const h of w.handoffs) {
    if (h.off) out.push(t('wire.handoff.off', { teammate: me, target: h.label }));
    else if (h.several) out.push(t('wire.handoff.ambiguous', { teammate: me, role: h.label, n: membersOf(ctx.spec(), h.to).filter((m) => view.team.some((r) => r.slug === m)).length }));
  }
  if (!w.triggers.length && !w.incoming.length && !w.wakeNotes.length && view.bySlug.get(slug)?.reportsTo !== 'owner') out.push(t('wire.handoff.nobody', { teammate: me }));
  return out;
}

export function renderWiring(el, ctx, slug) {
  const { esc } = ctx;
  const spec = ctx.spec();
  const view = ctx.view();
  const r = view.bySlug.get(slug);
  if (!r) { el.innerHTML = ''; return; }
  const w = wiresOf(ctx, slug);
  const warn = wiringWarnings(ctx, slug, w);
  const row = (x, side, inner, cls = '') => `<li class="wire-item ${side}${cls}${open?.key === x.key ? ' open' : ''}" data-key="${esc(x.key)}">
      <button type="button" class="wire-btn" data-wire="${esc(x.key)}" aria-expanded="${open?.key === x.key}">${inner}</button>
      ${x.kind === 'system' || x.kind === 'out' ? `<button type="button" class="link wire-del" data-del="${esc(x.key)}" aria-label="${esc(t('wiring.delete', { target: x.label }))}">✕</button>` : ''}</li>`;
  const left = [
    ...w.triggers.map((x) => row(x, 'in', `<span class="wkind" data-tip="${esc(tip('wire.wakes'))}">${esc(t('wiring.trigger'))}</span> ${esc(x.label)}`)),
    ...w.incoming.map((x) => row(x, 'in', `<span class="wkind" data-tip="${esc(tip('wire.handoff'))}">${esc(x.label)}</span>${x.what ? ` <span class="muted">${esc(x.what)}</span>` : ''}`)),
    ...w.outside.map((x) => row(x, 'in', `<span class="wkind outside" data-tip="${esc(tip('dashed.amber.wire.from.outside'))}">${esc(x.label)}</span>`, ' outside')),
  ];
  const unbound = (spec.resources?.resources ?? []).filter((x) => !w.systems.some((s) => s.resource === x.id));
  const targets = view.team.filter((x) => x.slug !== slug && !w.handoffs.some((h) => h.to === x.slug));
  const right = [
    ...w.systems.map((x) => row(x, 'out', `<span class="wkind" data-tip="${esc(levelTip(x.permission))}">${esc(levelWord(x.permission))}</span> ${esc(x.label)}`, ` level-${x.permission}`)),
    ...w.handoffs.map((x) => row(x, 'out', `<span class="wkind" data-tip="${esc(tip('wire.handoff'))}">→</span> ${esc(x.label)}${x.what ? ` <span class="muted">${esc(x.what)}</span>` : ''}`, x.off || x.several ? ' warn' : '')),
  ];
  const detail = open && [...w.triggers, ...w.incoming, ...w.outside, ...w.systems, ...w.handoffs].find((x) => x.key === open.key);
  el.innerHTML = `<div class="wiring" data-wiring="${esc(slug)}">
    <div class="row between wiring-head"><h2 class="flush">${esc(r.title)}</h2><button type="button" id="wiring-close">${esc(t('wiring.back'))}</button></div>
    ${hintHtml('wiring.view', esc)}
    <p class="hint wiring-explainer">${esc(t('wiring.explainer'))}</p>
    ${warn.length ? `<ul class="plain wiring-warn" role="status">${warn.map((x) => `<li class="warning">${esc(x)}</li>`).join('')}</ul>` : ''}
    <div class="wiring-cols">
      <section class="wcol" aria-labelledby="w-in"><h3 id="w-in">${esc(t('wiring.in'))}</h3>
        ${left.length ? `<ul class="plain">${left.join('')}</ul>` : w.wakeNotes.length ? '' : `<p class="muted empty">${esc(t('wiring.empty.in'))}</p>`}
        ${w.wakeNotes.length ? `<ul class="plain notes">${w.wakeNotes.map((x) => `<li class="note" data-tip="${esc(t('wiring.prose.tip'))}">${esc(t('wiring.prose', { text: x.replace(/^[-*]\s*/, '') }))}</li>`).join('')}</ul>` : ''}</section>
      <section class="wcol mid" aria-label="${esc(r.title)}"><h3>${esc(r.title)}</h3>
        <div class="wcard" id="wiring-drop" data-node="${esc(slug)}" tabindex="-1"><strong>${esc(r.title)}</strong><span class="muted">${esc(t('teammate.subtitle.ai', { role: r.typeTitle }))}</span></div></section>
      <section class="wcol" aria-labelledby="w-out"><h3 id="w-out">${esc(t('wiring.out'))}</h3>
        ${right.length ? `<ul class="plain">${right.join('')}</ul>` : ''}
        ${w.notes.length ? `<ul class="plain notes">${w.notes.map((x) => `<li class="note" data-tip="${esc(t('wiring.prose.tip'))}">${esc(t('wiring.prose', { text: x.replace(/^[-*]\s*/, '') }))}</li>`).join('')}</ul>` : ''}
        <div class="wadd">
          ${unbound.length ? `<div class="wtray" aria-label="${esc(t('inspector.systems'))}">${unbound.map((x) => `<button type="button" class="chip" draggable="true" data-sys="${esc(x.id)}" data-tip="${esc(tip('system'))}">${esc(x.name || x.id)}</button>`).join('')}</div>
          <p class="row"><label class="sr-only" for="w-sys">${esc(t('inspector.systems'))}</label><select id="w-sys">${unbound.map((x) => `<option value="${esc(x.id)}">${esc(x.name || x.id)}</option>`).join('')}</select>
            <label class="sr-only" for="w-level">${esc(t('wiring.level'))}</label><select id="w-level">${LEVELS.map(([k, s]) => `<option value="${k}">${esc(t(s))}</option>`).join('')}</select>
            <button type="button" id="w-bind">${esc(t('wiring.addsystem'))}</button></p>` : ''}
          <p class="row"><label class="sr-only" for="w-to">${esc(t('wiring.addhandoff'))}</label><select id="w-to"><option value="owner">${esc(spec.values?.OWNER || 'The owner')}</option>${targets.map((x) => `<option value="${esc(x.slug)}">${esc(x.title)}</option>`).join('')}</select>
            <input id="w-what" maxlength="200" placeholder="${esc(t('wiring.what'))}" aria-label="${esc(t('wiring.what'))}">
            <button type="button" id="w-hand">${esc(t('wiring.addhandoff'))}</button></p>
        </div></section>
    </div>
    <div id="wire-detail" class="wire-detail" role="region" aria-live="polite" aria-label="Wire">${detail ? detailHtml(ctx, detail) : ''}</div>
    <div id="wire-pick" class="wire-pick" role="dialog" aria-modal="false" aria-label="${ctx.esc(t('wiring.level'))}" hidden></div>
    <svg class="wiring-lines" aria-hidden="true"></svg>
  </div>`;
  drawLines(el);
}

function detailHtml(ctx, x) {
  const { esc } = ctx;
  if (x.kind === 'system') return `<h3>${esc(x.label)}</h3>
    <p><label for="wd-level">${esc(t('wiring.level'))}</label> <select id="wd-level" data-res="${esc(x.resource)}">${LEVELS.map(([k, s]) => `<option value="${k}"${k === x.permission ? ' selected' : ''}>${esc(t(s))}</option>`).join('')}</select></p>
    <p class="hint">${esc(levelTip(x.permission))}${x.permission === 'deploy' ? ` ${esc(t('perm.act.hint'))}` : ''}</p>`;
  if (x.kind === 'out') return `<h3>→ ${esc(x.label)}</h3><p>${esc(x.what || '—')}</p><p class="hint">${esc(tip('wire.handoff'))}</p>`;
  if (x.kind === 'in') return `<h3>${esc(x.label)} →</h3><p>${esc(x.what || '—')}</p><p class="hint">${esc(tip('wire.handoff'))}</p>`;
  if (x.kind === 'outside') return `<h3>${esc(x.label)}</h3><p class="hint">${esc(tip('dashed.amber.wire.from.outside'))}</p>`;
  return `<h3>${esc(x.label)}</h3><p class="hint">${esc(tip('wire.wakes'))}</p>`;
}

/** Lines from each left item to the teammate, and from the teammate to each right item. Wide screens only. */
export function drawLines(el) {
  const svg = el.querySelector('.wiring-lines');
  const box = el.querySelector('.wiring');
  const card = el.querySelector('#wiring-drop');
  if (!svg || !box || !card || matchMedia('(max-width: 640px)').matches) { if (svg) svg.innerHTML = ''; return; }
  const b = box.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  svg.setAttribute('width', b.width); svg.setAttribute('height', b.height);
  const paths = [];
  for (const li of el.querySelectorAll('.wire-item')) {
    const r = li.getBoundingClientRect();
    const y1 = r.top + r.height / 2 - b.top;
    const y2 = c.top + c.height / 2 - b.top;
    const [x1, x2] = li.classList.contains('in') ? [r.right - b.left, c.left - b.left] : [c.right - b.left, r.left - b.left];
    const [ya, yb] = li.classList.contains('in') ? [y1, y2] : [y2, y1];
    const mx = (x1 + x2) / 2;
    paths.push(`<path class="wline${li.classList.contains('outside') ? ' outside' : ''}${li.classList.contains('warn') ? ' warn' : ''}" d="M${x1},${ya} C${mx},${ya} ${mx},${yb} ${x2},${yb}"></path>`);
  }
  svg.innerHTML = paths.join('');
}

/** The Hands to section text after `targets` change, keeping the prose lines as they were. */
function handsText(w, targets) {
  return [...targets.map((x) => (x.what ? `- ${x.to}: ${x.what}` : `- ${x.to}`)), ...w.notes].join('\n');
}

export function wireWiring(el, ctx, current) {
  const spec = () => ctx.spec();
  const w = () => wiresOf(ctx, current());
  const setLevel = (resource, permission) => ctx.change((s) => { const b = s.resources.bindings.find((x) => x.role === current() && x.resource === resource); if (b) b.permission = permission; });
  const bind = (resource, permission) => ctx.change((s) => { s.resources ??= { resources: [], bindings: [] }; s.resources.bindings ??= []; if (!s.resources.bindings.some((x) => x.role === current() && x.resource === resource)) s.resources.bindings.push({ role: current(), resource, permission }); });
  el.addEventListener('click', (e) => {
    if (e.target.closest('#wiring-close')) { open = null; return ctx.close(); }
    const del = e.target.closest('[data-del]');
    if (del) {
      const k = del.dataset.del;
      open = null;
      if (k.startsWith('s:')) return ctx.change((s) => { s.resources.bindings = s.resources.bindings.filter((x) => !(x.role === current() && x.resource === k.slice(2))); });
      const cur = w();
      const keep = cur.handoffs.filter((x) => x.key !== k).map(({ to, what }) => ({ to, what }));
      return ctx.setSection(current(), 'Hands to', 'replace', handsText(cur, keep));
    }
    const wb = e.target.closest('[data-wire]');
    if (wb) { open = open?.key === wb.dataset.wire ? null : { key: wb.dataset.wire }; return ctx.render(); }
    if (e.target.closest('#w-bind')) return bind(el.querySelector('#w-sys').value, el.querySelector('#w-level').value);
    if (e.target.closest('#w-hand')) {
      const cur = w();
      const to = el.querySelector('#w-to').value;
      const what = el.querySelector('#w-what').value.trim().slice(0, 200);
      return ctx.setSection(current(), 'Hands to', 'replace', handsText(cur, [...cur.handoffs.map(({ to: x, what: y }) => ({ to: x, what: y })), { to, what }]));
    }
    const pick = e.target.closest('[data-pick-level]');
    if (pick) { const p = el.querySelector('#wire-pick'); p.hidden = true; return bind(p.dataset.res, pick.dataset.pickLevel); }
  });
  el.addEventListener('change', (e) => { if (e.target.id === 'wd-level') setLevel(e.target.dataset.res, e.target.value); });
  // B2.1-3: drag a system onto the teammate, then pick Read, Change or Act where it dropped.
  el.addEventListener('dragstart', (e) => { const c = e.target.closest('[data-sys]'); if (c) { e.dataTransfer.setData('text/x-system', c.dataset.sys); e.dataTransfer.effectAllowed = 'link'; } });
  el.addEventListener('dragover', (e) => { if (e.target.closest('#wiring-drop')) { e.preventDefault(); e.target.closest('#wiring-drop').classList.add('drop'); } });
  el.addEventListener('dragleave', (e) => e.target.closest?.('#wiring-drop')?.classList.remove('drop'));
  el.addEventListener('drop', (e) => {
    const card = e.target.closest('#wiring-drop');
    const res = e.dataTransfer.getData('text/x-system');
    if (!card || !res) return;
    e.preventDefault();
    card.classList.remove('drop');
    const p = el.querySelector('#wire-pick');
    const name = (spec().resources?.resources ?? []).find((x) => x.id === res)?.name ?? res;
    p.dataset.res = res;
    p.innerHTML = `<p><strong>${ctx.esc(name)}</strong></p><p class="row">${LEVELS.map(([k, s]) => `<button type="button" data-pick-level="${k}" data-tip="${ctx.esc(levelTip(k))}">${ctx.esc(t(s))}</button>`).join('')}</p><p class="hint">${ctx.esc(t('perm.act.hint'))}</p>`;
    p.hidden = false;
    p.querySelector('button').focus();
  });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.querySelector('#wire-pick').hidden) { el.querySelector('#wire-pick').hidden = true; el.querySelector('#wiring-drop').focus(); } });
}
