// The chat with the chief of staff (PRD 6.4, C1 to C4; clients contract sections 5 to 7). Plain ES module, no build.
// What it shows comes from the control plane as events and cards, never as HTML: the owner's words exactly as typed,
// the team's replies in a small Markdown subset, cards built from their fields, today's cost against the cap, and
// pause and stop for the run. The Studio server holds the token; this page only talks to it.

import { apiUrl, ask, askText, requestJson } from './env.js';
import { t } from './i18n.js';
import { ruleLine } from './approvals.js';
import { sendSystems, showItems, systemsState } from './systems.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const human = (slug) => { const s = String(slug ?? '').replace(/[-_]+/g, ' ').trim(); return s ? s[0].toUpperCase() + s.slice(1) : 'Someone'; };
/** A ULID: what the contract asks clients to use for a message's clientId (sortable, unique without a server). */
export function ulid(now = Date.now()) {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let t = '', n = now;
  for (let i = 0; i < 10; i++) { t = A[n % 32] + t; n = Math.floor(n / 32); }
  const r = crypto.getRandomValues(new Uint8Array(16));
  return t + Array.from(r, (b) => A[b % 32]).join('');
}
const newId = () => ulid();
/** When the daily budget resets, in words: 00:00 UTC, and how far off (a UTC midnight is mid-day for many people). */
export function resetIn(now = Date.now()) {
  const d = new Date(now), next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  const h = Math.ceil((next - now) / 3_600_000);
  return `the budget resets at 00:00 UTC (${h <= 1 ? 'in under an hour' : `in ${h} h`})`;
}
/**
 * What a resume refused for a spent budget says (problem type budget-exhausted), above its button: "the cap for today"
 * while today's budget card is open (its Add half again lifts today only), else "the daily cap" (a new cap from now on).
 */
