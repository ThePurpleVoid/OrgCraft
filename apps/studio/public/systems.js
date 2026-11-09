// Sending the published systems to the control plane (L40). What is shown is what the control plane would gain:
// its systems against the published resources.json, never the local diff, so a send that was cancelled earlier, a
// teammate's merged change, or a publish made with no control plane is listed too (security review sev2). The send
// carries the version and hash it was shown with; if either moved, nothing is sent and the person is asked again.
import { requestJson } from './env.js';
import { t } from './i18n.js';

async function call(path, body) {
  const res = await requestJson(path, body);
  let data = {};
  try { data = await res.json(); } catch { /* not JSON */ }
  return { ok: res.ok, status: res.status, data };
}

/** The control plane's systems against the published ones: { connected, inSync, version, hash, items }, or null. */
export async function systemsState() {
  const r = await call('/v1/team/systems');
  return r.ok ? r.data : null;
}

/**
 * Lines for what a send widens, in the Publish sheet's words. Loaded when needed, so the chat page's module stays
 * importable on its own (its unit tests load it in Node, where the team model is not served).
 */
export async function systemsLines(state, name, system) {
  const { widensLine, changeLines } = await import('./publish-sheet.js');
  // The server's names first (the chat page has no team loaded), then the page's, never an id (qa-web L40 N1).
  const who = (id) => state?.names?.roles?.[id] ?? name?.(id) ?? id;
  const sys = (id) => state?.names?.systems?.[id] ?? system?.(id) ?? id;
  const lost = (state?.lost ?? []).flatMap((c) => (c.kind === 'system-removed' ? [t('systems.removed', { system: sys(c.resource) })] : changeLines(c, who, sys)));
  return [...(state?.items ?? []).map((x) => widensLine(x, who, sys)), ...lost].filter(Boolean);
}

/** Shows `lines` under a step-up dialog's why line (or clears them), so the passkey confirms what will change. */
export function showItems(whyEl, lines = []) {
  let ul = whyEl.nextElementSibling?.classList.contains('stepup-items') ? whyEl.nextElementSibling : null;
  if (!lines.length) { ul?.remove(); return; }
  if (!ul) { ul = document.createElement('ul'); ul.className = 'stepup-items'; whyEl.after(ul); }
  ul.replaceChildren(...lines.map((l) => { const li = document.createElement('li'); li.textContent = l; return li; }));
}

/**
 * Sends the published systems when the control plane's differ. `stepUp(why, scope, lines)` asks for the passkey.
 * Resolves 'none' (nothing to send, or no control plane), 'done', 'cancelled' or 'failed'.
 */
export async function sendSystems({ stepUp, name, system, state = null } = {}) {
  const s = state ?? await systemsState();
  if (!s || s.connected === false || s.inSync) return 'none';
  const body = { key: `systems-${Date.now().toString(36)}`, version: s.version, hash: s.hash };
  let r = await call('/v1/team/systems', body);
  if (r.status === 401 && /step-up-required$/.test(r.data.type ?? '')) {
    if (!(await stepUp(t('stepup.action.systems'), r.data.scope ?? null, await systemsLines(s, name, system)))) return 'cancelled';
    r = await call('/v1/team/systems', body);
  }
  if (r.ok && r.data.connected === false) return 'none';
  return r.ok ? 'done' : 'failed';
}
