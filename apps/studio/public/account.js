// Who you are on this deployment, your workspaces, and your passkeys (docs/specs/m4-sign-in.md sections 3 and 4).
// A person needs at least one passkey before they can approve anything, so a person without one is asked to add one
// straight after signing in. The first passkey needs only a fresh sign-in; adding another or removing one needs
// step-up with an existing passkey.
import { addPasskey, call, dismissNotices, ensureSignedIn, esc, loadRecovery, needsStepUp, noticesBanner, orgName, recoveryBanner, signOut, stepUpDialog, withStepUp } from './auth.js';
import { t } from './i18n.js';
import { infoButton, installTips } from './tooltip.js';

const root = document.getElementById('account');
const dlg = document.getElementById('passkey-add');
let me = null;
let keys = [];
let note = '';
let rec = null; // GET /v1/recovery for an owner or admin (L27)
let owners = []; // the workspace's owners, who can be named (GET /v1/members)
let recNote = null; // { kind, text }

/** A role in the CPO's words (role.*); anything unknown is "Limited access", never the raw value. */
export const roleWord = (role) => (['owner', 'admin', 'approver', 'editor', 'viewer', 'member'].includes(role) ? t(`role.${role}`) : t('role.unknown'));
const fmt = (t) => (t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

function render() {
  const ws = (me.workspaces ?? []).map((w) => `<li>${esc(w.name ?? w.tenant)} <span class="pill">${esc(roleWord(w.role))}</span>${w.role === 'member' ? ` ${infoButton(t('role.member.tip'), esc, roleWord(w.role))}` : ''}</li>`).join('');
  const rows = keys.map((k) => `<li class="passkey row"><span><strong>${esc(k.name || 'Passkey')}</strong> <span class="muted">added ${esc(fmt(k.createdAt))}${k.lastUsed ? `, last used ${esc(fmt(k.lastUsed))}` : ''}</span></span><button type="button" class="danger" data-remove="${esc(k.id)}">Remove</button></li>`).join('');
  root.innerHTML = `
    ${noticesBanner(me)}
    ${recoveryBanner(rec, me)}
    <p>Signed in as <strong>${esc(me.name || me.login)}</strong>${me.name && me.login ? ` <span class="muted">(${esc(me.login)} on GitHub)</span>` : ''}.</p>
    <h2>${esc(t('account.orgs.heading'))}</h2>
    <p class="muted">${esc(t('account.orgs.intro'))}</p>
    ${ws ? `<ul class="plain">${ws}</ul>` : '<p class="muted">None yet.</p>'}
    <h2>Passkeys</h2>
    ${keys.length ? '' : '<p class="notice" role="status">Add a passkey before you can approve anything. It takes a few seconds.</p>'}
    ${rows ? `<ul class="plain">${rows}</ul>` : ''}
    <p><button type="button" class="${keys.length ? '' : 'primary'}" id="add">Add a passkey</button></p>
    ${note ? `<p class="result error" role="alert">${esc(note)}</p>` : ''}
    ${recoveryHtml()}
    <p class="signout"><button type="button" id="signout">Sign out</button></p>`;
}

/** Security › Recovery owners (L27, mockup v19 G38.9): who can let someone back in, and naming or removing one. */
export function recoveryHtml(r = rec, list = owners, self = me, n = recNote) {
  if (!r) return '';
  const org = orgName(self);
  const isOwner = (self?.workspaces ?? []).some((w) => w.role === 'owner');
  const when = (iso) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const rows = r.owners.map((o) => {
    const pending = o.why === 'pending';
    const since = pending ? t('recovery.pending.cell', { time: when(o.effectiveAt) }) : fmt(o.effectiveAt);
    const act = isOwner ? `<button type="button" data-rec-remove="${esc(o.person)}" data-name="${esc(o.name)}"${pending ? ' data-pending="1"' : ''}>${esc(t(pending ? 'recovery.cancel' : 'recovery.remove'))}</button>` : '';
    return `<tr${pending ? ' class="pending"' : ''}><td>${esc(o.name)}</td><td>${esc(since)}</td><td>${o.methods.includes('passkey') ? `<span aria-hidden="true">✓</span><span class="sr-only">${esc(t('recovery.passkey.yes'))}</span>` : `<span aria-hidden="true">–</span><span class="sr-only">${esc(t('recovery.passkey.no'))}</span>`}</td><td>${act}</td></tr>`;
  }).join('');
  const warn = r.warnings.filter((w) => w.code !== 'fewer-than-two').map((w) => {
    const name = r.owners.find((o) => o.person === w.person)?.name ?? '';
    return `<p class="notice" role="status">${esc(t(w.code === 'no-passkey' ? 'recovery.warn.nopasskey' : 'recovery.warn.notowner', { person: name }))}</p>`;
  }).join('');
  const named = new Set(r.owners.map((o) => o.person));
  const choices = list.filter((m) => !named.has(m.person));
  const add = isOwner && choices.length ? `<form id="rec-add" class="row"><label>${esc(t('recovery.col.person'))} <select name="person">${choices.map((m) => `<option value="${esc(m.person)}">${esc(m.name || m.login)}</option>`).join('')}</select></label><button type="submit" class="primary">${esc(t('recovery.add'))}</button></form><p class="hint">${esc(t('recovery.add.hint'))}</p>` : '';
  return `<section id="recovery" aria-labelledby="security-title">
    <h2 id="security-title">${esc(t('security.title'))}</h2>
    <h3 id="recovery-title">${esc(t('recovery.title'))}</h3>
    <p class="muted">${esc(t('recovery.explainer', { organization: org }))}</p>
    ${warn}
    ${rows ? `<div class="table-wrap"><table class="recovery"><thead><tr><th scope="col">${esc(t('recovery.col.person'))}</th><th scope="col">${esc(t('recovery.col.since'))}</th><th scope="col">${esc(t('recovery.col.passkeys'))}</th><th scope="col"><span class="sr-only">${esc(t('recovery.remove'))}</span></th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
    ${add}
    ${n ? `<p class="result ${n.kind === 'error' ? 'error' : 'ok'}" role="${n.kind === 'error' ? 'alert' : 'status'}">${esc(n.text)}</p>` : ''}
  </section>`;
}

/** True when `person` is the only recovery owner who counts or is on the way: removing them leaves nobody. */
export function lastOwner(r, person) {
  const live = (r?.owners ?? []).filter((o) => o.why !== 'pending');
  return live.length <= 1 && live.some((o) => o.person === person);
}

/** The last-owner warning, before any passkey (qa-web L27w round 1). Resolves true for "Remove anyway". */
function confirmLast(name) {
  let d = document.getElementById('recovery-last');
  if (!d) {
    d = document.createElement('dialog');
    d.id = 'recovery-last';
    d.className = 'auth-dialog';
    d.setAttribute('aria-labelledby', 'recovery-last-text');
    d.innerHTML = `<form class="dialog" method="dialog"><p id="recovery-last-text"></p><div class="dialog-actions"><button type="button" data-act="keep">${esc(t('recovery.cancel'))}</button><button type="button" class="danger" data-act="go">${esc(t('recovery.remove.last.confirm'))}</button></div></form>`;
    document.body.append(d);
  }
  d.querySelector('#recovery-last-text').textContent = t('recovery.remove.last', { person: name, organization: orgName(me) });
  return new Promise((done) => {
    const finish = (v) => { d.oncancel = null; d.querySelector('[data-act="go"]').onclick = null; d.querySelector('[data-act="keep"]').onclick = null; if (d.open) d.close(); done(v); };
    d.querySelector('[data-act="go"]').onclick = () => finish(true);
    d.querySelector('[data-act="keep"]').onclick = () => finish(false);
    d.oncancel = (e) => { e.preventDefault(); finish(false); };
    d.showModal();
    d.querySelector('[data-act="keep"]').focus();
  });
}

/** A refused DELETE /v1/recovery/{person}: the last-owner rule in its own words, anything else says nothing changed. */
function removeRefusal(r) {
  if (r.data?.type === 'last-owner') return t('recovery.failed', { organization: orgName(me) });
  return r.status ? t('recovery.failed.generic') : t('notify.failed');
}

/** The refusals of POST /v1/recovery in the CPO's words (409 types not-owner, no-passkey); others say it failed. */
function recoveryRefusal(r, name) {
  if (r.data?.type === 'not-owner') return t('recovery.warn.notowner', { person: name });
  if (r.data?.type === 'no-passkey') return t('recovery.warn.nopasskey', { person: name });
  return r.status ? t('recovery.failed.generic') : t('notify.failed');
}

async function load() {
  me = await ensureSignedIn();
  if (!me) return;
  const r = await call('GET', '/v1/me/passkeys');
  keys = r.ok ? (Array.isArray(r.data) ? r.data : r.data.passkeys ?? []) : [];
  rec = await loadRecovery(me);
  if (rec) {
    const m = await call('GET', '/v1/members');
    owners = m.ok ? (m.data.members ?? []).filter((x) => x.role === 'owner') : [];
  }
  render();
  if (location.hash === '#recovery') document.getElementById('recovery-title')?.scrollIntoView?.({ block: 'start' });
  if (!keys.length && !sessionStorage.getItem?.('passkey-later')) openAdd();
}

function openAdd() {
  document.getElementById('passkey-add-result').textContent = '';
  document.getElementById('passkey-name').value = '';
  dlg.showModal();
}

document.getElementById('passkey-add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = document.getElementById('passkey-add-result');
  const name = document.getElementById('passkey-name').value.trim() || 'Passkey';
  const button = e.submitter ?? dlg.querySelector('button[type="submit"]');
  button.disabled = true;
  out.textContent = '';
  // Every passkey after the first needs one you already have. Ask first: creating the new credential before the
  // server says no would leave a passkey on the device that the server never heard of (code review, PR #59).
  let header = {};
  if (keys.length) {
    dlg.close();
    header = await stepUpDialog(t('stepup.action.passkey.add'));
    button.disabled = false;
    if (!header) return;
    dlg.showModal();
    button.disabled = true;
  }
  const r = await addPasskey(name, header);
  button.disabled = false;
  // A first passkey needs a sign-in under 5 minutes old; after that, the only way is to sign in again.
  if (needsStepUp(r) && !keys.length) { dlg.close(); note = 'Your sign-in is too old to add a first passkey. Sign out and in again, then add it.'; return render(); }
  if (!r.ok) { out.textContent = r.data.error ?? `HTTP ${r.status}`; return; }
  dlg.close();
  note = '';
  await load();
});
document.getElementById('passkey-add-cancel').onclick = () => { try { sessionStorage.setItem('passkey-later', '1'); } catch { /* private mode */ } dlg.close(); };

root.addEventListener('submit', async (e) => {
  if (e.target.id !== 'rec-add') return;
  e.preventDefault();
  const sel = e.target.person;
  const name = sel.selectedOptions[0]?.textContent ?? '';
  const r = await withStepUp(t('stepup.action.recovery.add', { person: name }), 'POST', '/v1/recovery', { person: sel.value });
  if (r.cancelled) return;
  recNote = r.ok ? (r.data.pending ? { kind: 'ok', text: t('recovery.pending', { person: name, time: new Date(r.data.effectiveAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }) } : null) : { kind: 'error', text: recoveryRefusal(r, name) };
  await load();
});

root.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.recRemove) {
    const name = b.dataset.name;
    const pending = !!b.dataset.pending;
    if (!pending && lastOwner(rec, b.dataset.recRemove) && !(await confirmLast(name))) return b.focus();
    const r = await withStepUp(t(pending ? 'stepup.action.recovery.cancel' : 'stepup.action.recovery.remove', { person: name }), 'DELETE', `/v1/recovery/${encodeURIComponent(b.dataset.recRemove)}`);
    if (r.cancelled) return;
    recNote = r.ok ? null : { kind: 'error', text: removeRefusal(r) };
    return load();
  }
  if (b.id === 'notices-ok') { dismissNotices(me); return render(); }
  if (b.id === 'add') return openAdd();
  if (b.id === 'signout') return signOut();
  if (b.dataset.remove) {
    const k = keys.find((x) => x.id === b.dataset.remove);
    if (!confirm(`Remove the passkey "${k?.name || 'Passkey'}"? That device can no longer confirm it is you.`)) return;
    const r = await withStepUp(t('stepup.action.passkey.remove'), 'DELETE', `/v1/me/passkeys/${encodeURIComponent(b.dataset.remove)}`);
    note = r.ok || r.cancelled ? '' : r.data.error ?? `HTTP ${r.status}`;
    await load();
  }
});

installTips(document.body);
load().catch((e) => { root.innerHTML = `<p class="result error" role="alert">${esc(e.message)}</p>`; });
