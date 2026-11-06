// The Notifications page of a hosted Studio, /teams/{team}/notifications (CPO story "email notifications", D49 to
// D54, opt-in copy). It is a person's own page: their addresses for this team, the code that verifies each one, and
// which kinds they want. Nothing is emailed until an address is verified and at least one kind is saved (D49), so the
// first time the suggested kinds are shown ticked with a Save button, never saved on their own. Every email links back
// here through "Manage all emails" (kit #101).
//
// The API (apps/server, kit #101): GET/POST /v1/teams/{team}/emails, POST …/emails/{id}/verify { code },
// PATCH …/emails/{id} { kinds }, DELETE …/emails/{id}. The page only calls its own origin, with the session cookie.
import { call, dismissNotices, ensureSignedIn, esc, noticesBanner } from './auth.js';

/** The team in /teams/{team}/notifications, or null. */
export function teamFromPath(pathname) {
  const m = /^\/teams\/([^/]+)\/notifications\/?$/.exec(pathname ?? '');
  if (!m) return null;
  try { const t = decodeURIComponent(m[1]); return /^[a-z0-9][a-z0-9_-]{0,62}$/i.test(t) ? t : null; } catch { return null; }
}

/** Words under a kind's switch (copy): only approvals carry one. */
const UNDER = { approval: 'The email links to the Studio. You always approve there, never by replying.' };

/** The ticks to show for an address: its saved kinds, or the suggested ones when nothing is saved yet (D49). */
export function shownKinds(sub, kinds, cleared = false) {
  if (sub.kinds?.length || cleared) return new Set(sub.kinds ?? []);
  return new Set(kinds.filter((k) => k.suggested).map((k) => k.id));
}

/**
 * The Emails section. st: { kinds, emails, adding, cleared: Set(id) (addresses this visit switched every kind off on,
 * which show no suggestions again), notes: Map(id|'add' → { kind, text }) }.
 */
export function emailsHtml(st) {
  const note = (key) => { const n = st.notes.get(key); return n ? `<p class="result ${n.kind === 'error' ? 'error' : 'ok'}" role="${n.kind === 'error' ? 'alert' : 'status'}">${esc(n.text)}</p>` : ''; };
  const verified = (s) => {
    const cleared = !!st.cleared?.has(s.id);
    const on = shownKinds(s, st.kinds, cleared);
    const first = !s.kinds?.length && !cleared;
    const boxes = st.kinds.map((k) => `<li><label class="switch"><input type="checkbox" data-sub="${esc(s.id)}" data-kind="${esc(k.id)}"${on.has(k.id) ? ' checked' : ''}> ${esc(k.label)}</label>${UNDER[k.id] ? `<p class="hint">${esc(UNDER[k.id])}</p>` : ''}</li>`).join('');
    return `<div class="n-address" data-id="${esc(s.id)}">
      <p class="row"><strong>${esc(s.email)}</strong> <button type="button" class="link" data-remove="${esc(s.id)}">Remove</button></p>
      <p>Verified. Choose what to email you about:</p>
      <ul class="plain n-kinds">${boxes}</ul>
      ${first ? `<p class="hint">Nothing is emailed to this address yet. These are suggested to start with; change them, then save.</p><p><button type="button" class="primary" data-save="${esc(s.id)}">Save</button></p>` : ''}
      ${note(s.id)}
    </div>`;
  };
  const pending = (s) => `<form class="n-address n-verify" data-id="${esc(s.id)}">
      <p>We sent a code to <strong>${esc(s.email)}</strong>. It works for 15 minutes.</p>
      <p class="row"><label>Code <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required size="8"></label>
      <button type="submit" class="primary">Verify</button></p>
      <p class="row"><button type="button" class="link" data-resend="${esc(s.id)}">Send a new code</button> <button type="button" class="link" data-remove="${esc(s.id)}">Use another address</button></p>
      ${note(s.id)}
    </form>`;
  const add = !st.emails.length || st.adding
    ? `<form id="email-add" class="n-address"><p class="row"><label>Your email address <input type="email" name="email" required autocomplete="email" maxlength="254"></label>
        <button type="submit" class="primary">Send a code</button></p>${note('add')}</form>`
    : `<p><button type="button" id="email-another">Add another address</button></p>${note('add')}`;
  return `<section class="n-section" aria-labelledby="emails-title">
    <h2 id="emails-title">Emails</h2>
    <p>Get an email when something needs you. Nothing is sent until you verify your address and choose what you want.</p>
    ${st.emails.map((s) => (s.verified ? verified(s) : pending(s))).join('')}
    ${add}
  </section>`;
}

const errorOf = (r) => r.data?.error ?? r.data?.title ?? `HTTP ${r.status}`;

