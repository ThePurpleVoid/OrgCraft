// Who you are on this deployment, your workspaces, and your passkeys (docs/specs/m4-sign-in.md sections 3 and 4).
// A person needs at least one passkey before they can approve anything, so a person without one is asked to add one
// straight after signing in. The first passkey needs only a fresh sign-in; adding another or removing one needs
// step-up with an existing passkey.
import { addPasskey, call, ensureSignedIn, esc, needsStepUp, signOut, stepUpDialog, withStepUp } from './auth.js';

const root = document.getElementById('account');
const dlg = document.getElementById('passkey-add');
let me = null;
let keys = [];
let note = '';

const fmt = (t) => (t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

function render() {
  const ws = (me.workspaces ?? []).map((w) => `<li>${esc(w.name ?? w.tenant)} <span class="pill">${esc(w.role)}</span></li>`).join('');
  const rows = keys.map((k) => `<li class="passkey row"><span><strong>${esc(k.name || 'Passkey')}</strong> <span class="muted">added ${esc(fmt(k.createdAt))}${k.lastUsed ? `, last used ${esc(fmt(k.lastUsed))}` : ''}</span></span><button type="button" class="danger" data-remove="${esc(k.id)}">Remove</button></li>`).join('');
  root.innerHTML = `
    <p>Signed in as <strong>${esc(me.name || me.login)}</strong>${me.name && me.login ? ` <span class="muted">(${esc(me.login)} on GitHub)</span>` : ''}.</p>
    <h2>Workspaces</h2>
    ${ws ? `<ul class="plain">${ws}</ul>` : '<p class="muted">None yet.</p>'}
    <h2>Passkeys</h2>
    ${keys.length ? '' : '<p class="notice" role="status">Add a passkey before you can approve anything. It takes a few seconds.</p>'}
    ${rows ? `<ul class="plain">${rows}</ul>` : ''}
    <p><button type="button" class="${keys.length ? '' : 'primary'}" id="add">Add a passkey</button></p>
    ${note ? `<p class="result error" role="alert">${esc(note)}</p>` : ''}
    <p class="signout"><button type="button" id="signout">Sign out</button></p>`;
}

async function load() {
  me = await ensureSignedIn();
  if (!me) return;
  const r = await call('GET', '/v1/me/passkeys');
  keys = r.ok ? (Array.isArray(r.data) ? r.data : r.data.passkeys ?? []) : [];
  render();
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
  let r = await addPasskey(name);
  // Every passkey after the first, or the first one long after signing in, needs one you already have.
  if (needsStepUp(r)) {
    dlg.close();
    const header = keys.length ? await stepUpDialog('Adding a passkey lets that device approve things for you.') : null;
    if (!keys.length) { note = 'Your sign-in is too old to add a first passkey. Sign out and in again, then add it.'; button.disabled = false; return render(); }
    if (!header) { button.disabled = false; return; }
    dlg.showModal();
    r = await addPasskey(name, header);
  }
  button.disabled = false;
  if (!r.ok) { out.textContent = r.data.error ?? `HTTP ${r.status}`; return; }
  dlg.close();
  note = '';
  await load();
});
document.getElementById('passkey-add-cancel').onclick = () => { try { sessionStorage.setItem('passkey-later', '1'); } catch { /* private mode */ } dlg.close(); };

root.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'add') return openAdd();
  if (b.id === 'signout') return signOut();
  if (b.dataset.remove) {
    const k = keys.find((x) => x.id === b.dataset.remove);
    if (!confirm(`Remove the passkey "${k?.name || 'Passkey'}"? That device can no longer confirm it is you.`)) return;
    const r = await withStepUp('Removing a passkey changes how you can prove it is you.', 'DELETE', `/v1/me/passkeys/${encodeURIComponent(b.dataset.remove)}`);
    note = r.ok || r.cancelled ? '' : r.data.error ?? `HTTP ${r.status}`;
    await load();
  }
});

load().catch((e) => { root.innerHTML = `<p class="result error" role="alert">${esc(e.message)}</p>`; });
