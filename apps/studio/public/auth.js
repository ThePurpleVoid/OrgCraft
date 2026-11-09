// Signing in to a hosted Studio, and proving a person is present (docs/specs/m4-sign-in.md sections 2 and 3).
//
// The deployment is its own identity provider: the page never sees an OAuth code, verifier or token. It sends the
// person to /oauth/authorize, the issuer's callback sets the HttpOnly session cookie, and the page only ever calls its
// own origin. Step-up is a passkey: the page asks the browser for an assertion and trades it for a single-use su_
// token, which it keeps in memory for the one call that needed it and never stores.
//
// Only a hosted deployment uses this (<meta name="agent-team-mode" content="hosted">). The local Studio keeps its
// launch link and step-up secret, so nothing here runs there. This module touches no DOM when imported, so the
// return-path check can be tested in Node and reused by the test issuer.

/** The web client's id at the issuer (spec section 2). */
import { t } from './i18n.js';

export const WEB_CLIENT = 'agent-team-web';

const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A `return` the issuer may send the person back to: a path on this host, or '/'. It must start with exactly one '/',
 * and nothing in it may smuggle a second one in: '//evil', '/\evil', '/%2F%2Fevil', '/%5Cevil', a scheme, or control
 * characters (raw or percent-encoded) are all refused (spec section 2, Proof).
 */