const SPENT = Symbol('budget-exhausted');
export const spentText = (forToday, now) => `Today's budget is spent, so the run can't resume yet. Raise ${forToday ? 'the cap for today' : 'the daily cap'} to resume it now, or resume it after ${resetIn(now)}.`;
/** Names for the link relations cards use most; any other relation shows as its own words. */
const LINKS = { pr: 'Pull request', preview: 'Preview', evidence: 'Evidence', issue: 'Issue', log: 'Log', diff: 'Changes' };
const safeUrl = (u) => (/^https?:\/\//i.test(String(u ?? '')) ? String(u) : null);

/** The Markdown subset cards and replies may use: paragraphs, lists, emphasis, code and http(s) links. No HTML. */
export function md(text) {
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => { const u = safeUrl(url.replace(/&amp;/g, '&')); return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label; });
  const isItem = (l) => /^\s*([-*]|\d+\.)\s+/.test(l);
  return String(text ?? '').trim().split(/\n{2,}/).map((block) => {
    // Runs of list lines become a list; other lines stay a paragraph with line breaks.
    const out = [];
    for (const line of block.split('\n')) {
      const kind = isItem(line) ? (/^\s*\d+\./.test(line) ? 'ol' : 'ul') : 'p';
      if (out.at(-1)?.kind === kind) out.at(-1).lines.push(line); else out.push({ kind, lines: [line] });
    }
    return out.map(({ kind, lines }) => (kind === 'p' ? `<p>${lines.map(inline).join('<br>')}</p>`
      : `<${kind}>${lines.map((l) => `<li>${inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`).join('')}</${kind}>`)).join('');
  }).join('');
}

const fmtTime = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
/** A time with its day when it is not today ("tomorrow 05:42", "Mon 9 Nov 05:42"), so a deadline never looks past. */
export const fmtWhen = (iso, now = new Date()) => {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return '';
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86400000);
  const t = fmtTime(iso);
  if (diff === 0) return t;
  if (diff === 1) return `tomorrow ${t}`;
  if (diff === -1) return `yesterday ${t}`;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${t}`;
};
/** Minor units per major unit for a currency: 100 for USD, 1 for JPY, 1000 for KWD (ISO 4217, as Intl knows it). */
export function minorDigits(currency) {
  try { return new Intl.NumberFormat('en', { style: 'currency', currency: currency || 'USD' }).resolvedOptions().maximumFractionDigits; } catch { return 2; }
}
const fmtMoney = (minor, currency) => {
  if (typeof minor !== 'number') return '';
  const major = minor / 10 ** minorDigits(currency);
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(major); } catch { return `${major.toFixed(minorDigits(currency))} ${currency ?? ''}`.trim(); }
};

/** Who said it: the owner (a person) or a role. */
function speaker(e) {
  const from = e.data?.from;
  const kind = (typeof from === 'object' ? from?.kind : null) ?? e.actor?.kind;
  const id = (typeof from === 'object' ? from?.id : from) ?? e.actor?.id;
  return kind === 'person' || kind === 'member' ? { me: true, name: 'You' } : { me: false, name: human(id) };
}

const by = (e) => { const b = e.data?.by; const n = typeof b === 'object' ? b?.name ?? b?.id : b; return n ? ` by ${n}` : ''; };
/** Who did it, after a middle dot ("A run started · Dana"), so the line never reads as the team acting "by" someone. */
const who = (e) => { const b = e.data?.by; const n = typeof b === 'object' ? b?.name ?? b?.id : b; return n ? ` · ${n}` : ''; };
/** Run and budget events, as one line each in the chat. */
const TIMELINE = {
  'run.started': (e) => `A run started${who(e)}`,
  'run.paused': (e) => `The run was paused${who(e)}${e.data?.reason ? ` (${e.data.reason})` : ''}`,
  'run.resumed': (e) => `The run resumed${who(e)}`,
  'run.stopped': (e) => `The run stopped${who(e)}${e.data?.reason ? ` (${e.data.reason})` : ''}`,
  'budget.warned': () => 'Most of today\'s budget is spent',
  'budget.exhausted': () => 'Today\'s budget is spent, so the team is paused',
  'budget.updated': (e) => `The daily cap is now ${e.data?.perDay == null ? 'unset' : fmtMoney(e.data.perDay, e.data.currency)}${by(e)}`,
};
const subjectId = (subject) => String(subject ?? '').split('/').slice(1).join('/');

/** A card from its event. Cards the control plane sends whole (data.card, or the response's cards) win. */
function cardFrom(e) {
  if (e.data?.card && typeof e.data.card === 'object') return e.data.card;
  const d = { ...(e.data ?? {}), ...(typeof e.data?.card === 'string' ? { cardId: e.data.card } : {}) };
  if (e.type === 'approval.requested') {
    return {
      id: d.cardId || subjectId(e.subject) || e.id, kind: 'approval', subject: e.subject, version: d.version ?? 1,
      title: d.title ?? d.action ?? 'Approval needed', body: d.why ?? '', risk: d.risk, expires: d.expires,
      recommendation: d.recommendation,
      options: [{ id: 'approve', label: 'Approve', style: 'primary', stepUp: true }, { id: 'deny', label: 'Deny', style: 'danger' }],
    };
  }
  const opts = (d.options ?? []).map((o) => (typeof o === 'string' ? { id: o, label: o } : o));
  const rec = typeof d.recommended === 'string' ? { option: d.recommended, why: d.why } : d.recommendation;
  return { id: d.cardId || subjectId(e.subject) || e.id, kind: 'decision', subject: e.subject, version: d.version ?? 1, title: d.question ?? d.title ?? 'A decision', body: d.body ?? '', options: opts, recommendation: rec };
}

/** A day for the CPO's {date}: "9 Nov". */
const fmtDay = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? '' : d.toLocaleDateString([], { day: 'numeric', month: 'short' }); };

/**
 * L22, the lines above an approval's facts (strings-now §6b): asked again after a decline (declines stick, AI-10),
 * what the teammate says changed, and a card that replaced one whose calls changed. `me` is the viewer's id, if known.
 */
export function declineHtml(card, me = null, org = '') {
  const d = card.data ?? {};
  const out = [];
  const db = d.declinedBefore;
  const what = typeof d.changed?.what === 'string' && d.changed.what.trim() ? d.changed.what.trim() : '';
  if (db && (db.declinedOn || db.at)) {
    const date = fmtDay(db.declinedOn ?? db.at);
    const mine = db.declinedBy && me ? db.declinedBy === me : !db.declinedByName;
    if (mine && what) out.push(t('card.declined.before', { date, reason: what }));
    else {
      out.push(t('card.declined.other', { person: mine ? t('notify.log.you') : db.declinedByName || (db.declinedByName === null ? t('notify.log.who.unknown') : t('person.loading', { organization: org || t('org.fallback') })), date }));
      if (what) out.push(t('card.changed.what', { reason: what }));
    }
    if (db.cooldownUntil ?? db.until) out.push(t('card.cooldown', { date: fmtDay(db.cooldownUntil ?? db.until) }));
  } else if (what) out.push(t('card.changed.what', { reason: what }));
  if (Array.isArray(d.changed?.from) && d.changed.from.length) out.unshift(t('card.changed'));
  return out.length ? `<div class="declined notice" role="note">${out.map((x) => `<p>${esc(x)}</p>`).join('')}</div>` : '';
}

export function createChat({ root, onOpen, runs = true, organization = () => '', me = () => null } = {}) {
  const st = {
    connected: null, error: null, events: [], next: null, cards: new Map(), answers: new Map(), pending: [],
    notes: new Map(), // card id -> note shown above it (changed, step-up)
    run: null, cost: null, summary: null, busy: false, loaded: false, es: null, team: null,
    runError: null, budget: null, plan: null, shaOpen: new Set(), // approval cards whose full sha is shown // GET /v1/team/budget and /v1/team/run/plan, read when the start dialog opens
    older: [], local: new Set(), // pages fetched with 'Show earlier'; events this page posted
    forbidden: new Set(), // cards the control plane said this person's role may not answer (403)

  };

  root.innerHTML = `
    <div class="chat-head">
      <div class="chat-title"><strong>Chief of staff</strong> <span id="chat-where" class="muted"></span></div>
      <div class="chat-run row">
        <span id="run-state" class="pill" role="status"></span>
        <span id="cost" class="cost" role="status"></span>
        <button id="run-start" type="button" class="primary" hidden>Start a run…</button>
        <button id="run-pause" type="button"></button>
        <button id="run-stop" type="button" class="danger">Stop</button>
        <button id="runner-add" type="button" data-tip="${esc(t('runner.connect.tip'))}" hidden>${esc(t('runner.connect'))}</button>
      </div>
    </div>
    <dialog id="start-dialog" class="start-dialog">
      <form method="dialog" class="dialog" id="start-form">
        <h2>Start a run</h2>
        <p class="muted">The team runs as it was last published, not as the canvas shows it now. It keeps going until you pause or stop it, or today's cap is reached.</p>
        <p id="start-plan" class="plan" role="status">Reading the published team…</p>
        <p id="start-systems" class="plan" hidden></p>
        <label for="start-cap">Daily cap</label>
        <div class="money"><input id="start-cap" type="number" inputmode="decimal" min="0.01" step="0.01" required placeholder="e.g. 20.00"><span id="start-currency" class="muted"></span></div>
        <p class="hint" id="start-cap-hint">The most the team may spend in a day (UTC). A run cannot start without one. Raising it later asks you to confirm it is you.</p>
        <p id="start-result" class="result" role="status"></p>
        <div class="dialog-actions">
          <button value="cancel" type="submit" formnovalidate>Cancel</button>
          <button id="start-go" type="button" class="primary" disabled>Start</button>
        </div>
      </form>
    </dialog>
    <dialog id="runner-dialog" class="start-dialog" aria-labelledby="runner-title">
      <form method="dialog" class="dialog" id="runner-form">
        <h2 id="runner-title">Add a runner</h2>
        <p class="muted">A runner is the machine that runs this team's agents. Get a one-time code here, then register that machine with it. Getting a code asks you to confirm it is you.</p>
        <div id="runner-list" class="runner-list"></div>
        <label for="runner-name">Name for the machine</label>
        <input id="runner-name" maxlength="100" autocomplete="off" placeholder="e.g. Office Mac mini">
        <div id="runner-code" class="runner-code" hidden></div>
        <p id="runner-result" class="result error" role="status"></p>
        <div class="dialog-actions">
          <button value="close" type="submit" formnovalidate>Close</button>
          <button id="runner-go" type="button" class="primary">Get a code</button>
        </div>
      </form>
    </dialog>
    <dialog id="stepup-dialog" class="stepup-dialog">
      <form class="dialog" id="stepup-form">
        <h2>${t('stepup.title')}</h2>
        <p id="stepup-why"></p>
        <label>${t('stepup.label.interim')} <input id="stepup-secret" type="password" autocomplete="current-password" aria-describedby="stepup-hint" required></label>
        <p class="hint" id="stepup-hint">${t('stepup.label.interim.hint')}</p>
        <p class="hint">${t('stepup.why')}</p>
        <p id="stepup-result" class="result error" role="status"></p>
        <div class="dialog-actions">
          <button id="stepup-cancel" type="button">${t('stepup.cancel')}</button>
          <button type="submit" class="primary">${t('stepup.button')}</button>
        </div>
      </form>
    </dialog>
    <div id="chat-log" class="chat-log" aria-live="polite" aria-label="Chat with the chief of staff"></div>
    <form id="chat-form" class="chat-form">
      <textarea id="chat-text" rows="1" placeholder="Message the chief of staff" aria-label="Message the chief of staff"></textarea>
      <button type="submit" class="primary" id="chat-send">Send</button>
    </form>`;

  // Runs off (a host that offers chat without runs): no run controls at all.
  $('.chat-run', root).hidden = !runs;
  const log = $('#chat-log', root);
  const text = $('#chat-text', root);

  async function api(path, body) {
    const res = await requestJson(path, body);
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    return { ok: res.ok, status: res.status, data };
  }

  /** What a closed card says instead of its buttons: its answer (#47 puts it on the card), or why it closed. */
  function closedText(card) {
    if (card.state === 'answered' && card.answer) {
      const a = card.answer;
      // Done under a standing rule (L22): the rule's number and line, never "rule:sr_…".
      if (Number.isInteger(a.ruleNumber) && (a.ruleForm || a.ruleLine)) return t('ledger.byrule', { time: a.at ? fmtTime(a.at) : '', n: a.ruleNumber, what: a.ruleForm ? ruleLine(a.ruleForm) : a.ruleLine }).replace(/^ · /, '');
      const label = (card.options ?? []).find((o) => o.id === a.option)?.label ?? human(a.option);
      const by = typeof a.by === 'object' ? a.by?.name ?? a.by?.id : a.by;
      return `${label}${by ? ` · ${by}` : ''}${a.at ? ` at ${fmtTime(a.at)}` : ''}${a.note ? `: ${a.note}` : ''}`;
    }
    return { answered: 'Answered', expired: 'Expired: nobody answered in time', superseded: 'No longer needed' }[card.state] ?? null;
  }

  /**
   * What a merge approval is bound to (m3-design D1): the PR and the head commit it may land, from the card's data.
   * The short sha shows; a tap shows the full one, so the person can match it against the PR before approving.
   */
  function boundHtml(card) {
    const pr = Number(card.data?.pr);
    const sha = String(card.data?.headSha ?? '');
    if (card.kind !== 'approval' || !Number.isInteger(pr) || pr < 1 || !/^[0-9a-f]{7,64}$/.test(sha)) return '';
    return `<details class="bound" data-sha-card="${esc(card.id)}"${st.shaOpen.has(card.id) ? ' open' : ''}>
      <summary>Pull request <strong>#${pr}</strong>, commit <code>${esc(sha.slice(0, 7))}</code></summary>
      <p class="sha">Exactly commit <code>${esc(sha)}</code>. If the pull request moves on, this approval no longer counts and you are asked again.</p>
    </details>`;
  }

  /**
   * What a bound approval will do (ADR 0013): the facts the control plane rendered from the signed calls, never the
   * role's words, which follow under "Why". Approving signs exactly these.
   */
  function factsHtml(card) {
    const facts = Array.isArray(card.data?.facts) ? card.data.facts.filter((f) => f && typeof f.text === 'string') : [];
    if (card.kind !== 'approval' || !facts.length) return '';
    return `<div class="facts"><p><strong>It will do exactly this${facts.length > 1 ? `, ${facts.length} steps` : ''}:</strong></p>${facts.map((f) => `<pre><code>${esc(f.text)}</code></pre>`).join('')}${facts.some((f) => f.redacted) ? '<p class="muted">Values that look like passwords or keys are hidden here as [redacted]. Approving still covers the exact steps, hidden values included.</p>' : ''}<p class="muted">Approving signs these exact steps. Anything different is asked for again.</p></div>`;
  }

  function cardHtml(card, answered) {
    answered = answered || (card.state && card.state !== 'open' ? closedText(card) ?? human(card.state) : answered);
    const note = st.notes.get(card.id);
    const rec = card.recommendation?.option;
    const recLabel = rec && (card.options ?? []).find((o) => o.id === rec)?.label;
    const known = ['approval', 'decision', 'budget'].includes(card.kind);
    // A card this person's role may not answer (a budget card below admin, #95) shows why instead of its buttons.
    const buttons = answered || st.forbidden.has(card.id) ? '' : (card.options ?? []).map((o) => {
      const style = ['primary', 'danger'].includes(o.style) ? o.style : rec === o.id ? 'primary' : '';
      return `<button type="button" class="${style}" data-card="${esc(card.id)}" data-option="${esc(o.id)}">${esc(o.label ?? o.id)}</button>`;
    }).join('');
    const links = (card.links ?? []).map((l) => safeUrl(l.url) && `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.title ?? LINKS[l.rel] ?? human(l.rel ?? 'link'))}</a>`).filter(Boolean).join(' · ');
    return `<article class="card-msg k-${known ? esc(card.kind) : 'other'}${answered ? ' answered' : ''}" data-card-id="${esc(card.id)}"${subjectId(card.subject) ? ` data-subject-id="${esc(subjectId(card.subject))}"` : ''}>
      <div class="card-meta muted">${esc(human(card.kind))}${recLabel ? ` · recommended: ${esc(recLabel)}` : ''}${card.risk ? ` · risk ${esc(card.risk)}` : ''}${card.expires && !answered ? ` · until ${esc(fmtWhen(card.expires))}` : ''}</div>
      ${note ? `<p class="card-note ${note.kind}" role="alert">${esc(note.text)}</p>` : ''}
      ${note?.kind === 'stepup' && !answered ? `<form class="stepup row" data-stepup="${esc(card.id)}" data-option="${esc(note.option)}"><input type="password" autocomplete="current-password" aria-label="${esc(t('stepup.label.interim'))}" placeholder="${esc(t('stepup.label.interim'))}" required><button type="submit" class="primary">${esc(t('stepup.button'))}</button></form>` : ''}
      <h3>${esc(card.title)}</h3>
      ${card.kind === 'approval' ? declineHtml(card, me(), organization()) : ''}
      ${boundHtml(card)}
      ${factsHtml(card)}
      ${card.body ? `${factsHtml(card) ? '<p class="muted why-label">Why, in the teammate\'s words:</p>' : ''}<div class="md">${md(card.body)}</div>` : ''}
      ${card.recommendation?.why && !answered ? `<p class="muted why">${esc(card.recommendation.why)}</p>` : ''}
      ${links ? `<p class="links">${links}</p>` : ''}
      ${answered ? `<p class="answer">${esc(answered)}</p>` : `<div class="card-actions">${buttons}</div>`}
    </article>`;
  }

  function answerText(e, card) {
    const d = e.data ?? {};
    const by = d.by ? (typeof d.by === 'object' ? d.by.name ?? d.by.id : d.by) : e.actor?.kind === 'person' ? 'you' : human(e.actor?.id);
    const what = String(d.decision ?? d.answer ?? d.option ?? 'answered');
    const label = (card?.options ?? []).find((o) => o.id === what || (o.id === 'approve' && what === 'approved') || (o.id === 'deny' && what === 'denied'))?.label;
    return `${label ?? human(what)}${by ? ` · ${by}` : ''}${e.time ? ` at ${fmtTime(e.time)}` : ''}${d.note ? `: ${d.note}` : ''}`;
  }

  /** Draws the chat, then brings a linked card or the budget into view once it is there (a notification's link). */
  function render() {
    draw();
    if (!st.focus || !st.loaded) return;
    const el = st.focus.card ? log.querySelector(`[data-card-id="${CSS.escape(st.focus.card)}"], [data-subject-id="${CSS.escape(st.focus.card)}"]`) : st.focus.budget ? $('#cost', root) : null;
    if (!el) { const budget = st.focus.budget; st.focus = null; if (budget) return; return flashNote('The card that link points to is not in the recent chat. It may be older, or already answered.'); }
    st.focus = null;
    el.classList.add('focused');
    el.scrollIntoView({ block: 'center' });
    setTimeout(() => el.classList.remove('focused'), 4000);
  }
  /** A note above the chat (not in it, so the next refresh does not wipe or repeat it), gone after a while. */
  function flashNote(text) {
    log.parentElement.querySelector('.focus-miss')?.remove();
    const n = document.createElement('p');
    n.className = 'timeline muted focus-miss';
    n.setAttribute('role', 'status');
    n.textContent = text;
    log.before(n);
    setTimeout(() => n.remove(), 15_000);
  }

  function draw() {
    if (st.connected === false) {
      log.innerHTML = `<div class="chat-empty"><p><strong>No control plane connected.</strong></p><p class="muted">The chat talks to your team's chief of staff through the control plane. Start the Studio with <code>AGENT_TEAM_SERVER</code>, <code>AGENT_TEAM_SERVER_TOKEN</code> and <code>AGENT_TEAM_SERVER_TEAM</code> set, as for the live board.</p></div>`;
      text.disabled = true; $('#chat-send', root).disabled = true;
      renderRun();
      return;
    }
    text.disabled = false; $('#chat-send', root).disabled = false;
    const answered = new Map(); // subject -> the answer event
    for (const e of st.events) {
      if (!/^(decision\.answered|approval\.decided)$/.test(e.type)) continue;
      if (e.subject) answered.set(e.subject, e);
      const id = e.data?.cardId ?? (typeof e.data?.card === 'string' ? e.data.card : null);
      if (id) answered.set(id, e);
    }
    const seen = new Set();
    // Cards that an event introduces (a request, or budget.exhausted) are drawn there; any other card where its first
    // card.updated is (a budget card, or a decision from a source that sends no decision.requested).
    const anchored = new Set(st.events.filter((e) => /\.requested$|^budget\.exhausted$/.test(e.type)).map((e) => (e.type === 'budget.exhausted' ? e.data?.cardId : cardFrom(e).id)).filter(Boolean));
    const drawn = new Set();
    const cardMsg = (card, e) => {
      drawn.add(card.id);
      const a = answered.get(card.id) ?? answered.get(e.subject ?? card.subject);
      const who = e.actor?.id && e.actor.kind !== 'system' ? human(e.actor.id) : card.kind === 'budget' ? 'Budget' : 'Team';
      return `<div class="msg them"><div class="who muted">${esc(who)} · ${esc(fmtTime(e.time))}</div>${cardHtml(card, a ? answerText(a, card) : st.answers.get(card.id))}</div>`;
    };
    let html = st.next ? '<p class="older"><button type="button" id="chat-older">Show earlier messages</button></p>' : '';
    if (!st.loaded) html += '<p class="muted chat-empty">Loading the chat…</p>';
    else if (!st.events.length && !st.pending.length) html += '<div class="chat-empty"><p class="muted">Ask the chief of staff for something, as you would ask a colleague. Your words reach the team exactly as you type them.</p></div>';
    for (const e of st.events) {
      if (e.type === 'chat.message') {
        const who = speaker(e);
        seen.add(e.data?.clientId);
        html += `<div class="msg ${who.me ? 'me' : 'them'}" id="m-${esc(e.id)}"><div class="who muted">${esc(who.name)} · <time datetime="${esc(e.time)}">${esc(fmtTime(e.time))}</time></div>
          <div class="bubble">${who.me ? `<p class="verbatim">${esc(e.data?.text)}</p>` : `<div class="md">${md(e.data?.text)}</div>`}</div></div>`;
      } else if (e.type === 'decision.requested' || e.type === 'approval.requested') {
        const base = cardFrom(e);
        if (!drawn.has(base.id)) html += cardMsg(st.cards.get(base.id) ?? base, e);
      } else if (e.type === 'card.updated') {
        const c = e.data?.card;
        if (c?.id && !anchored.has(c.id) && !drawn.has(c.id)) html += cardMsg(st.cards.get(c.id) ?? c, e);
      } else if (e.type === 'budget.exhausted') {
        html += `<p class="timeline muted">${esc(TIMELINE[e.type]?.(e) ?? "Today's budget is spent")} · ${esc(fmtTime(e.time))}</p>`;
        const c = e.data?.cardId && st.cards.get(e.data.cardId);
        if (c && !drawn.has(c.id)) html += cardMsg(c, e);
      } else if (/^(decision\.answered|approval\.decided|card\.updated|usage\.recorded)$/.test(e.type)) {
        // shown on its card, or in the cost line
      } else if (TIMELINE[e.type]) {
        html += `<p class="timeline muted">${esc(TIMELINE[e.type](e))} · ${esc(fmtTime(e.time))}</p>`;
      } else {
        html += `<p class="timeline muted">${esc(human(e.actor?.id))} · ${esc(e.type)} · ${esc(fmtTime(e.time))}</p>`;
      }
    }
    for (const p of st.pending) {
      if (seen.has(p.clientId)) continue;
      html += `<div class="msg me pending"><div class="bubble"><p class="verbatim">${esc(p.text)}</p></div><div class="who muted">${p.failed ? `Not sent: ${esc(p.failed)} <button type="button" class="link" data-retry="${esc(p.clientId)}">Try again</button>` : 'Sending…'}</div></div>`;
    }
    st.pending = st.pending.filter((p) => !seen.has(p.clientId));
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    // A live refresh redraws the log while the person may be typing a step-up secret into a card: keep what they typed
    // and where the cursor was, or the redraw silently empties the field (and the next Confirm submits nothing).
    const typing = [...log.querySelectorAll('form[data-stepup] input')].map((i) => ({ card: i.closest('form').dataset.stepup, value: i.value, focused: document.activeElement === i }));
    // A run that is going again (a budget card's Add half again, another tab) has nothing left to refuse.
    if (st.runError === SPENT && (st.run?.state ?? st.summary?.run) === 'running') { st.runError = null; st.raiseNote = null; }
    log.innerHTML = html + [st.error, st.runError].filter(Boolean).map((m) => {
      if (m !== SPENT) return `<p class="result error" role="alert">${esc(m)}</p>`;
      // Worded as it is drawn: whether today's budget card is still open decides which cap the button raises.
      const forToday = !!openBudgetCard();
      return `<p class="result error" role="alert">${esc(spentText(forToday))} <button type="button" class="link tap" id="run-raise">${forToday ? 'Raise the cap for today' : 'Raise the daily cap'}</button></p>${st.raiseNote ? `<p class="result error">${esc(st.raiseNote)}</p>` : ''}`;
    }).join('');
    for (const t of typing) {
      const input = log.querySelector(`form[data-stepup="${CSS.escape(t.card)}"] input`);
      if (!input) continue;
      input.value = t.value;
      if (t.focused) input.focus({ preventScroll: true });
    }
    if (atBottom) log.scrollTop = log.scrollHeight;
    renderRun();
  }

  function renderRun() {
    const s = st.summary, state = st.run?.state ?? s?.run ?? null;
    // A run that is going again (a budget card's Add half again, another tab) has nothing left to refuse: the run state
    // can arrive on its own (loadRun), so the log is redrawn without the spent line here too.
    if (state === 'running' && st.runError === SPENT) { st.runError = null; st.raiseNote = null; return draw(); }
    const c = st.cost ?? s?.cost;
    $('#chat-where', root).textContent = st.team ? `· ${st.team}` : '';
    const pill = $('#run-state', root);
    pill.textContent = state ? human(state) : st.connected === false ? 'Not connected' : st.connected ? 'Not running' : '…';
    pill.className = `pill ${state === 'running' ? 'ok' : state === 'paused' ? 'warn' : ''}`;
    const cost = $('#cost', root);
    if (c && typeof c.today === 'number') {
      const pct = c.capPerDay ? Math.min(100, Math.round((c.today / c.capPerDay) * 100)) : null;
      cost.innerHTML = `Today ${esc(fmtMoney(c.today, c.currency))}${c.capPerDay ? ` of ${esc(fmtMoney(c.capPerDay, c.currency))}` : ', no daily cap'}${pct !== null ? `<span class="meter${pct >= 80 ? ' high' : ''}" aria-hidden="true"><span></span></span>` : ''}`;
      // The bar's width through the DOM: a strict CSP refuses style="" in markup (embed spec 4).
      const bar = cost.querySelector('.meter > span');
      if (bar) bar.style.width = `${pct}%`;
      cost.title = c.capPerDay ? `${pct}% of today's cap${c.state === 'exhausted' ? ': the cap is reached' : ''}` : '';
      cost.classList.toggle('over', c.state === 'exhausted');
    } else cost.textContent = '';
    const going = state === 'running' || state === 'paused';
    const pause = $('#run-pause', root);
    pause.textContent = state === 'paused' ? 'Resume' : 'Pause';
    pause.disabled = st.busy || !going;
    pause.hidden = !going && st.connected === true;
    $('#run-stop', root).disabled = st.busy || !going;
    $('#run-stop', root).hidden = !going && st.connected === true;
    // With no run going, the one control is Start (the control plane allows one run per team).
    $('#run-start', root).hidden = going || st.connected !== true;
    $('#run-start', root).disabled = st.busy;
    $('#runner-add', root).hidden = st.connected !== true;
  }

  async function load() {
    const r = await api('/v1/team/chat');
    st.loaded = true;
    if (r.data.connected === false) { st.connected = false; return render(); }
    st.connected = true;
    if (!r.ok) { st.error = r.data.error ?? `HTTP ${r.status}`; return render(); }
    st.error = null;
    st.team = r.data.team;
    const latest = r.data.items ?? r.data.events ?? [];
    const ids = new Set(latest.map((e) => e.id));
    // Messages sent from this page that the page has not seen in a fetch yet stay until it does.
    const mine = st.events.filter((e) => !ids.has(e.id) && !st.older.some((o) => o.id === e.id) && st.local.has(e.id));
    st.events = [...st.older.filter((e) => !ids.has(e.id)), ...latest, ...mine];
    if (!st.older.length) st.next = r.data.next ?? null;
    takeCards(Array.isArray(r.data.cards) ? r.data.cards : Object.values(r.data.cards ?? {}));
    takeCards(st.events.filter((e) => e.type === 'card.updated').map((e) => e.data?.card));
    if ('run' in r.data || 'cost' in r.data) {
      st.run = r.data.run ?? null; st.cost = r.data.cost ?? null;
      // The chat page is newer than any summary read before it: a stopped run must not linger from one.
      if (st.summary) st.summary = { ...st.summary, run: st.run?.state ?? null };
      render();
    }
    else { render(); loadRun(); }
  }

  /** Keeps the newest version of each card (card.updated carries the whole card). */
  function takeCards(list) {
    for (const c of list) if (c?.id && (!st.cards.has(c.id) || (st.cards.get(c.id).version ?? 0) <= (c.version ?? 0))) st.cards.set(c.id, c);
  }

  async function loadOlder() {
    const r = await api(`/v1/team/chat?before=${encodeURIComponent(st.next)}`);
    if (!r.ok) return;
    const page = (r.data.items ?? r.data.events ?? []).filter((e) => !st.events.some((x) => x.id === e.id));
    st.older = [...page, ...st.older];
    st.events = [...page, ...st.events];
    st.next = r.data.next ?? null;
    render();
  }

  async function loadRun() {
    const r = await api('/v1/team/run');
    if (r.ok && r.data.connected) { st.summary = r.data.summary; st.run = r.data.run; }
    renderRun();
  }

  async function send(p) {
    p.failed = null;
    render();
    const r = await api('/v1/team/chat', { text: p.text, clientId: p.clientId });
    if (!r.ok) p.failed = r.data.error ?? `HTTP ${r.status}`;
    else if (r.data?.type === 'chat.message' && !st.events.some((e) => e.id === r.data.id)) { st.local.add(r.data.id); st.events.push(r.data); }
    render();
  }

  async function answer(cardId, option, secret) {
    const ev = st.events.find((e) => /\.requested$/.test(e.type) && cardFrom(e).id === cardId);
    const card = st.cards.get(cardId) ?? (ev && cardFrom(ev));
    if (!card) return;
    const scope = st.notes.get(cardId)?.scope ?? null; // the step-up this card asked to be bound to (ADR 0013)
    st.notes.delete(cardId);
    for (const b of log.querySelectorAll(`[data-card="${CSS.escape(cardId)}"]`)) b.disabled = true;
    if (secret) {
      const su = await api('/v1/team/step-up', { secret, ...(scope ? { scope } : {}) });
      if (!su.ok) { st.notes.set(cardId, { kind: 'stepup', option, scope, text: t(su.status === 429 ? 'stepup.locked' : 'stepup.failed') }); return render(); }
    }
    const r = await api(`/v1/team/cards/${encodeURIComponent(cardId)}`, { kind: card.kind, subject: card.subject ?? ev?.subject, option, version: card.version, key: newId() });
    if (r.status === 409 && r.data.card) {
      // Someone or something changed the card first. Show what it says now; nobody approves what they did not see.
      st.cards.set(cardId, r.data.card);
      st.notes.set(cardId, { kind: 'changed', text: 'This card changed before your answer arrived, so nothing was sent. Here is what it says now; answer again if it still applies.' });
    } else if (r.status === 401 && /step-up-required$/.test(r.data.type ?? '')) {
      // Until sign-in lands (M4), the proof is the deployment's step-up secret typed in; the Studio server keeps only the
      // short-lived step-up token the control plane gives back.
      st.notes.set(cardId, { kind: 'stepup', option, scope: typeof r.data.scope === 'string' ? r.data.scope : null, text: t('stepup.body', { action: t('stepup.action.approve', { 'card summary': card.title ?? human(card.kind) }) }) });
    } else if (r.status === 403) {
      st.forbidden.add(cardId);
      // The server's own words go to the console only (CPO); who can answer is the plain default until the server's
      // role table names the least role per card kind.
      if (r.data.error) console.info('card refused:', r.data.error);
      const org = organization() || t('org.fallback');
      st.notes.set(cardId, { kind: 'error', text: card.kind === 'budget' ? t('card.forbidden.budget', { organization: org }) : t('card.forbidden', { organization: org, 'who can': t('card.forbidden.who') }) });
    } else if (!r.ok) {
      st.notes.set(cardId, { kind: 'error', text: r.data.error ?? `HTTP ${r.status}` });
    } else {
      const label = (card.options ?? []).find((o) => o.id === option)?.label ?? option;
      st.answers.set(cardId, `${label} · you`);
      if (r.data?.type && r.data.id && !st.events.some((e) => e.id === r.data.id)) { st.local.add(r.data.id); st.events.push(r.data); }
      // The control plane (#47) answers with { card, event }: the card, answered, is the newest version.
      if (r.data?.card?.id) takeCards([r.data.card]);
    }
    render();
  }

  /** Asks for the step-up in a dialog, naming `action` (a stepup.action.* string). Resolves true once the Studio server holds a step-up token. */
  function stepUp(action, scope, lines = []) {
    const dlg = $('#stepup-dialog', root);
    const form = $('#stepup-form', root);
    const input = $('#stepup-secret', root);
    $('#stepup-why', root).textContent = t('stepup.body', { action });
    showItems($('#stepup-why', root), lines);
    $('#stepup-result', root).textContent = '';
    input.value = '';
    return new Promise((done) => {
      const finish = (ok) => { form.onsubmit = null; $('#stepup-cancel', root).onclick = null; dlg.oncancel = null; if (dlg.open) dlg.close(); done(ok); };
      form.onsubmit = async (e) => {
        e.preventDefault();
        const secret = input.value;
        input.value = '';
        // One check at a time: the control plane refuses a second one while the first runs (429), so a double tap waits.
        const confirm = form.querySelector('button[type="submit"]');
        if (confirm?.disabled) return;
        if (confirm) confirm.disabled = true;
        const r = await api('/v1/team/step-up', { secret, ...(scope ? { scope } : {}) }).finally(() => { if (confirm) confirm.disabled = false; });
        if (r.ok) return finish(true);
        $('#stepup-result', root).textContent = t(r.status === 429 ? 'stepup.locked' : 'stepup.failed');
        input.focus();
      };
      $('#stepup-cancel', root).onclick = () => finish(false);
      dlg.oncancel = () => finish(false);
      dlg.showModal();
      input.focus();
    });
  }
  const needsStepUp = (r) => r.status === 401 && /step-up-required$/.test(r.data.type ?? '');
  const spent = (r) => r.status === 409 && /budget-exhausted$/.test(r.data.type ?? '');
  /** A refusal in words for the reader: a spent budget has its own sentence and a Raise the daily cap action. */
  const refusal = (r) => (spent(r) ? SPENT : r.data.error ?? `HTTP ${r.status}`);
  /** Today's budget card, while it is open: its Add half again raises the cap for today and resumes, with one step-up. */
  const openBudgetCard = () => [...st.cards.values()].reverse().find((c) => c.kind === 'budget' && (c.state ?? 'open') === 'open' && !st.answers.has(c.id));

  /**
   * Raise the daily cap, then resume, when no budget card is open (it was answered Resume tomorrow): the amount, step-up
   * for the raise, and the resume, which asks again (each step-up is used once).
   */
  async function raiseCap() {
    const b0 = await api('/v1/team/budget');
    if (b0.ok) st.budget = b0.data;
    const c = st.cost ?? st.summary?.cost;
    const cur = currency(), d = minorDigits(cur);
    const now = st.budget?.perDay ?? c?.capPerDay ?? null;
    // An Add half again earlier today stays on top of the new cap (budget_days.raised): say so before it surprises.
    const extra = Number(st.budget?.today?.raised ?? 0);
    const asked = await askText(`New daily cap in ${cur}.${typeof c?.today === 'number' ? ` Today's spend so far is ${fmtMoney(c.today, cur)}, so the cap must be more than that.` : ''}${extra > 0 ? ` Today's extra ${fmtMoney(extra, cur)} from Add half again stays on top of it, for today only.` : ''}`, now != null ? (now / 10 ** d).toFixed(d) : '');
    if (asked === null) return;
    const perDay = toMinor(asked);
    // These keep the spent sentence and its button: the note goes under them (QA #162).
    const note = (text) => { st.raiseNote = text; render(); };
    if (perDay === null) return note('That is not an amount. Nothing changed.');
    if (typeof c?.today === 'number' && perDay + extra <= c.today) return note(`The new cap must be more than today's spend of ${fmtMoney(c.today, cur)}. Nothing changed.`);
    st.busy = true; renderRun();
    let b = await api('/v1/team/budget', { perDay, key: newId() });
    if (needsStepUp(b)) {
      if (!(await stepUp(t('stepup.action.cap', { from: fmtMoney(st.budget?.perDay ?? 0, cur), to: fmtMoney(perDay, cur) })))) { st.busy = false; renderRun(); return note('The cap was not changed, so the run is still paused.'); }
      b = await api('/v1/team/budget', { perDay, key: newId() });
    }
    st.busy = false;
    if (!b.ok) { renderRun(); return note(b.data.error ?? `HTTP ${b.status}`); }
    st.raiseNote = null;
    st.budget = b.data;
    return control('resume');
  }

  async function control(action) {
    if (action === 'stop' && !(await ask('Stop the run? Every role session stops after its current step. You can start a new run later.', { ok: 'Stop the run', cancel: 'Keep it running', danger: true }))) return;
    st.busy = true; renderRun();
    let r = await api(`/v1/team/run/${action}`, { key: newId(), run: st.run?.id });
    // Resuming needs a recent sign-in, bound to this run (ADR 0013): the control plane names the scope when it asks.
    if (needsStepUp(r) && await stepUp(t('stepup.action.resume.team'), r.data.scope)) r = await api(`/v1/team/run/${action}`, { key: newId(), run: st.run?.id });
    st.busy = false;
    // Kept apart from load errors, which the next load clears: a refused resume (today's cap is spent) must stay visible.
    st.runError = r.ok || needsStepUp(r) ? null : refusal(r);
    st.raiseNote = null;
    await load();
  }

  // ---- start a run: the published team, a daily cap first, then Start
  const currency = () => st.budget?.currency ?? 'USD';
  const toMinor = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 && String(v).trim() ? Math.round(n * 10 ** minorDigits(currency())) : null; };
  function renderStart() {
    const plan = $('#start-plan', root);
    if (!st.plan) plan.textContent = 'Reading the published team…';
    else if (!st.plan.ok) plan.textContent = st.plan.error;
    else plan.textContent = `${st.plan.summary}${st.plan.repo?.url ? ` Repository: ${st.plan.repo.url} (${st.plan.repo.ref}).` : ''}`;
    plan.classList.toggle('refused', !!st.plan && !st.plan.ok);
    renderSystems();
    $('#start-currency', root).textContent = currency();
    const d = minorDigits(currency());
    $('#start-cap', root).step = d ? String(10 ** -d) : '1';
    $('#start-cap', root).min = d ? String(10 ** -d) : '1';
    // Start stays off until there is a published team and a daily cap: the control plane refuses a run without one.
    $('#start-go', root).disabled = st.busy || !st.plan?.ok || toMinor($('#start-cap', root).value) === null;
  }
  // L40: the control plane's systems against the published ones. When they differ, the plan says so and offers to
  // send them now, behind the same systems:<team> step-up as a publish (CTO ruling on the L40 review: no new screen).
  function renderSystems() {
    const el = $('#start-systems', root);
    const s = st.systems;
    const sending = s === 'sending';
    const done = s?.result === 'done' && s.inSync;
    el.hidden = !sending && !done && (!s || s.inSync || s.connected === false);
    if (el.hidden) return;
    if (sending) { el.textContent = t('start.systems.sending'); return; }
    if (done) { el.textContent = t('publish.systems.done'); return; }
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'link'; b.id = 'start-systems-send'; b.textContent = t('start.systems.send');
    b.onclick = sendSystemsNow;
    el.replaceChildren(`${t(s.result === 'failed' ? 'start.systems.failed' : 'start.systems.behind')} `, b);
  }
  async function sendSystemsNow() {
    const was = st.systems;
    st.systems = 'sending'; renderSystems();
    const result = await sendSystems({ stepUp });
    const fresh = await systemsState();
    st.systems = fresh ? { ...fresh, result: result === 'none' ? null : result } : was;
    renderSystems();
    const el = $('#start-systems', root);
    el.tabIndex = -1;
    if (!el.hidden) ($('#start-systems-send', root) ?? el).focus();
  }
  async function openStart() {
    st.plan = null; st.budget = null;
    st.systems = null;
    $('#start-result', root).textContent = '';
    $('#start-result', root).classList.remove('error');
    $('#start-cap', root).value = '';
    renderStart();
    $('#start-dialog', root).showModal();
    const [plan, budget, systems] = await Promise.all([api('/v1/team/run/plan'), api('/v1/team/budget'), systemsState().catch(() => null)]);
    st.systems = systems;
    st.plan = plan.ok ? plan.data : { ok: false, error: plan.data.error ?? `HTTP ${plan.status}` };
    st.budget = budget.ok && budget.data.connected !== false ? budget.data : null;
    if (st.budget?.perDay != null) $('#start-cap', root).value = (st.budget.perDay / 10 ** minorDigits(currency())).toFixed(minorDigits(currency()));
    if (!budget.ok) { $('#start-result', root).textContent = budget.data.error ?? `HTTP ${budget.status}`; $('#start-result', root).classList.add('error'); }
    renderStart();
  }
  async function start() {
    const out = $('#start-result', root);
    const fail = (msg) => { out.textContent = msg; out.classList.add('error'); st.busy = false; renderStart(); };
    out.classList.remove('error');
    const perDay = toMinor($('#start-cap', root).value);
    if (perDay === null) return fail('Set a daily cap first.');
    st.busy = true; renderStart();
    if (st.budget?.perDay !== perDay) {
      out.textContent = 'Saving the daily cap…';
      let b = await api('/v1/team/budget', { perDay, key: newId() });
      if (needsStepUp(b)) {
        if (!(await stepUp(t('stepup.action.cap', { from: fmtMoney(st.budget?.perDay ?? 0, currency()), to: fmtMoney(perDay, currency()) })))) return fail('The cap was not changed, so the run did not start.');
        b = await api('/v1/team/budget', { perDay, key: newId() });
      }
      if (!b.ok) return fail(b.data.error ?? `HTTP ${b.status}`);
      st.budget = b.data;
    }
    out.textContent = 'Starting…';
    const r = await api('/v1/team/run/start', { key: newId() });
    // 409: a run is already going, today's cap is spent, or the team is not published. The control plane says which.
    if (!r.ok) return fail(spent(r) ? `Today's budget is spent. Set a higher daily cap above to start now, or start after ${resetIn()}.` : r.data.error ?? `HTTP ${r.status}`);
    st.busy = false;
    $('#start-dialog', root).close();
    await load();
    await loadRun();
  }
  // Runners (runner-protocol.md, register): a one-time code, minted after step-up and shown once. The page keeps it
  // only while the dialog is open; closing it clears the code, and the Studio server never stored it.
  const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  async function openRunners() {
    const dlg = $('#runner-dialog', root);
    $('#runner-code', root).hidden = true;
    $('#runner-code', root).innerHTML = '';
    $('#runner-result', root).textContent = '';
    $('#runner-go', root).textContent = 'Get a code';
    $('#runner-list', root).innerHTML = '';
    dlg.showModal();
    const r = await api('/v1/team/runners');
    const list = (r.ok ? r.data.runners ?? [] : []).filter((x) => !x.revoked_at);
    $('#runner-list', root).innerHTML = list.length
      ? `<p class="muted">Registered: ${list.map((x) => `<strong>${esc(x.name || x.id)}</strong>${x.last_seen ? ` <span class="muted">(last seen ${esc(fmtWhen(x.last_seen))})</span>` : ' <span class="muted">(not connected yet)</span>'}`).join(', ')}</p>`
      : '<p class="muted">No runner is registered yet.</p>';
  }
  async function mintRunnerCode() {
    const name = $('#runner-name', root).value.trim();
    const go = $('#runner-go', root);
    go.disabled = true;
    $('#runner-result', root).textContent = '';
    let r = await api('/v1/team/runners/code', { name });
    if (needsStepUp(r) && await stepUp(t('stepup.action.runner'))) r = await api('/v1/team/runners/code', { name });
    go.disabled = false;
    if (!r.ok) { $('#runner-result', root).textContent = needsStepUp(r) ? 'No code: confirming it is you was cancelled.' : r.data.error ?? `HTTP ${r.status}`; return; }
    const { code, expires, server } = r.data;
    const cmd = `agent-team-runner register --server ${shq(server)} --code ${code}${name ? ` --name ${shq(name)}` : ''}`;
    const box = $('#runner-code', root);
    box.innerHTML = `<p>Your code, shown once:</p>
      <output class="code" aria-label="Runner code">${esc(code)}</output>
      <p class="hint">It works once, until ${esc(fmtWhen(expires))} (15 minutes). When you close this, it is gone; get a new one if you need it.</p>
      <p>On the machine, run:</p>
      <pre><code id="runner-cmd">${esc(cmd)}</code></pre>
      <button type="button" id="runner-copy">Copy the command</button>`;
    box.hidden = false;
    go.textContent = 'Get a new code';
    $('#runner-copy', root).onclick = async () => {
      try { await navigator.clipboard.writeText(cmd); $('#runner-copy', root).textContent = 'Copied'; } catch { $('#runner-copy', root).textContent = 'Select the command and copy it'; }
    };
  }
  $('#runner-add', root).onclick = openRunners;
  $('#runner-go', root).onclick = mintRunnerCode;
  $('#runner-dialog', root).addEventListener('close', () => { $('#runner-code', root).innerHTML = ''; $('#runner-code', root).hidden = true; });
  $('#run-start', root).onclick = openStart;
  $('#start-go', root).onclick = start;
  $('#start-cap', root).addEventListener('input', renderStart);
  $('#start-form', root).addEventListener('submit', (e) => { if (e.submitter?.id !== 'start-go' && e.submitter?.value !== 'cancel') { e.preventDefault(); if (!$('#start-go', root).disabled) start(); } });

  $('#chat-form', root).addEventListener('submit', (e) => {
    e.preventDefault();
    if (!text.value.trim()) return;
    const p = { clientId: newId(), text: text.value };
    st.pending.push(p);
    text.value = '';
    text.style.height = '';
    send(p);
  });
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#chat-form', root).requestSubmit(); } });
  text.addEventListener('input', () => { text.style.height = ''; text.style.height = `${Math.min(text.scrollHeight, 200)}px`; });
  log.addEventListener('submit', (e) => {
    const f = e.target.closest('form[data-stepup]');
    if (!f) return;
    e.preventDefault();
    const secret = f.querySelector('input').value;
    f.querySelector('input').value = '';
    answer(f.dataset.stepup, f.dataset.option, secret);
  });
  // Keeps a card's full sha shown across live redraws.
  log.addEventListener('toggle', (e) => {
    const d = e.target.closest?.('details[data-sha-card]');
    if (d) d.open ? st.shaOpen.add(d.dataset.shaCard) : st.shaOpen.delete(d.dataset.shaCard);
  }, true);
  log.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'chat-older') return loadOlder();
    if (b.id === 'run-raise') {
      // Today's budget card raises the cap and resumes in one step-up: point to it while it is open.
      const card = openBudgetCard();
      if (card) { st.focus = { card: card.id }; return render(); }
      return raiseCap();
    }
    if (b.dataset.retry) { const p = st.pending.find((x) => x.clientId === b.dataset.retry); if (p) send(p); return; }
    if (b.dataset.card) answer(b.dataset.card, b.dataset.option);
  });
  $('#run-pause', root).onclick = () => control(st.run?.state === 'paused' || st.summary?.run === 'paused' ? 'resume' : 'pause');
  $('#run-stop', root).onclick = () => control('stop');

  return {
    /** Shows one card (`card`: its id) or today's budget (`budget: true`) when the chat has loaded: a link from an email or Slack. */
    focus(what) { st.focus = what && (what.card || what.budget) ? { ...what } : null; if (st.loaded) render(); },
    /** Starts loading and listening the first time the chat is shown. */
    open() {
      if (st.es) return;
      load();
      st.es = new EventSource(apiUrl('/v1/team/board/stream'));
      let t = null;
      st.es.addEventListener('changed', () => { clearTimeout(t); t = setTimeout(load, 100); });
      onOpen?.();
      setTimeout(() => text.focus({ preventScroll: true }), 0);
    },
    /** Stops listening (the Studio is unmounted). */
    close() { st.es?.close(); st.es = null; },
  };
}
