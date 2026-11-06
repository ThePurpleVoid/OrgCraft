// The rollout view (PRD 6.9 X7, demo step 17, CPO copy "Rollout view after a publish", D61 to D63): has the team
// picked up what was published? One line per role, from board reports since the publish merged. Read-only (D63): it
// shows the choice made at publish and changes nothing. GET /v1/team/rollout gives the data (packages/team-model
// rollout(): the control plane's when connected, else this repository's default branch and the board).
// ago and QUIET_S as safety.js has them (D14); not imported, so this file loads in Node for its tests.
const QUIET_S = 2 * 3600;
function ago(seconds) {
  const s = Math.max(0, Math.round(seconds ?? 0));
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}
import { requestJson } from './env.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const human = (slug) => { const s = String(slug ?? '').replace(/[-_]+/g, ' ').trim(); return s ? s[0].toUpperCase() + s.slice(1) : ''; };

export const UNKNOWN_HINT = 'This role reports without a version, from an older kit or another coding agent. Its brief changed in the repository; it reads it at its next task.';
const EMPTY = 'Nothing to roll out yet. After you publish and the change merges, this shows which roles have picked it up.';

/** The D13 words for the choice made at publish, after "Finishing … on the old version · ". */
export function choiceWords(plan, titleOf = human) {
  const c = plan?.choice ?? 'finish';
  if (c === 'handoff') return plan?.to ? `handing off to ${titleOf(plan.to)}` : 'handing off';
  if (c === 'pause') return 'paused';
  return 'then switches over';
}

const ageOf = (iso, now) => { const t = Date.parse(iso ?? ''); return Number.isNaN(t) ? null : (now - t) / 1000; };

/** One role's label and its colour (CPO copy, D61, D62): { text, tone: 'ok' | 'warn' | 'grey', hint? }. */
export function stateLine(r, { titleOf = human, now = Date.now() } = {}) {
  const task = r.task ? `"${r.task}"` : 'its current task';
  const age = ageOf(r.lastAt, now);
  const heard = age !== null && age > QUIET_S ? ` · last heard ${ago(age)} ago` : '';
  switch (r.state) {
    case 'moved': return { text: `On the new version${heard}`, tone: heard ? 'grey' : 'ok' };
    case 'next-task': return { text: `Picks up the new version at its next task${heard}`, tone: heard ? 'grey' : 'plain' };
    case 'finishing': return { text: `Finishing ${task} on the old version · ${choiceWords(r.plan, titleOf)}${heard}`, tone: heard ? 'grey' : 'warn' };
    case 'off-finishing': return { text: `Switched off · finishing ${task} first${heard}`, tone: heard ? 'grey' : 'warn' };
    case 'off': return { text: 'Off', tone: 'grey' };
    case 'unknown': return { text: 'Version not reported', tone: 'grey', hint: UNKNOWN_HINT };
    default: return { text: `No report since the publish${r.lastAt && age !== null ? ` · last heard ${ago(age)} ago` : ''}`, tone: 'grey' };
  }
}

/** The summary line: "{n} of {m} roles on the new version", ", {k} finishing work first", " · {u} not reporting a version". */
/** While a later change waits to merge (CPO), the count names the merged version instead of "the new version". */
export function summaryLine(s, { on = 'the new version' } = {}) {
  if (!s) return '';
  const finishing = s.finishing + (s.offFinishing ?? 0);
  const unknown = s.unknown ? ` · ${s.unknown} not reporting a version` : '';
  if (s.allMoved) return `All ${s.of} role${s.of === 1 ? '' : 's'} on ${on}.${unknown}`;
  return `${s.moved} of ${s.of} role${s.of === 1 ? '' : 's'} on ${on}${finishing ? `, ${finishing} finishing work first` : ''}${unknown}`;
}

const fmtTime = (iso) => { const d = new Date(iso ?? ''); return Number.isNaN(+d) ? '' : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };

