// The Approvals page (L22; mockup v19 Approvals, signed off; strings-now §6b): the standing rules in force with their
// use this period and Withdraw, what a rule can never cover, and the ledger, one line per decision in the person's own
// words. GET /v1/team/approvals reads all three from the control plane (apps/server/ledger.mjs) through this Studio's
// server; Withdraw narrows what the team may do, so it needs no passkey. Making a rule starts from an approved card
// (mockup v20, waiting for the owner's sign-off), so this page has no form for it.
import { requestJson } from './env.js';
import { t } from './i18n.js';
import { infoButton } from './tooltip.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDay = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? '' : d.toLocaleDateString([], { day: 'numeric', month: 'short' }); };
const fmtAt = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? '' : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
const WORDS_CUT = 200;

/** A CPO pattern with its parts joined by " · ": parts naming a value that is not set are left out (§6b). */
export function fill(key, vars) {
  return t(key).split(' · ').filter((p) => [...p.matchAll(/\{([^}]+)\}/g)].every(([, k]) => vars[k] !== undefined && vars[k] !== null))
    .map((p) => p.replace(/\{([^}]+)\}/g, (_, k) => vars[k])).join(' · ');
}

/** Minor units in the rule's currency: 2000 USD is "$20.00". */
export const money = (minor, currency = 'USD') => {
  try { return new Intl.NumberFormat([], { style: 'currency', currency }).format(minor / 100); } catch { return `${minor / 100} ${currency}`; }
};

/** A rule's one line in the CPO's words, from its structured form (never from anyone's prose). */
export function ruleLine(form = {}) {
  const period = form.period ? t(`rule.period.${form.period}`) : null;
  const base = fill(`rule.${form.kind}`, { amount: form.maxEach != null ? money(form.maxEach, form.currency) : null, total: form.total != null ? money(form.total, form.currency) : null, all: form.totalAll != null ? money(form.totalAll, form.currency) : null, system: form.system, channel: form.channel, n: form.n, period });
  // Every field a covered call may carry, so the line never reads narrower than the rule (security sev 2, code review).
  const fixed = Object.entries(form.fixed ?? {}).map(([field, value]) => t('rule.part.with', { field, value: String(value) }));
  const fields = [form.recipientField, form.amountField, form.currencyField, ...(form.free ?? []), ...Object.keys(form.fixed ?? {})].filter(Boolean);
  return [base, ...fixed, fields.length ? t('rule.part.fields', { fields: fields.join(', ') }) : null].filter(Boolean).join(' · ');
}

/** Where the field names come from, for the fields tooltip: the rule's system, else its channel, else the connector. */
const systemOf = (f) => f.system || f.channel || (/^mcp__([^_]+(?:_[^_]+)*?)__/.exec(f.tool ?? '')?.[1] ?? '').replace(/[-_]+/g, ' ');

/** A kind's name alone, for the kinds a rule cannot be made for yet: the first part of its line. */
export const kindName = (kind) => t(`rule.kind.${kind}`);

/**
 * "You" for the viewer; else the name the server gave; null from the server means they no longer have access here;
 * a server that sends no name at all gets the CPO's neutral words (never claim they lost access). Never an id.
 */
let org = '';
const person = (id, name, me) => (id && me && id === me ? t('notify.log.you') : name ? name : name === null ? t('notify.log.who.unknown') : t('person.loading', { organization: org || t('org.fallback') }));

/** Use this period: "Used 3 times this week. $40.00 left." */
export function usedLine(r) {
  const f = r.form ?? {};
  const n = r.used?.n ?? 0;
  const left = f.amountField ? money(Math.max(0, (f.total ?? 0) - (r.used?.amount ?? 0)), f.currency) : String(Math.max(0, (f.n ?? 0) - n));
  const thisPeriod = t(`rule.this.${f.period}`);
  let line = t(n === 1 ? 'rule.used.one' : 'rule.used', { n, 'this period': thisPeriod, left, reset: r.resetsAt ? fmtAt(r.resetsAt) : '\u0000' });
  if (!r.resetsAt) line = line.replace(/\s*[^.]*\u0000[^.]*\./, '');
  const out = [line];
  if (f.amountField ? (r.used?.amount ?? 0) >= f.total : n >= f.n) out.push(t('rule.limit.hit', { 'this period': thisPeriod }));
  return out.join(' ');
}

