// Live overrides in the Studio (L18; SH-5, SH-10, G38.4): Stop everything in the More menu, Pause on a teammate, and
// a banner for every live change in force, each with Resume. Setting one is one tap with no passkey and touches no
// Git, code host or publish: it goes straight to the control plane. Lifting one asks for the passkey step-up, bound
// to that change (lift:<id>). The banner is drawn only from the control plane's list, so a run that starts never
// hides it: only a lift does.
import { t } from './i18n.js';
import { $, requestJson } from './env.js';
import { showItems } from './systems.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

async function api(path, body) {
  const res = await requestJson(path, body);
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  return { ok: res.ok, status: res.status, data };
}
const needsStepUp = (r) => r.status === 401 && /step-up-required$/.test(r.data.type ?? '');

/** The passkey step-up (until OIDC, the step-up secret), bound to `scope`. Resolves true once the Studio holds one. */
export function stepUp(why, scope, lines = []) {
  const dlg = $('#live-stepup');
  const form = dlg.querySelector('form');
  const input = dlg.querySelector('input');
  const result = dlg.querySelector('.result');
  dlg.querySelector('.why').textContent = t('stepup.body', { action: why });
  showItems(dlg.querySelector('.why'), lines);
  result.textContent = '';
  input.value = '';
  return new Promise((done) => {
    const finish = (ok) => { form.onsubmit = null; dlg.querySelector('[data-act="cancel"]').onclick = null; dlg.oncancel = null; if (dlg.open) dlg.close(); done(ok); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const go = form.querySelector('button[type="submit"]');
      if (go.disabled) return;
      const secret = input.value;
      input.value = '';
      go.disabled = true;
      const r = await api('/v1/team/step-up', { secret, ...(scope ? { scope } : {}) }).finally(() => { go.disabled = false; });
      if (r.ok) return finish(true);
      result.textContent = t(r.status === 429 ? 'stepup.locked' : 'stepup.failed');
      input.focus();
    };
    dlg.querySelector('[data-act="cancel"]').onclick = () => finish(false);
    dlg.oncancel = () => finish(false);
    dlg.showModal();
    input.focus();
  });
}

/**
 * `say(text)` shows a short status line; `titleOf(member)` names a teammate. Returns { load, render, pause, isPaused,
 * connected }. Every action reads the list again from the control plane before drawing.
 */
export function createLive({ say = () => {}, titleOf = (x) => x, onChange = () => {} } = {}) {
  const st = { connected: false, items: [], error: null, busy: false };

  function render() {
    const halted = st.items.some((x) => x.kind === 'halt');
    const stop = $('#stop-all');
    if (stop) { stop.hidden = !st.connected; stop.disabled = halted || st.busy; stop.setAttribute('aria-pressed', String(halted)); }
    const box = $('#live-banner');
    if (!box) return;
    box.hidden = !st.items.length && !st.error;
    box.innerHTML = st.items.map((x) => `<p class="live-row" data-live="${esc(x.id)}"><span class="live-text">${esc(x.kind === 'halt' ? t('stop.all.done') : t(`stop.member.${x.state === 'off' ? 'off' : 'paused'}`, { teammate: titleOf(x.member) }))}</span>${x.reason ? ` <span class="muted">${esc(x.reason)}</span>` : ''}
        <button type="button" data-lift="${esc(x.id)}" aria-label="${esc(`${t('stop.resume')}: ${x.kind === 'halt' ? t('stop.all') : titleOf(x.member)}`)}">${esc(t('stop.resume'))}</button></p>`).join('')
      + (st.items.length ? `<p class="hint">${esc(t('stop.resume.passkey'))}</p>` : '')
      + (st.error ? `<p class="result error">${esc(st.error)}</p>` : '');
    // Redraw the page only when what is in force changed, so a poll never disturbs someone typing.
    const key = JSON.stringify([st.connected, st.items.map((x) => [x.id, x.state])]);
    if (key !== st.drawn) { st.drawn = key; onChange(); }
  }

  async function load() {
    const r = await api('/v1/team/live');
    st.connected = r.ok && !!r.data.connected;
    // A failed read keeps what was shown: a live change never disappears because one read failed.
    if (r.ok) { st.items = r.data.live ?? []; st.error = null; } else if (st.connected) st.error = r.data.error ?? `HTTP ${r.status}`;
    render();
  }

  async function act(fn) {
    st.busy = true; render();
    try { const r = await fn(); st.error = r.ok ? null : r.data.error ?? `HTTP ${r.status}`; return r; } finally { st.busy = false; await load(); }
  }

  /** SH-5: one tap, no passkey, no confirm: stopping must never wait. */
  const stopAll = () => act(async () => { const r = await api('/v1/team/live/stop-everything', { key: newId() }); if (r.ok) say(t('stop.all.done')); return r; });
  /** SH-10: a teammate stops taking work at once, from any screen size; no Git, code host or publish involved. */
  const pause = (member) => act(() => api(`/v1/team/live/members/${encodeURIComponent(member)}`, { state: 'paused', key: newId() }))
    .then((r) => { const box = $('#live-banner'); if (r?.ok && box && !box.hidden) box.scrollIntoView({ block: 'nearest' }); return r; });
  /** Resume: the control plane asks for a step-up bound to this change; nothing is lifted without it. */
  const lift = (id) => liftOnce(id).finally(() => {
    const again = [...document.querySelectorAll('#live-banner [data-lift]')].find((b) => b.dataset.lift === id);
    if (again) again.focus();
  });
  const liftOnce = (id) => act(async () => {
    const x = st.items.find((i) => i.id === id);
    let r = await api('/v1/team/live/lift', { id });
    if (needsStepUp(r)) {
      const action = x?.kind === 'member' ? t('stepup.action.resume.member', { teammate: titleOf(x.member) }) : t('stepup.action.resume.team');
      if (!(await stepUp(action, r.data.scope ?? `lift:${id}`))) return { ok: true, data: {} };
      r = await api('/v1/team/live/lift', { id });
    }
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (r.ok) say(x?.kind === 'member' ? t('stop.resumed.you.member', { teammate: titleOf(x.member), time }) : t('stop.resumed.you', { time }));
    return r;
  });

  function wire(signal) {
    $('#stop-all')?.addEventListener('click', stopAll, { signal });
    $('#live-banner')?.addEventListener('click', (e) => { const b = e.target.closest('[data-lift]'); if (b) lift(b.dataset.lift); }, { signal });
  }

  return {
    load, render, wire, pause, lift, stopAll,
    get connected() { return st.connected; },
    isPaused: (member) => st.items.some((x) => x.kind === 'member' && x.member === member),
  };
}