function start() {
  const root = document.getElementById('notifications');
  const team = teamFromPath(location.pathname);
  const st = { me: null, kinds: [], emails: [], adding: false, cleared: new Set(), notes: new Map() };
  const base = () => `/v1/teams/${encodeURIComponent(team)}/emails`;

  function render() {
    root.innerHTML = `${noticesBanner(st.me)}
      <p class="muted">For ${esc(team)}. Only you see these settings.</p>
      ${emailsHtml(st)}`;
  }
  async function load() {
    const r = await call('GET', base());
    if (!r.ok) throw new Error(r.status === 404 ? `There is no team called ${team} here, or you are not on it.` : errorOf(r));
    st.kinds = r.data.kinds ?? [];
    st.emails = r.data.emails ?? [];
    render();
  }
  const say = (key, kind, text) => { st.notes.clear(); if (text) st.notes.set(key, { kind, text }); };
  /** After a code was asked for: sent, or why not (no email sink yet, or no provider key). */
  const sent = (r) => (r.data.sent === false && r.data.reason && !r.data.verified ? ['error', `The code could not be sent: ${r.data.reason}.`] : ['ok', '']);

  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    if (form.id === 'email-add') {
      const r = await call('POST', base(), { email: form.email.value.trim() });
      button.disabled = false;
      if (!r.ok) { say('add', 'error', errorOf(r)); return render(); }
      st.adding = false;
      await load();
      const [kind, text] = sent(r);
      say(r.data.id, kind, r.data.verified ? 'This address is already verified.' : text);
      return render();
    }
    if (form.classList.contains('n-verify')) {
      const id = form.dataset.id;
      const r = await call('POST', `${base()}/${encodeURIComponent(id)}/verify`, { code: form.code.value.trim() });
      button.disabled = false;
      if (!r.ok) { say(id, 'error', r.status === 410 ? `${errorOf(r)}.` : r.status === 400 ? 'That code is not right. Check the latest email and try again.' : errorOf(r)); return render(); }
      say(id, 'ok', '');
      await load();
    }
  });

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'notices-ok') { dismissNotices(st.me); return render(); }
    if (b.id === 'email-another') { st.adding = true; say('add', 'ok', ''); render(); return root.querySelector('#email-add input')?.focus(); }
    if (b.dataset.remove) {
      const s = st.emails.find((x) => x.id === b.dataset.remove);
      if (s?.verified && !confirm(`Stop all emails to ${s.email} from ${team}?`)) return;
      const r = await call('DELETE', `${base()}/${encodeURIComponent(b.dataset.remove)}`);
      if (!r.ok && r.status !== 404) { say(b.dataset.remove, 'error', errorOf(r)); return render(); }
      say('add', 'ok', '');
      if (!s?.verified) st.adding = true;
      return load();
    }
    if (b.dataset.resend) {
      const s = st.emails.find((x) => x.id === b.dataset.resend);
      b.disabled = true;
      const r = await call('POST', base(), { email: s.email });
      if (!r.ok) { say(s.id, 'error', errorOf(r)); return render(); }
      const [kind, text] = sent(r);
      say(s.id, kind, text || 'A new code is on its way. The old one no longer works.');
      return render();
    }
    if (b.dataset.save) return save(b.dataset.save, 'Saved. You will get these emails.');
  });

  root.addEventListener('change', (e) => {
    const box = e.target.closest('input[data-kind]');
    if (!box) return;
    const s = st.emails.find((x) => x.id === box.dataset.sub);
    // The first time, ticks wait for Save (D49); after that each switch saves at once.
    if (s?.kinds?.length || st.cleared.has(s?.id)) save(s.id, 'Saved.');
  });

  /** PATCHes the ticked kinds of one address. Unticking every kind is allowed: the address stays verified. */
  async function save(id, done) {
    const kinds = [...root.querySelectorAll(`input[data-sub="${CSS.escape(id)}"][data-kind]:checked`)].map((i) => i.dataset.kind);
    const r = await call('PATCH', `${base()}/${encodeURIComponent(id)}`, { kinds });
    if (!r.ok) { say(id, 'error', errorOf(r)); return render(); }
    const i = st.emails.findIndex((x) => x.id === id);
    if (i >= 0) st.emails[i] = r.data;
    if (kinds.length) st.cleared.delete(id); else st.cleared.add(id);
    say(id, 'ok', kinds.length ? done : 'Saved. Nothing is emailed to this address now; it stays verified.');
    render();
  }

  (async () => {
    if (!team) { root.innerHTML = '<p class="result error" role="alert">This page needs a team: open it from a team email or from the Studio.</p>'; return; }
    st.me = await ensureSignedIn();
    if (!st.me) return;
    await load();
  })().catch((e) => { root.innerHTML = `<p class="result error" role="alert">${esc(e.message)}</p>`; });
}

if (globalThis.document?.getElementById('notifications')) start();