export function rulesHtml(data, me, { owner = true } = {}) {
  if (!data) return '';
  const rules = data.rules ?? [];
  const live = rules.filter((r) => r.live);
  const gone = rules.filter((r) => !r.live && r.withdrawnAt);
  const row = (r) => `<li class="rule${r.live ? '' : ' gone'}" data-rule="${esc(r.id)}">
      <p><strong>#${esc(r.number)}</strong> ${esc(ruleLine(r.form))} ${infoButton(t('rule.part.fields.tip', { system: systemOf(r.form ?? {}) }), esc, t('rule.part.fields', { fields: '' }).replace(/:\s*$/, ''))}</p>
      <p class="muted">${esc(t('rule.owner', { person: person(r.createdBy, r.createdByName, me), date: fmtDay(r.createdAt), words: r.words }))}</p>
      ${r.live ? `<p class="hint">${esc(usedLine(r))} ${esc(t('rule.expires', { date: fmtDay(r.expiresAt) }))}</p>${owner ? `<button type="button" data-withdraw="${esc(r.id)}">${esc(t('rule.withdraw'))}</button>` : ''}`
    : `<p class="hint">${esc(t('rule.withdrawn', { person: person(r.withdrawnBy, r.withdrawnByName, me), date: fmtDay(r.withdrawnAt) }))}</p>`}
    </li>`;
  const later = (data.kinds ?? []).filter((k) => !k.enforced);
  return `<section class="panel stack" id="rules" aria-labelledby="rules-title">
    <h2 id="rules-title" tabindex="-1">${esc(t('approvals.rules.heading'))}</h2>
    ${live.length ? `<ul class="plain rules">${live.map(row).join('')}</ul>` : `<p class="muted">${esc(t('approvals.rules.empty'))}</p>`}
    ${gone.length ? `<details><summary>${esc(t('approvals.rules.withdrawn'))}</summary><ul class="plain rules">${gone.map(row).join('')}</ul></details>` : ''}
    ${later.length ? `<ul class="plain kinds">${later.map((k) => `<li aria-disabled="true"><span>${esc(kindName(k.id))}</span> <span class="pill">${esc(t('rule.unavailable'))}</span></li>`).join('')}</ul>` : ''}
    <h3>${esc(t('rule.never.heading'))}</h3>
    <ul class="hlist never">${(data.never ?? []).map((n) => `<li>${esc(t(`rule.never.${n}`))}</li>`).join('')}</ul>
  </section>`;
}

/** One ledger line (§6b), the person's words quoted exactly, cut at 200 characters with Show all. */
export function ledgerLine(it, me) {
  const who = person(it.by, it.name, me);
  const time = fmtAt(it.at);
  const full = it.words ?? null;
  const words = full === null ? null : full.length > WORDS_CUT ? `${full.slice(0, WORDS_CUT)}…` : full;
  // The rule's line from its structured form when the ledger gives it (the CPO's words), else the line given.
  if (it.ruleForm) it = { ...it, ruleLine: ruleLine(it.ruleForm) };
  const v = { time, person: who, letter: it.letter ?? '', what: it.what ?? it.ruleLine ?? '', channel: it.channel ? t(`ledger.via.${it.channel}`) : null, n: it.ruleNumber, 'rule line': it.ruleLine, list: it.list };
  const q = (key) => {
    const line = fill(key, { ...v, words: '\u0000' });
    return words === null ? line.replace('"\u0000"', () => t('ledger.noword')) : line.replace('\u0000', () => words);
  };
  let text;
  if (it.kind === 'approved' || it.kind === 'denied') text = q(`${it.kind === 'approved' ? 'ledger.approved' : 'ledger.declined'}${v.letter ? '' : '.noletter'}`);
  else if (it.kind === 'doit') text = fill('ledger.doit', v);
  else if (it.kind === 'rule-added') text = q('ledger.rule');
  else if (it.kind === 'rule-used') text = fill('ledger.byrule', v);
  else if (it.kind === 'rule-withdrawn') text = fill('ledger.withdrawn', v);
  else return '';
  return text;
}

