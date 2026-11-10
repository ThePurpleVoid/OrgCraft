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
export async function sendSystems({ stepUp, name, system, state = null, pending = null } = {}) {
  const s = state ?? await systemsState();
  if (!s || s.connected === false || s.inSync) return 'none';
  // PR mode (L40b): the set waits for its change; one already waiting with this content is not sent again.
  if (pending && s.pending?.ours) return 'done';
  const body = { key: `systems-${Date.now().toString(36)}`, version: s.version, hash: s.hash, ...(pending ? { pending: true, ...(pending.pr ? { pr: pending.pr } : {}) } : {}) };
  let r = await call('/v1/team/systems', body);
  if (r.status === 401 && /step-up-required$/.test(r.data.type ?? '')) {
    if (!(await stepUp(t('stepup.action.systems'), r.data.scope ?? null, await systemsLines(s, name, system)))) return 'cancelled';
    r = await call('/v1/team/systems', body);
  }
  if (r.ok && r.data.connected === false) return 'none';
  return r.ok ? 'done' : 'failed';
}

/**
 * L40b: switches on the pending set shown in `state` (its commit and content hash), behind a fresh systems step-up
 * whose dialog lists what the control plane gains and loses. Resolves 'done', 'cancelled', 'changed' (another admin
 * re-confirmed it with other content: look again), 'dropped' (expired, or the systems moved: confirm again) or 'failed'.
 */
export async function applyPending({ stepUp, name, system, state }) {
  const p = state?.pending;
  if (!p) return 'dropped';
  const body = { sha: p.sha, contentHash: p.contentHash };
  let r = await call('/v1/team/systems/pending/apply', body);
  if (r.status === 401 && /step-up-required$/.test(r.data.type ?? '')) {
    if (!(await stepUp(t('stepup.action.systems.switchon'), r.data.scope ?? null, await systemsLines({ ...state, items: p.items, lost: p.lost }, name, system)))) return 'cancelled';
    r = await call('/v1/team/systems/pending/apply', body);
  }
  if (r.ok) return 'done';
  const type = String(r.data.type ?? '').replace(/^.*\//, '');
  return type === 'pending-changed' ? 'changed' : type === 'pending-dropped' || type === 'no-pending' ? 'dropped' : 'failed';
}

/** The words for a systems.pending.dropped reason (CPO §5a); `days` is how long a pending set waits. */
export const droppedLine = (reason, days = 30) => t({ withdrawn: 'systems.dropped.closed', expired: 'systems.dropped.expired', 'base-moved': 'systems.dropped.moved', 'merged-different': 'systems.dropped.merged-different' }[reason] ?? 'systems.dropped.moved', { days });

/** "{code host} reports that the change was accepted…": the host by name when the Studio knows it. */
export const readyLine = () => t('systems.ready');
/** An ⓘ with `text` as its tooltip, labelled "About this message". */
export function tipButton(text) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'info'; b.dataset.tip = text; b.setAttribute('aria-label', t('tip.button', { term: t('systems.ready.term') })); b.textContent = 'ⓘ';
  return b;
}
/** The ⓘ beside the ready line: the report comes from the team's own checks, which OrgCraft does not vouch for. */
export const readyTip = () => tipButton(t('systems.ready.tip'));
/** The waiting line's parts: the line, its ⓘ, and a link to the change (`pr`) when the code host gives one. */
export function waitingParts(url, pr = null, openUrl = null) {
  const link = (href, label) => { const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = label; return a; };
  // No change open for review (no PR, closed, gh unknown, detached HEAD): say so, and link to opening one when the
  // code host is known (CPO §5a).
  if (!pr) return [`${t('systems.waiting.nochange')} `, tipButton(t('systems.waiting.nochange.tip')), ...(/^https:\/\//.test(openUrl ?? '') ? [' ', link(openUrl, t('systems.waiting.open'))] : [])];
  const label = t('systems.waiting.link');
  const parts = [`${t('systems.waiting')} `, tipButton(t('systems.waiting.tip', { change: label.charAt(0).toLocaleLowerCase() + label.slice(1) }))];
  if (/^https:\/\//.test(url ?? '')) parts.push(' ', link(url, label));
  return parts;
}