/** What needs a look first (CPO): mid-task, idle, no report, unknown, on the new version, off; by title inside each. */
const ORDER = ['finishing', 'off-finishing', 'next-task', 'no-report', 'unknown', 'moved', 'off'];
export function sortRoles(roles, titleOf = human) {
  const rank = (r) => { const i = ORDER.indexOf(r.state); return i < 0 ? ORDER.length : i; };
  return [...(roles ?? [])].sort((a, b) => rank(a) - rank(b) || String(titleOf(a.role)).localeCompare(String(titleOf(b.role))));
}

/** The whole view from GET /v1/team/rollout, as markup. The change link's href is set by createRollout, through the DOM. */
export function rolloutHtml(data, { titleOf = human, now = Date.now() } = {}) {
  if (!data) return '<p class="muted">Reading the rollout…</p>';
  if (data.error) return `<p class="result error" role="alert">${esc(data.error)}</p>`;
  const pending = data.pending
    ? `<p class="notice" role="status">Waiting for the change to merge. Roles keep running ${esc(data.name ?? 'the version before it')} until it does. As of the last time the Studio checked the repository.</p>` : '';
  if (!data.version) return `<h2 class="flush ro-head">Rollout</h2>${pending || `<p class="muted">${esc(EMPTY)}</p>`}`;
  const rows = sortRoles(data.roles, titleOf).map((r) => {
    const line = stateLine(r, { titleOf, now });
    return `<li class="ro-row ro-${line.tone}" data-role="${esc(r.role)}">
      <span class="ro-dot" aria-hidden="true"></span>
      <strong class="ro-title">${esc(titleOf(r.role))}</strong>
      <span class="ro-state">${esc(line.text)}${line.hint ? ` <button type="button" class="link ro-why" aria-label="Why: ${esc(line.hint)}" title="${esc(line.hint)}" data-hint="${esc(line.hint)}">Why?</button>` : ''}</span>
    </li>`;
  }).join('');
  const newest = (data.roles ?? []).map((r) => r.lastAt).filter(Boolean).sort().at(-1);
  return `<h2 class="flush ro-head">Rollout of ${esc(data.name)}${data.changeUrl ? ' <span class="muted">· <a class="ro-change" target="_blank" rel="noopener noreferrer">see the change</a></span>' : ''}</h2>
    ${pending}
    <p class="ro-summary">${esc(summaryLine(data.summary, data.pending && data.name ? { on: data.name } : undefined))}</p>
    <ul class="plain ro-list">${rows}</ul>
    <p class="hint ro-hint" hidden></p>
    <p class="hint">Based on board reports; may be out of date.${newest ? ` Newest report ${esc(fmtTime(newest))}.` : ''}</p>`;
}

/** The Rollout page: loads when shown, and again whenever the board changes while it is open. */
export function createRollout({ root, titleOf, apiUrl }) {
  let data = null, es = null, timer = null;
  const draw = () => {
    root.innerHTML = rolloutHtml(data, { titleOf });
    // https only, set through the DOM, never written into markup.
    const a = root.querySelector('.ro-change');
    if (a) { try { const u = new URL(data.changeUrl); if (u.protocol === 'https:') a.href = u.href; else a.parentElement.remove(); } catch { a.parentElement.remove(); } }
  };
  async function load() {
    try {
      const res = await requestJson('/v1/team/rollout');
      const body = await res.json().catch(() => ({}));
      data = res.ok ? body : { error: body.error ?? `HTTP ${res.status}` };
    } catch (e) { data = { error: e.message }; }
    draw();
  }
  root.addEventListener('click', (e) => {
    const b = e.target.closest('.ro-why');
    if (!b) return;
    const p = root.querySelector('.ro-hint');
    const same = !p.hidden && p.textContent === b.dataset.hint;
    p.textContent = b.dataset.hint;
    p.hidden = same;
  });
  return {
    open() {
      draw();
      load();
      if (es || !apiUrl) return;
      es = new EventSource(apiUrl('/v1/team/board/stream'));
      es.addEventListener('changed', () => { clearTimeout(timer); timer = setTimeout(load, 300); });
    },
    close() { es?.close(); es = null; clearTimeout(timer); },
  };
}