export function ledgerHtml(lg, me, { error = null } = {}) {
  const items = (lg?.items ?? []).map((it) => {
    const line = ledgerLine(it, me);
    if (!line) return '';
    const long = (it.words ?? '').length > WORDS_CUT;
    return `<li><p>${esc(line)}</p>${long ? `<details class="all"><summary>${esc(t('ledger.showall'))}</summary><p class="verbatim">“${esc(it.words)}”</p></details>` : ''}</li>`;
  }).join('');
  return `<section class="panel stack" id="ledger" aria-labelledby="ledger-title">
    <h2 id="ledger-title" tabindex="-1">${esc(t('approvals.ledger.heading'))}</h2>
    ${error ? `<p class="result error" role="alert">${esc(error)} <button type="button" id="ledger-retry">${esc(t('action.retry'))}</button></p>` : ''}
    ${items ? `<ol class="plain ledger">${items}</ol>` : error ? '' : `<p class="muted">${esc(t('approvals.ledger.empty'))}</p>`}
    ${lg?.next ? `<button type="button" id="ledger-older">${esc(t('notify.older'))}</button>` : ''}
  </section>`;
}

export function createApprovals({ root, organization = () => '' }) {
  const st = { me: null, owner: false, rules: null, ledger: null, error: null, note: null, connected: true };
  let ctl = null;
  const get = async (path, body) => { const r = await requestJson(path, body); return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) }; };

  function render() {
    if (!st.connected) { root.innerHTML = `<p class="muted">${esc(t('approvals.offline'))}</p>`; return; }
    root.innerHTML = `<h2 class="sr-only">${esc(t('nav.approvals'))}</h2>
      ${st.note ? `<p class="result ${st.note.kind}" role="${st.note.kind === 'error' ? 'alert' : 'status'}">${esc(st.note.text)}</p>` : ''}
      <div class="approvals-grid">${rulesHtml(st.rules, st.me, { owner: st.owner })}${ledgerHtml(st.ledger, st.me, { error: st.error })}</div>`;
  }

  async function load(before = null) {
    const r = await get(`/v1/team/approvals${before ? `?before=${encodeURIComponent(before)}` : ''}`).catch(() => null);
    if (!r?.ok) { st.error = t('approvals.ledger.failed'); return render(); }
    if (r.data.connected === false) { st.connected = false; return render(); }
    st.connected = true; st.error = null; st.me = r.data.me ?? st.me; st.owner = !!r.data.owner; org = organization() || org;
    if (r.data.rules) st.rules = r.data.rules;
    st.ledger = before ? { items: [...(st.ledger?.items ?? []), ...(r.data.ledger?.items ?? [])], next: r.data.ledger?.next ?? null } : r.data.ledger;
    render();
  }

  async function onClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.withdraw) {
      b.disabled = true;
      const r = await get(`/v1/team/standing-rules/${encodeURIComponent(b.dataset.withdraw)}/withdraw`, {}).catch(() => null);
      st.note = r?.ok ? null : { kind: 'error', text: t('approvals.withdraw.failed') };
      await load();
      return root.querySelector('#rules-title')?.focus?.();
    }
    if (b.id === 'ledger-older') return load(st.ledger?.next);
    if (b.id === 'ledger-retry') { await load(); return root.querySelector('#ledger-title')?.focus(); }
  }

  return {
    open() { ctl?.abort(); ctl = new AbortController(); root.addEventListener('click', onClick, { signal: ctl.signal }); load(); },
    close() { ctl?.abort(); ctl = null; },
    me: () => st.me,
  };
}