export function safeReturn(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) return '/';
  if (CONTROL.test(raw) || /%(?:[01][0-9a-f]|7f)/i.test(raw)) return '/';
  if (raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\') return '/';
  // Encoded slashes and backslashes, anywhere: a server or proxy that decodes once would see '//' or '/\'.
  if (/\\|%2f|%5c|%25/i.test(raw)) return '/';
  // Dot segments, raw or encoded: normalising '/.//evil' or '/a/..//evil' yields '//evil' (code review, PR #59).
  if (/(^|\/)(\.|%2e){1,2}(\/|$)/i.test(raw.split(/[?#]/)[0])) return '/';
  let url;
  try { url = new URL(raw, 'https://host.invalid'); } catch { return '/'; }
  if (url.origin !== 'https://host.invalid') return '/';
  const out = url.pathname + url.search + url.hash;
  // And check what comes out, not only what went in: whatever the parser did, the result is one leading '/'.
  return out[0] === '/' && out[1] !== '/' && out[1] !== '\\' ? out : '/';
}

/** Where the sign-in page sends "Continue with GitHub": built only from an interaction id the issuer gave. */
export function githubStart(interaction) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(interaction ?? '') ? `/oauth/interaction/${interaction}/github` : null;
}

/** The URL that starts a web sign-in and comes back to `path`. */
export function signInUrl(path) {
  return `/oauth/authorize?client_id=${WEB_CLIENT}&return=${encodeURIComponent(safeReturn(path))}`;
}

export const isHosted = (doc = globalThis.document) => doc?.querySelector?.('meta[name="agent-team-mode"]')?.content === 'hosted';

// ---- base64url and the WebAuthn JSON shapes (@simplewebauthn's, which the issuer's library speaks)

export function b64urlToBytes(s) {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(s).length / 4) * 4, '='));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
export function bytesToB64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function creationOptions(json) {
  const PKC = globalThis.PublicKeyCredential;
  if (PKC?.parseCreationOptionsFromJSON) return PKC.parseCreationOptionsFromJSON(json);
  return {
    ...json,
    challenge: b64urlToBytes(json.challenge),
    user: { ...json.user, id: b64urlToBytes(json.user.id) },
    excludeCredentials: (json.excludeCredentials ?? []).map((c) => ({ ...c, id: b64urlToBytes(c.id) })),
  };
}
function requestOptions(json) {
  const PKC = globalThis.PublicKeyCredential;
  if (PKC?.parseRequestOptionsFromJSON) return PKC.parseRequestOptionsFromJSON(json);
  return { ...json, challenge: b64urlToBytes(json.challenge), allowCredentials: (json.allowCredentials ?? []).map((c) => ({ ...c, id: b64urlToBytes(c.id) })) };
}
function credentialJSON(cred) {
  if (typeof cred.toJSON === 'function') return cred.toJSON();
  const r = cred.response;
  const response = r.attestationObject
    ? { clientDataJSON: bytesToB64url(r.clientDataJSON), attestationObject: bytesToB64url(r.attestationObject), transports: r.getTransports?.() ?? [] }
    : { clientDataJSON: bytesToB64url(r.clientDataJSON), authenticatorData: bytesToB64url(r.authenticatorData), signature: bytesToB64url(r.signature), ...(r.userHandle ? { userHandle: bytesToB64url(r.userHandle) } : {}) };
  return { id: cred.id, rawId: bytesToB64url(cred.rawId), type: cred.type, response, clientExtensionResults: cred.getClientExtensionResults?.() ?? {}, authenticatorAttachment: cred.authenticatorAttachment ?? undefined };
}

// ---- calls to this origin

/** A same-origin JSON call with the session cookie. Unsafe methods send JSON, so the issuer's CSRF check passes. */
export async function call(method, path, body, headers = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { ok: res.ok, status: res.status, data: data ?? {} };
}
export const needsStepUp = (r) => r.status === 401 && /step-up-required$/.test(r.data?.type ?? '');

/** The signed-in person, or null after sending the browser to sign in (it comes back to this page). */
export async function ensureSignedIn(loc = globalThis.location) {
  const r = await call('GET', '/v1/me');
  if (r.ok) return r.data;
  if (r.status === 401) { loc.assign(signInUrl(loc.pathname + loc.search + loc.hash)); return null; }
  throw new Error(r.data.error ?? `HTTP ${r.status}`);
}

export async function signOut(loc = globalThis.location) {
  await call('POST', '/oauth/revoke', {});
  loc.assign('/sign-in?error=signed-out');
}

/** Why a WebAuthn ceremony failed, in words a person can act on. */
function ceremonyError(e) {
  if (e?.name === 'NotAllowedError') return 'The passkey prompt was closed or timed out, or the passkey could not confirm it is you. Try again.';
  if (e?.name === 'InvalidStateError') return 'This device already has a passkey for you.';
  if (e?.name === 'SecurityError') return 'Passkeys only work on the deployment\'s own address, over HTTPS.';
  if (e?.name === 'NotSupportedError' || !globalThis.PublicKeyCredential) return 'This browser cannot use passkeys.';
  return e?.message ?? String(e);
}

/**
 * The second way in (L27, m4-sign-in.md section 2 step 5): sign in with a passkey alone, for sign-in `uid`. Resolves
 * { location } (where the browser goes next), { expired: true } when the sign-in is too old, or { error } with the
 * CPO's words. A refusal never says why (the server's one generic 401).
 */
export async function passkeySignIn(uid) {
  const base = `/oauth/interaction/${encodeURIComponent(uid)}/passkey`;
  const opts = await call('GET', base);
  if (opts.status === 410) return { expired: true };
  if (!opts.ok) return { error: t('signin.failed') };
  let cred;
  try { cred = await navigator.credentials.get({ publicKey: requestOptions(opts.data) }); } catch { return { error: t('signin.failed') }; }
  const r = await call('POST', base, { webauthn: credentialJSON(cred) });
  if (r.status === 410) return { expired: true };
  if (!r.ok || typeof r.data.location !== 'string') return { error: t('signin.failed') };
  return { location: r.data.location };
}

// ---- recovery owners (L27; GET/POST /v1/recovery, DELETE /v1/recovery/{person})

/** The organization's name for the copy: the workspace this deployment serves, else the CPO's fallback. */
export const orgName = (me) => (me?.workspaces ?? []).find((w) => w.name)?.name ?? t('org.fallback');

/** The "only you can recover" banner, when the list says fewer than two count. '' otherwise. */
export function recoveryBanner(rec, me) {
  if (!rec?.warnings?.some((w) => w.code === 'fewer-than-two')) return '';
  return `<div class="notice recovery-banner" role="status"><p>${esc(t('recovery.banner.one', { organization: orgName(me) }))}</p><p><a class="button" href="/account#recovery">${esc(t('recovery.add'))}</a></p></div>`;
}

/** Recovery owners for an admin or owner, or null (a member who is neither, or no recovery here). */
export async function loadRecovery(me) {
  if (!(me?.workspaces ?? []).some((w) => w.role === 'owner' || w.role === 'admin')) return null;
  const r = await call('GET', '/v1/recovery');
  return r.ok ? r.data : null;
}

/** Registers a passkey on this device. `stepUp` is the header from a step-up, needed for every passkey after the first. */
export async function addPasskey(name, stepUpHeader = {}) {
  const opts = await call('GET', '/v1/me/passkeys/options');
  if (!opts.ok) return { ok: false, status: opts.status, data: opts.data };
  let cred;
  try { cred = await navigator.credentials.create({ publicKey: creationOptions(opts.data) }); } catch (e) { return { ok: false, status: 0, data: { error: ceremonyError(e) } }; }
  return call('POST', '/v1/me/passkeys', { name, credential: credentialJSON(cred) }, stepUpHeader);
}

/** One passkey assertion traded for one su_ token. Resolves { token } or { error }. */
export async function passkeyStepUp(scope) {
  const ch = await call('GET', '/v1/auth/step-up/challenge');
  if (!ch.ok) return { error: ch.data.error ?? `HTTP ${ch.status}` };
  let cred;
  try { cred = await navigator.credentials.get({ publicKey: requestOptions(ch.data) }); } catch (e) { return { error: ceremonyError(e) }; }
  const r = await call('POST', '/v1/auth/step-up', { webauthn: credentialJSON(cred), ...(scope ? { scope } : {}) });
  if (!r.ok) return { error: r.status === 429 ? 'Too many tries. Wait a few minutes, then try again.' : r.data.error ?? `HTTP ${r.status}` };
  return { token: r.data.token };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * The step-up dialog: why it is needed, then the passkey prompt on a click (Safari only shows it from a user
 * gesture). Resolves the x-step-up header for one call, or null when the person cancels. The token lives only in
 * the returned object; the caller sends it once and lets it go.
 */
export function stepUpDialog(why, { doc = document, scope = null } = {}) {
  let dlg = doc.getElementById('passkey-stepup');
  if (!dlg) {
    dlg = doc.createElement('dialog');
    dlg.id = 'passkey-stepup';
    dlg.className = 'auth-dialog';
    dlg.setAttribute('aria-labelledby', 'passkey-stepup-title');
    dlg.innerHTML = `<form class="dialog" method="dialog">
      <h2 id="passkey-stepup-title">${t('stepup.title')}</h2>
      <p class="why"></p>
      <p class="hint">${t('stepup.why')}</p>
      <p class="result error" role="alert"></p>
      <div class="dialog-actions"><button type="button" data-act="cancel">${t('stepup.cancel')}</button><button type="button" class="primary" data-act="go">${t('stepup.button')}</button></div>
    </form>`;
    doc.body.append(dlg);
  }
  dlg.querySelector('.why').textContent = t('stepup.body', { action: why });
  dlg.querySelector('.result').textContent = '';
  return new Promise((done) => {
    const go = dlg.querySelector('[data-act="go"]');
    const finish = (v) => { dlg.oncancel = null; go.onclick = null; dlg.querySelector('[data-act="cancel"]').onclick = null; if (dlg.open) dlg.close(); done(v); };
    go.onclick = async () => {
      go.disabled = true;
      dlg.querySelector('.result').textContent = '';
      const r = await passkeyStepUp(scope);
      go.disabled = false;
      if (r.token) return finish({ 'x-step-up': r.token });
      dlg.querySelector('.result').textContent = r.error;
    };
    dlg.querySelector('[data-act="cancel"]').onclick = () => finish(null);
    dlg.oncancel = () => finish(null);
    dlg.showModal();
    go.focus();
  });
}

/** Calls `path`; if the issuer answers step-up-required, asks for a passkey once and sends it again with the su_ token. */
export async function withStepUp(why, method, path, body) {
  const r = await call(method, path, body);
  if (!needsStepUp(r)) return r;
  // The control plane names what the step-up must be bound to (ADR 0013), e.g. resume:<run>.
  const header = await stepUpDialog(why, { scope: r.data?.scope ?? null });
  if (!header) return { ok: false, status: 0, cancelled: true, data: { error: 'Cancelled: nothing was changed.' } };
  return call(method, path, body, header);
}

export { esc };

// ---- security notices (S5): the person's own security changes, shown on the next visit until email delivers them

/** One notice in words: "A passkey "Work laptop" was added on 6 Nov, 05:42." */
export function noticeText(n) {
  const when = (() => { const d = new Date(n.at); return Number.isNaN(+d) ? '' : ` on ${d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`; })();
  const key = n.name ? `A passkey "${n.name}"` : 'A passkey';
  const where = n.tenant ? ` in ${n.tenant}` : '';
  return ({
    'passkey.added': `${key} was added${when}.`,
    'passkey.removed': `${key} was removed${when}.`,
    'passkey.sign-count-flagged': `${key} was used in a way that suggests it may have been copied${when}. Remove it if you are not sure.`,
    'step-up.locked': `Confirming it is you was locked after too many failed tries${when}.`,
    'sessions.ended': `Your signed-in sessions were ended${when}.`,
    'member.role-changed': `Your role${where} changed${n.role ? ` to ${n.role}` : ''}${when}.`,
    'member.removed': `You were removed${where ? ` from${where.slice(3)}` : ' from a workspace'}${when}.`,
  })[n.action] ?? `Your account changed (${n.action})${when}.`;
}

const SEEN = 'agent-team-notices-seen';
/** The notices newer than the last one this browser dismissed, newest first. */
export function unseenNotices(me, storage = globalThis.localStorage) {
  let seen = '';
  try { seen = storage?.getItem(SEEN) ?? ''; } catch { /* private mode: show them all */ }
  return (me?.notices ?? []).filter((n) => !seen || n.at > seen);
}
/** Marks every current notice as seen in this browser. */
export function dismissNotices(me, storage = globalThis.localStorage) {
  const newest = (me?.notices ?? []).reduce((m, n) => (n.at > m ? n.at : m), '');
  try { if (newest) storage?.setItem(SEEN, newest); } catch { /* private mode */ }
}
/** The banner, or '' when there is nothing new. Its button has id notices-ok. */
export function noticesBanner(me, storage) {
  const list = unseenNotices(me, storage);
  if (!list.length) return '';
  return `<section class="notices notice" role="status" aria-label="Changes to your account">
    <p><strong>Changes to your account</strong></p>
    <ul>${list.map((n) => `<li>${esc(noticeText(n))}</li>`).join('')}</ul>
    <p class="hint">If you did not do this, remove any passkey you do not recognise below, then sign out.</p>
    <button type="button" id="notices-ok">Got it</button>
  </section>`;
}
