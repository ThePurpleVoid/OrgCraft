// "Make this a standing rule" (L22, mockup v20 signed off 2026-11-10; CPO §6b "Make this a standing rule frame").
// It starts from an approval a person approved: the control plane drafts the rule from that card's exact call (its
// kind, system, tool and fields), so nobody types what the rule covers. The owner sets the amounts or count, the
// period, how long it lasts and their own words; the line the ledger will quote is drawn from the same form, word for
// word, as they type. Making it needs a passkey scoped to that exact rule (the control plane names the scope).
import { t, tl } from './i18n.js';
import { exponentOf, ledgerLine, personWord, ruleLine } from './approvals.js';

/** The kinds a rule can be made for now; any other kind shows no button at all (CPO). */
export const ENFORCED = ['refund', 'pay.known', 'send.known'];
const LATER = ['reply', 'merge', 'cost'];
const NEVER = ['newrecipient', 'live', 'delete', 'passkey', 'outside'];
const PERIODS = ['day', 'week', 'month'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
/** The decimal mark where the Studio is open ("." in en-US, "," in de-DE), the same locale money is shown in. */
export const decimalOf = (locale) => {
  try { return new Intl.NumberFormat(locale ?? []).formatToParts(1.5).find((p) => p.type === 'decimal')?.value === ',' ? ',' : '.'; } catch { return '.'; }
};
/** Minor units as the owner types them: 2500 USD is "25", 2550 USD "25.50" ("25,50" where the mark is a comma), 2500 JPY "2500", 2500 KWD "2.5". */
export const major = (minor, currency = 'USD', locale) => {
  const e = exponentOf(currency);
  const unit = 10 ** e;
  return minor % unit === 0 ? String(minor / unit) : (minor / unit).toFixed(e).replace('.', decimalOf(locale));
};
/**
 * What the owner typed, in the rule's currency, to minor units: null when it can't be read as one amount, 0 when it is
 * zero. It follows the locale's decimal mark and never guesses (CPO, qa-web L22m D3): in en-US "1,000.50" and "$25" are
 * read, and "25,50" is refused because it could mean 25.50 or 2,550; in de-DE "1.000,50" and "25,50" are read. Spaces
 * group thousands everywhere.
 */
export function toMinor(text, currency = 'USD', locale) {
  const e = exponentOf(currency);
  const dec = decimalOf(locale);
  const grp = dec === '.' ? ',' : '.';
  let v = String(text ?? '').trim().replace(/^(?:[A-Za-z]{3}|[^\d\s.,-]{1,3})\s*/, '').replace(/[\s  ']/g, '');
  const q = (c) => `\\${c}`;
  if (v.includes(grp)) {
    // The other mark only ever groups thousands: in threes, before any decimal part.
    if (!new RegExp(`^\\d{1,3}(${q(grp)}\\d{3})+(${q(dec)}\\d*)?$`).test(v)) return null;
    v = v.split(grp).join('');
  }
  if (dec === ',') v = v.replace(',', '.');
  const m = (e ? new RegExp(`^(\\d{1,12})(?:\\.(\\d{1,${e}}))?$`) : /^(\d{1,12})$/).exec(v);
  if (!m) return null;
  const minor = Number(m[1]) * 10 ** e + Number((m[2] ?? '').padEnd(e, '0') || 0);
  return Number.isSafeInteger(minor) ? minor : null;
}
const whole = (text, max) => { const m = /^\s*(\d{1,6})\s*$/.exec(String(text ?? '')); const v = m ? Number(m[1]) : NaN; return v >= 1 && v <= max ? v : null; };

/** The sheet's starting values from the control plane's draft: its defaults, the all-customers total ticked at 10× each. */
export function initial(draft) {
  const f = draft.form ?? {};
  const cur = f.currency ?? 'USD';
  const each = f.maxEach ?? 10 ** exponentOf(cur);
  return {
    draft, period: PERIODS.includes(f.period) ? f.period : 'week', days: '30', words: '',
    each: major(each, cur), total: major(f.total ?? each * 3, cur), allOn: f.kind === 'refund', all: major(f.all ?? each * 10, cur), n: String(f.n ?? 50),
    busy: false, result: null,
  };
}

/** The rule form the sheet holds now, and what is wrong with it (CPO error lines), if anything. */
export function formOf(s) {
  const f = s.draft.form;
  const errors = [];
  const form = { ...f, period: s.period };
  delete form.all;
  if (f.kind === 'send.known') {
    const n = whole(s.n, 10_000);
    if (n === null) errors.push('rule.make.err.amount');
    form.n = n ?? 0;
  } else {
    const read = [s.each, s.total, ...(f.kind === 'refund' && s.allOn ? [s.all] : [])].map((x) => toMinor(x, f.currency));
    // Can't be read: say how to write it; zero: say it must be above zero (qa-web L22m D3).
    if (read.some((x) => x === null)) errors.push('rule.make.err.format');
    else if (read.some((x) => x === 0)) errors.push('rule.make.err.amount');
    const [each, total, all = null] = read.map((x) => (x ? x : null));
    if (each !== null && total !== null && total < each) errors.push('rule.make.err.total');
    if (all !== null && total !== null && all < total) errors.push('rule.make.err.all');
    form.maxEach = each ?? 0;
    form.total = total ?? 0;
    if (all !== null) form.all = all;
  }
  const days = whole(s.days, 90);
  if (days === null) errors.push('rule.make.err.days');
  const words = s.words.trim();
  return { form, days, words, errors, ok: !errors.length && words.length >= 3 };
}

/** The button under an approved card, for the owner, when the control plane could draft a rule of a kind made now. */
export function buttonHtml(apr, draft) {
  if (!draft || !ENFORCED.includes(draft.form?.kind)) return '';
  // One rule per approval (CTO ruling on qa-web L22m D1): once made, the card says which, with no button.
  if (draft.made?.number) return `<p class="mkrule-row muted" data-mkmade="${esc(apr)}">${esc(t('rule.make.done', { n: draft.made.number }))}</p>`;
  const letter = draft.letter ?? '';
  return `<p class="mkrule-row"><button type="button" data-mkrule="${esc(apr)}" data-tip="${esc(t('rule.make.tip', { letter }))}">${esc(t('rule.make'))}</button></p>`;
}

/** The sheet itself (mockup v20), drawn from `s`, the values the owner has typed so far. */
export function sheetHtml(apr, s, me) {
  const { draft } = s;
  const f = draft.form;
  const { form, words, errors, ok } = formOf(s);
  const id = (k) => `mr-${k}-${esc(apr)}`;
  // Each field sits where the CPO's pattern puts it ("Up to {input} each"); its label is the whole sentence.
  const sentence = (key, vars) => t(key, { input: '…', ...vars });
  const input = (k, label, width = 80, mode = 'decimal') => `<input id="${id(k)}" data-mr="${k}" inputmode="${mode}" value="${esc(s[k])}" style="width:${width}px" aria-label="${esc(label)}"${fieldErr(k, errors) ? ' aria-invalid="true"' : ''}>`;
  const periodSel = `<select id="${id('period')}" data-mr="period" aria-label="${esc(t('rule.make.period.label'))}">${PERIODS.map((p) => `<option value="${p}"${s.period === p ? ' selected' : ''}>${esc(t(`rule.period.${p}`))}</option>`).join('')}</select>`;
  const pat = (key, parts) => {
    const names = Object.keys(parts);
    return esc(t(key, Object.fromEntries(names.map((n, i) => [n, `\u0000${i}\u0000`])))).replace(/\u0000(\d)\u0000/g, (_, i) => parts[names[i]]);
  };
  const periodName = t(`rule.period.${s.period}`);
  const line = (html) => `<p class="mr-line">${html}</p>`;
  const fields = f.kind === 'send.known'
    ? line(pat('rule.make.count', { input: input('n', sentence('rule.make.count', { period: periodName }), 70, 'numeric'), period: periodSel }))
    : `${line(pat('rule.make.each', { input: input('each', sentence('rule.make.each')) }))}
      ${line(pat(f.kind === 'refund' ? 'rule.make.percustomer' : 'rule.make.count', { input: input('total', sentence(f.kind === 'refund' ? 'rule.make.percustomer' : 'rule.make.count', { period: periodName })), period: periodSel }))}
    ${f.kind === 'refund' ? `<label class="mr-check"><input type="checkbox" data-mr="allOn"${s.allOn ? ' checked' : ''} aria-describedby="${id('allhint')}"> ${esc(t('rule.refund.all'))}</label>
      <p class="hint" id="${id('allhint')}">${esc(t('rule.refund.all.hint'))}</p>
      ${s.allOn ? line(pat('rule.make.all', { input: input('all', sentence('rule.make.all', { period: periodName }), 90), period: esc(periodName) })) : ''}` : ''}`;
  const quote = ledgerLine({ kind: 'rule-added', by: me, at: new Date().toISOString(), ruleForm: form, words: words || '…' }, me);
  const result = s.result ? `<p class="result${s.result.kind === 'done' ? '' : ' error'}" role="${s.result.kind === 'done' ? 'status' : 'alert'}" tabindex="-1" id="${id('result')}">${esc(s.result.text)}</p>` : '';
  if (s.result?.kind === 'done') return `<section class="mkrule done" data-mkapr="${esc(apr)}">${result}</section>`;
  return `<section class="mkrule panel stack" data-mkapr="${esc(apr)}" aria-labelledby="${id('title')}">
    <h3 id="${id('title')}" tabindex="-1">${esc(t('rule.make.title'))}</h3>
    <p class="hint">${esc(fromLine(draft, me))}</p>
    <p><strong>${esc(t(`rule.kind.${f.kind}`))}</strong>${f.system || f.channel ? ` <span class="muted">${esc(f.system || f.channel)}</span>` : ''} <button type="button" class="info" data-tip="${esc(t('rule.make.what.tip'))}" aria-label="${esc(t('tip.button', { term: t(`rule.kind.${f.kind}`) }))}">ⓘ</button></p>
    ${fields}
    ${line(`${pat('rule.make.days', { input: input('days', sentence('rule.make.days'), 60, 'numeric') })} <span class="hint">${esc(t('rule.make.days.hint'))}</span>`)}
    ${errors.length ? `<ul class="mr-errors" role="alert">${errors.map((e) => `<li class="error">${esc(t(e))}</li>`).join('')}</ul>` : ''}
    <label for="${id('words')}"><strong>${esc(t('rule.make.words'))}</strong></label>
    <textarea id="${id('words')}" data-mr="words" rows="2" placeholder="${esc(t('rule.make.words.placeholder'))}" aria-describedby="${id('wordshint')}">${esc(s.words)}</textarea>
    <p class="hint" id="${id('wordshint')}">${esc(t('rule.make.words.hint'))}</p>
    <div class="mr-quote"><p class="hint">${esc(t('rule.make.preview'))}</p><p id="${id('quote')}" aria-live="polite">${esc(quote)}</p></div>
    <details><summary>${esc(t('rule.make.never'))}</summary><ul class="hlist">${NEVER.map((k) => `<li>${esc(tl(`rule.never.${k}`))}</li>`).join('')}</ul></details>
    <p class="hint">${esc(t('rule.make.later', { kinds: andList(LATER.map((k) => t(`rule.kind.${k}`))) }))}</p>
    ${result}
    <div class="row"><button type="button" class="primary" data-mrgo="${esc(apr)}" aria-describedby="${id('need')}"${ok && !s.busy && s.result?.kind !== 'stale' ? '' : ' disabled'}>${esc(tl('rule.make.save'))}</button><button type="button" data-mrcancel="${esc(apr)}">${esc(t('rule.make.cancel'))}</button></div>
    <p class="hint" id="${id('need')}"${words.length >= 3 ? ' hidden' : ''}>${esc(t('rule.make.need.words'))}</p>
  </section>`;
}
/** "From A, which you approved: …", or which {person} approved it (CTO: any owner, any approved card). */
function fromLine(draft, me) {
  const by = draft.approvedBy ?? null;
  const vars = { letter: draft.letter ?? '', effect: draft.effect ?? '' };
  return by?.id && by.id === me ? t('rule.make.from', vars) : t('rule.make.from.other', { ...vars, person: personWord(by?.id ?? null, by?.id ? by.name : null, me) });
}
const fieldErr = (k, errors) => ({ each: ['rule.make.err.amount', 'rule.make.err.format', 'rule.make.err.total'], total: ['rule.make.err.amount', 'rule.make.err.format', 'rule.make.err.total', 'rule.make.err.all'], all: ['rule.make.err.amount', 'rule.make.err.format', 'rule.make.err.all'], n: ['rule.make.err.amount'], days: ['rule.make.err.days'] }[k] ?? []).some((e) => errors.includes(e));

/**
 * Makes the rule: POST /v1/team/standing-rules with the form, words and days; on the control plane's 401, the passkey
 * scoped to this rule (the dialog names its line), then again. Resolves { kind: done | cancelled | stale | failed, text }.
 */
export async function makeRule({ api, stepUp, s }) {
  const { form, days, words } = formOf(s);
  const body = { ...form, words, days, approval: s.draft.approval, key: `rule-${Date.now().toString(36)}` };
  let r = await api('/v1/team/standing-rules', body);
  if (r.status === 401 && /step-up-required$/.test(r.data?.type ?? '')) {
    // The passkey dialog says how long it lasts too (security L22m low).
    if (!(await stepUp(t('stepup.action.rule.add', { 'rule line': ruleLine(form) }), r.data.scope ?? null, [t('rule.make.days', { input: days })]))) return { kind: 'cancelled', text: t('rule.make.cancelled', { letter: s.draft.letter ?? '' }) };
    r = await api('/v1/team/standing-rules', body);
  }
  if (r.ok && r.data?.id) {
    const date = r.data.expiresAt ? new Date(r.data.expiresAt).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '';
    return { kind: 'done', made: { id: r.data.id, number: r.data.number ?? null }, text: t('rule.made', { n: r.data.number ?? '', date }) };
  }
  // Already made from this approval, here or in another window: say which, and make nothing (qa-web L22m D1).
  if (r.status === 409 && /rule-exists$/.test(r.data?.type ?? '') && r.data.number) return { kind: 'done', made: { id: r.data.id ?? null, number: r.data.number }, text: t('rule.make.done', { n: r.data.number }) };
  if (r.status === 409) return { kind: 'stale', text: t('rule.make.stale') };
  return { kind: 'failed', text: t('rule.make.failed') };
}
