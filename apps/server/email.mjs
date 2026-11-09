// Email notifications (PRD 6.8, architecture 12.3, CPO story "Email notifications", D49 to D54).
//
// - Providers sit behind one small interface, send(message, { fetch }) -> { id }. The server knows no vendor beyond
//   this table. A provider is only ever called with a key read from the vault by name; no key, no call.
// - Templates hold the CPO's copy. Every email has a subject under 70 characters that starts with [team], at most
//   four body lines, exactly one link into the Studio, and the footer with the unsubscribe link (verification emails
//   have no link and no footer). Text from outside the team is quoted and cut to 120 characters, and roles are
//   named by title. No email offers an action by reply: an approval email links to the card in the Studio.
// - Links are signed with a key derived from the master key. A Studio link expires (7 days, approvals 24 hours) and
//   goes through /v1/email/link, which redirects into the Studio, where sign-in and step-up apply. An unsubscribe
//   link turns off one kind for one team, with no sign-in.
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { safeReturn } from '../studio/public/auth.js';
import { Problem, getTeam, id as newId } from './store.mjs';

// ---- kinds ------------------------------------------------------------------------------------------------------

/** The kinds a person can switch on, the event type each one follows, and whether it breaks through quiet hours. */
export const KINDS = {
  approval: { type: 'approval.requested', label: 'Approval needed', breakthrough: true },
  budget80: { type: 'budget.warned', label: 'Budget at 80%', breakthrough: false },
  budget100: { type: 'budget.exhausted', label: 'Budget at 100%', breakthrough: true },
  blocked: { type: 'message.blocked', label: 'A role is blocked', breakthrough: false },
  minutes: { type: 'meeting.minutes', label: 'Meeting minutes', breakthrough: false },
  ready: { type: 'ready.posted', label: 'Ready to try', breakthrough: false },
  // L25: one email a day at the person's own time, with what their digest settings name and what quiet hours held.
  digest: { type: null, label: 'Daily digest', breakthrough: false },
};
/** Suggested the first time (D49); everything else starts off. */
export const SUGGESTED = ['approval', 'budget100'];
const KIND_OF_TYPE = Object.fromEntries(Object.entries(KINDS).filter(([, v]) => v.type).map(([k, v]) => [v.type, k]));
export const kindOfEvent = (type) => KIND_OF_TYPE[type] ?? null;

export const CODE_MINUTES = 15;
export const CODE_TRIES = 5;
const CODE_RESEND_SECONDS = 60;
/** Per person, over 24 hours (security review): codes sent, and wrong codes typed. */
export const CODES_PER_DAY = 10;
export const WRONG_PER_DAY = 20;
const DAY = 86_400_000;
/** Held mail is tried this many times after quiet hours, then given up (reason `final` in the log). */
const HELD_TRIES = 3;
export const LINK_TTL = { approval: DAY, default: 7 * DAY };

// ---- providers --------------------------------------------------------------------------------------------------

/**
 * The providers the server can send through. Each takes { apiKey, from, to, subject, text, html, headers } and
 * returns { id }. Only called by the sink and the verification step, and only with a key from the vault.
 */
export const PROVIDERS = {
  resend: {
    title: 'Resend',
    async send({ apiKey, from, to, subject, text, html, headers }, { fetch: send = fetch, timeoutMs = 15_000 } = {}) {
      const res = await send('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text, html, headers }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status >= 300) throw new Error(`HTTP ${res.status}: ${String(body?.message ?? '').slice(0, 200)}`);
      return { id: String(body?.id ?? '') };
    },
  },
};

const EMAIL = /^[^\s@<>"',;]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;
export const isEmail = (s) => typeof s === 'string' && s.length <= 254 && EMAIL.test(s);

// ---- signed tokens ----------------------------------------------------------------------------------------------

const linkKey = (key) => createHmac('sha256', key).update('agent-team email links v1').digest();
const sign = (key, payload) => createHmac('sha256', linkKey(key)).update(payload).digest('base64url');

/** A signed, URL-safe token for a JSON payload. */
export function token(key, data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${payload}.${sign(key, payload)}`;
}

/** The payload of a token this server signed, or null. */
export function readToken(key, text) {
  const [payload, mac, extra] = String(text ?? '').split('.');
  if (!payload || !mac || extra !== undefined) return null;
  const want = Buffer.from(sign(key, payload));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
}

const codeHash = (key, sub, code) => createHmac('sha256', linkKey(key)).update(`code\0${sub}\0${code}`).digest('base64url');

// ---- words ------------------------------------------------------------------------------------------------------

const UPPER = new Set(['ai', 'api', 'cco', 'cfo', 'cmo', 'coo', 'cpo', 'cro', 'cto', 'ceo', 'ios', 'qa', 'ui', 'ux', 'seo', 'hr', 'it']);
/** A role's title from its slug ("web-dev" -> "Web dev", "qa-web" -> "QA web"), unless the event names one. */
export function roleTitle(slug, titles = {}) {
  if (titles[slug]) return titles[slug];
  const words = String(slug ?? '').split('-').filter(Boolean).map((w) => (UPPER.has(w) ? w.toUpperCase() : w));
  if (!words.length) return 'A role';
  if (!UPPER.has(words[0].toLowerCase())) words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return words.join(' ');
}

/** Text from outside the team: one line, at most 120 characters (D52). The template adds the quotes. */
export function outside(text, max = 120) {
  const one = String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** Minor units as money: 425 USD -> "$4.25"; other currencies by their code. */
export function money(minor, currency = 'USD') {
  const n = Number(minor ?? 0) / 100;
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n); } catch { return `${n.toFixed(2)} ${currency}`; }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cutSubject = (s, max = 69) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const nextUtcMidnight = (iso) => { const d = new Date(iso ?? Date.now()); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)); };
const hhmm = (d) => `${d.toISOString().slice(11, 16)} UTC`;

// ---- templates (the CPO's copy) ---------------------------------------------------------------------------------

/**
 * The email for one event: { kind, subject, lines, link: { label, path } } or null when the event has no email.
 * `path` is where in the Studio the link lands. Pure, so tests can render every kind.
 */
export function compose(event, { teamName, titles = {} } = {}) {
  const kind = kindOfEvent(event?.type);
  if (!kind) return null;
  const d = event.data ?? {};
  const team = teamName || event.team;
  const tag = `[${team}]`;
  const role = roleTitle(event.actor?.kind === 'role' ? event.actor.id : (d.role ?? event.actor?.id), titles);
  const at = encodeURIComponent(event.team);
  const rec = d.recommendation ? `Recommendation: ${outside(d.recommendation)}` : null;
  if (kind === 'approval') {
    const summary = outside(d.summary ?? d.why ?? d.action ?? 'an action');
    return {
      kind, subject: cutSubject(`${tag} Approval needed: ${summary}`),
      lines: [`${role} needs your approval before it can go on.`, `"${summary}"`, rec, 'Nothing happens until you approve in the Studio.'].filter(Boolean),
      link: { label: 'Review in the Studio', path: `/teams/${at}/inbox${d.cardId ? `?card=${encodeURIComponent(d.cardId)}` : ''}` },
    };
  }
  if (kind === 'budget80') {
    return {
      kind, subject: cutSubject(`${tag} 80% of today's budget used`),
      lines: [`Your team has used ${money(d.spent, d.currency)} of its ${money(d.cap, d.currency)} daily budget.`, 'Work carries on. At 100% only release-blocking fixes and checks keep running.'],
      link: { label: "See today's usage", path: `/teams/${at}/budget` },
    };
  }
  if (kind === 'budget100') {
    return {
      kind, subject: cutSubject(`${tag} Daily budget reached, new work paused`),
      lines: [`Your team has used its ${money(d.cap, d.currency)} daily budget.`, `New work is paused until ${hhmm(nextUtcMidnight(event.time))}. Raise the cap in the Studio to resume sooner.`],
      link: { label: 'See usage and the cap', path: `/teams/${at}/budget` },
    };
  }
  if (kind === 'blocked') {
    const question = outside(d.question ?? d.detail ?? d.task ?? 'a decision');
    return {
      kind, subject: cutSubject(`${tag} ${role} is waiting on a decision`),
      lines: [`${role} is blocked on: "${question}"`, rec, 'It keeps working on the recommendation unless the step cannot be undone.'].filter(Boolean),
      link: { label: 'Answer in the Studio', path: `/teams/${at}/board?role=${encodeURIComponent(event.actor?.id ?? '')}` },
    };
  }
  if (kind === 'ready') {
    // The CPO's copy, "Copy: Ready to try notification" in docs/team/lanes/cpo.md.
    const feature = outside(d.title ?? 'A change');
    return {
      kind, subject: cutSubject(`${tag} Ready to try: ${feature}`),
      lines: [`${role} says "${feature}" is ready for you to try.`, "It's done and passed its checks."],
      link: { label: d.preview ? 'See the preview in the Studio' : 'Try it in the Studio', path: `/teams/${at}/inbox${d.cardId ? `?card=${encodeURIComponent(d.cardId)}` : ''}` },
    };
  }
  // minutes
  const decisions = Array.isArray(d.decisions) ? d.decisions : [], actions = Array.isArray(d.actions) ? d.actions : [];
  const date = String(d.date ?? event.time ?? '').slice(0, 10);
  const needs = Number(d.needsYou ?? 0);
  return {
    kind, subject: cutSubject(`${tag} Minutes: ${outside(d.meeting ?? 'Meeting', 40)} (${date})`),
    lines: [`${decisions.length} ${decisions.length === 1 ? 'decision' : 'decisions'} and ${actions.length} action ${actions.length === 1 ? 'item' : 'items'}.`,
      decisions.length ? `"${outside(decisions[0]?.text ?? decisions[0])}"` : 'No decisions this time.',
      needs > 0 ? `${needs} ${needs === 1 ? 'item needs' : 'items need'} you.` : null].filter(Boolean),
    link: { label: 'Read the minutes', path: `/teams/${at}/meetings${d.meetingId ? `/${encodeURIComponent(d.meetingId)}` : ''}` },
  };
}

/** The verification email (no link, no footer). */
export function verifyEmail(code) {
  return {
    subject: `Your code for OrgCraft Studio: ${code}`,
    text: ['Enter this code in the Studio to get team emails at this address:', code, `It expires in ${CODE_MINUTES} minutes. If you did not ask for it, ignore this email; nothing will be sent.`].join('\n'),
    html: `<p>Enter this code in the Studio to get team emails at this address:</p><p style="font-size:24px;font-weight:600;letter-spacing:4px">${esc(code)}</p><p>It expires in ${CODE_MINUTES} minutes. If you did not ask for it, ignore this email; nothing will be sent.</p>`,
  };
}

/**
 * The message for one event and one subscription: { subject, text, html, headers }. `base` is this server's public
 * URL (links go through it), and the link and unsubscribe tokens are signed with the master key.
 */
export function render(key, mail, { base, tenant, team, teamName, subscription, now = new Date() }) {
  const ttl = LINK_TTL[mail.kind] ?? LINK_TTL.default;
  const root = String(base ?? '').replace(/\/+$/, '');
  const link = `${root}/v1/email/link?t=${token(key, { t: tenant, p: mail.link.path, e: now.getTime() + ttl })}`;
  const unsub = `${root}/v1/email/unsubscribe?t=${token(key, { t: tenant, s: subscription, k: mail.kind })}`;
  const settings = `${root}/v1/email/link?t=${token(key, { t: tenant, p: `/teams/${encodeURIComponent(team)}/notifications`, e: now.getTime() + LINK_TTL.default })}`;
  const kindLabel = KINDS[mail.kind].label;
  const footer = `You get this because you turned on "${kindLabel}" emails for ${teamName}.`;
  const text = [...mail.lines, '', `${mail.link.label}: ${link}`, '', '--', footer, `Turn off these emails: ${unsub}`, `Manage all emails: ${settings}`].join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;max-width:560px">${mail.lines.map((l) => `<p style="margin:0 0 8px">${esc(l)}</p>`).join('')}`
    + `<p style="margin:16px 0"><a href="${esc(link)}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#1f4fd1;color:#fff;text-decoration:none">${esc(mail.link.label)}</a></p>`
    + `<p style="margin:24px 0 0;font-size:12px;color:#666">${esc(footer)} <a href="${esc(unsub)}" style="color:#666">Turn off these emails</a> · <a href="${esc(settings)}" style="color:#666">Manage all emails</a></p></div>`;
  // One-click unsubscribe for mail clients (RFC 8058).
  const headers = { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
  return { subject: mail.subject, text, html, headers };
}

// ---- subscriptions ----------------------------------------------------------------------------------------------

const SUB_COLS = 'id, email, kinds, verified_at, created_at';
const view = (r) => ({ id: r.id, email: r.email, verified: !!r.verified_at, kinds: r.kinds ?? [], createdAt: r.created_at });

/** The team's email sink (at most one is used: the oldest). */
async function emailSink(q, team) {
  return (await q('select id, provider, sender, secret from email_sinks where team = $1 order by created_at limit 1', [team]))[0] ?? null;
}

/**
 * The email side of the API, for one deployment. `providers` defaults to PROVIDERS (tests pass a fake), `readSecret`
 * reads the provider key by the name the sink holds.
 */
export function createEmail({ db, key, publicUrl = '', providers = PROVIDERS, readSecret, now = () => new Date(), fetch: send = fetch }) {
  const base = () => publicUrl;

  /** The team's sink, provider and key, or why it cannot send yet. */
  async function sender(tenant, team) {
    const sink = await db.tenant(tenant, ({ q }) => emailSink(q, team));
    if (!sink) return { reason: 'this team has no email sink yet' };
    const provider = providers[sink.provider];
    const apiKey = provider ? await readSecret(db, key, tenant, sink.secret) : null;
    if (!provider || !apiKey) return { reason: `no provider key stored as ${sink.secret}` };
    return { sink, provider, apiKey };
  }

  async function sendVerification(tenant, team, sub, code) {
    const { sink, provider, apiKey, reason } = await sender(tenant, team);
    if (reason) return { sent: false, reason };
    const m = verifyEmail(code);
    try {
      await provider.send({ apiKey, from: sink.sender, to: sub.email, subject: m.subject, text: m.text, html: m.html, headers: {} }, { fetch: send });
      return { sent: true };
    } catch (e) { return { sent: false, reason: `the provider refused: ${String(e.message ?? e).slice(0, 200)}` }; }
  }

  return {
    kinds: () => Object.entries(KINDS).map(([id, k]) => ({ id, label: k.label, breakthrough: k.breakthrough, suggested: SUGGESTED.includes(id) })),

    /** The person's addresses, the kinds, the team's name, and `ready`: whether the team can send a code at all. */
    async list(tenant, team, principal) {
      const t = await getTeam(db, tenant, team);
      const rows = await db.tenant(tenant, ({ q }) => q(`select ${SUB_COLS} from email_subscriptions where team = $1 and principal = $2 order by created_at`, [team, principal]));
      return { teamName: t.name ?? team, ready: !(await sender(tenant, team)).reason, kinds: this.kinds(), emails: rows.map(view) };
    },

    /** Adds an address (or sends a fresh code for one not yet verified). Nothing is emailed to it but the code. */
    async add(tenant, team, principal, body) {
      await getTeam(db, tenant, team);
      const email = String(body?.email ?? '').trim().toLowerCase();
      if (!isEmail(email)) throw new Problem(400, 'send { email } with one email address');
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const t = now();
      const sub = await db.tenant(tenant, async ({ q }) => {
        const [old] = await q('select id, verified_at, code_sent_at from email_subscriptions where team = $1 and principal = $2 and email = $3', [team, principal, email]);
        if (old?.verified_at) return { ...old, email, already: true };
        if (old?.code_sent_at && t - new Date(old.code_sent_at) < CODE_RESEND_SECONDS * 1000) throw new Problem(429, `a code was sent less than ${CODE_RESEND_SECONDS} seconds ago; wait for it`);
        const [{ n }] = await q("select count(*)::int as n from email_code_events where principal = $1 and what = 'sent' and at > $2", [principal, new Date(t.getTime() - DAY)]);
        if (n >= CODES_PER_DAY) throw new Problem(429, `at most ${CODES_PER_DAY} codes a day; try again tomorrow`);
        await q("insert into email_code_events(tenant, principal, what, at) values ($1, $2, 'sent', $3)", [tenant, principal, t]);
        const sid = old?.id ?? newId('eml');
        const expires = new Date(t.getTime() + CODE_MINUTES * 60_000);
        if (old) await q('update email_subscriptions set code_hash = $2, code_expires = $3, code_tries = 0, code_sent_at = $4 where id = $1', [sid, codeHash(key, sid, code), expires, t]);
        else await q('insert into email_subscriptions(id, tenant, team, principal, email, code_hash, code_expires, code_sent_at) values ($1, $2, $3, $4, $5, $6, $7, $8)', [sid, tenant, team, principal, email, codeHash(key, sid, code), expires, t]);
        return { id: sid, email };
      });
      if (sub.already) return { id: sub.id, email, verified: true, sent: false, reason: 'this address is already verified' };
      return { id: sub.id, email, verified: false, ...(await sendVerification(tenant, team, sub, code)) };
    },

    async verify(tenant, team, principal, sid, body) {
      const code = String(body?.code ?? '').trim();
      // A wrong code is counted and then refused outside the transaction, so the count is kept.
      const out = await db.tenant(tenant, async ({ q }) => {
        const [s] = await q('select id, code_hash, code_expires, code_tries, verified_at from email_subscriptions where id = $1 and team = $2 and principal = $3', [sid, team, principal]);
        if (!s) throw new Problem(404, 'no such email address');
        if (s.verified_at) return { id: s.id, verified: true };
        if (!s.code_hash || s.code_tries >= CODE_TRIES) throw new Problem(410, 'too many tries or no code: ask for a new code');
        const [{ n }] = await q("select count(*)::int as n from email_code_events where principal = $1 and what = 'wrong' and at > $2", [principal, new Date(now().getTime() - DAY)]);
        if (n >= WRONG_PER_DAY) throw new Problem(429, `too many wrong codes today; try again tomorrow`);
        if (new Date(s.code_expires) < now()) throw new Problem(410, `the code expired after ${CODE_MINUTES} minutes: ask for a new one`);
        const want = Buffer.from(s.code_hash), got = Buffer.from(codeHash(key, s.id, code));
        if (!/^\d{6}$/.test(code) || want.length !== got.length || !timingSafeEqual(want, got)) {
          await q('update email_subscriptions set code_tries = code_tries + 1 where id = $1', [s.id]);
          await q("insert into email_code_events(tenant, principal, what, at) values ($1, $2, 'wrong', $3)", [tenant, principal, now()]);
          return { wrong: true };
        }
        await q('update email_subscriptions set verified_at = $2, code_hash = null, code_expires = null where id = $1', [s.id, now()]);
        return { id: s.id, verified: true };
      });
      if (out.wrong) throw new Problem(400, 'that code is not right');
      return out;
    },

    /** Switches kinds on or off for a verified address (D49: nothing is sent before this). */
    async setKinds(tenant, team, principal, sid, body) {
      const kinds = Array.isArray(body?.kinds) ? [...new Set(body.kinds.map(String))] : null;
      if (!kinds || kinds.some((k) => !KINDS[k])) throw new Problem(400, `send { kinds: [...] } from ${Object.keys(KINDS).join(', ')}`);
      return db.tenant(tenant, async ({ q }) => {
        const [s] = await q('select id, verified_at from email_subscriptions where id = $1 and team = $2 and principal = $3', [sid, team, principal]);
        if (!s) throw new Problem(404, 'no such email address');
        if (!s.verified_at) throw new Problem(409, 'verify the address with its code first');
        return view((await q(`update email_subscriptions set kinds = $2 where id = $1 returning ${SUB_COLS}`, [sid, kinds]))[0]);
      });
    },

    async remove(tenant, team, principal, sid) {
      const rows = await db.tenant(tenant, ({ q }) => q('delete from email_subscriptions where id = $1 and team = $2 and principal = $3 returning id', [sid, team, principal]));
      if (!rows.length) throw new Problem(404, 'no such email address');
      return { ok: true };
    },

    /** What an unsubscribe token is about, without changing anything (the page a GET shows). */
    async peekToken(text) {
      const tk = readToken(key, text);
      if (!tk?.t || !tk.s || !KINDS[tk.k]) return null;
      return db.tenant(tk.t, async ({ q }) => {
        const [s] = await q('select s.team, t.name from email_subscriptions s join teams t on t.id = s.team where s.id = $1', [tk.s]);
        return s ? { teamName: s.name, team: s.team, kind: tk.k, label: KINDS[tk.k].label } : null;
      });
    },

    /** Turns one kind off (or back on) from a signed unsubscribe token, without sign-in (D54). */
    async fromToken(text, on) {
      const tk = readToken(key, text);
      if (!tk?.t || !tk.s || !KINDS[tk.k]) return null;
      return db.tenant(tk.t, async ({ q }) => {
        const [s] = await q('select s.id, s.team, s.kinds, t.name from email_subscriptions s join teams t on t.id = s.team where s.id = $1', [tk.s]);
        if (!s) return null;
        const kinds = on ? [...new Set([...(s.kinds ?? []), tk.k])] : (s.kinds ?? []).filter((k) => k !== tk.k);
        await q('update email_subscriptions set kinds = $2 where id = $1', [s.id, kinds]);
        return { teamName: s.name, team: s.team, kind: tk.k, label: KINDS[tk.k].label, on };
      });
    },

    /** Where a signed Studio link goes, or null when it is not ours or has expired. */
    linkTarget(text) {
      const tk = readToken(key, text);
      if (!tk?.p || typeof tk.p !== 'string' || safeReturn(tk.p) !== tk.p) return null;
      return { path: tk.p, expired: !(Number(tk.e) > now().getTime()) };
    },
    base,
  };
}

/** The small pages the email links land on (no sign-in). */
export function page(title, lines, buttons = []) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>`
    + '<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;line-height:1.5;color:#1b1b1b;background:#fff}form,a.b{display:inline-block;margin:8px 8px 0 0}button,a.b{font:inherit;padding:10px 16px;border-radius:6px;border:1px solid #1f4fd1;background:#1f4fd1;color:#fff;text-decoration:none;cursor:pointer}a.b.s,button.s{background:#fff;color:#1f4fd1}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}a.b.s,button.s{background:#111}}</style></head>'
    + `<body><h1>${esc(title)}</h1>${lines.map((l) => `<p>${esc(l)}</p>`).join('')}`
    + buttons.map((b) => (b.post ? `<form method="post" action="${esc(b.href)}"><button type="submit"${b.secondary ? ' class="s"' : ''}>${esc(b.label)}</button></form>` : `<a class="b${b.secondary ? ' s' : ''}" href="${esc(b.href)}">${esc(b.label)}</a>`)).join('')
    + '</body></html>';
}

/**
 * SQL: the row's person (alias.principal, in alias.tenant) still has a way in: an active member, or the local admin
 * until someone owns the workspace. Shared by email and Slack.
 */
export const stillIn = (a) => `((${a}.principal = 'admin' and not exists(select 1 from members o where o.tenant = ${a}.tenant and o.role = 'owner' and o.removed_at is null))
        or exists(select 1 from members m where m.person = ${a}.principal and m.tenant = ${a}.tenant and m.removed_at is null))`;

/**
 * The email side of the sink worker: sends `event` to every verified subscription of the team that has its kind on
 * and whose person is still a member of the workspace, or the local admin until someone owns the workspace (the admin
 * token is retired then, so nobody could see or remove those addresses),
 * and logs each try. Returns null when done, or an error text to retry the event later (a sent recipient is never
 * sent the same event twice). With no key in the vault, nothing is sent: the deliveries are logged as skipped.
 */
export async function deliver(db, key, sink, row, { providers = PROVIDERS, readSecret, publicUrl = '', now = new Date(), fetch: send = fetch } = {}) {
  const event = row.envelope;
  const kind = kindOfEvent(event?.type);
  if (!kind) return null;
  const { tenant, team } = sink;
  const subs = await db.tenant(tenant, ({ q }) => q(`select s.id, s.email, (select name from teams where id = s.team) as team_name,
      exists(select 1 from email_deliveries d where d.subscription = s.id and d.event = $3 and (d.status = 'sent' or d.held)) as done,
      p.timezone, p.quiet_start, p.quiet_end
    from email_subscriptions s left join notification_prefs p on p.tenant = s.tenant and p.principal = s.principal
    where s.team = $1 and s.verified_at is not null and $2 = any(s.kinds)
      and ${stillIn('s')}`, [team, kind, event.id]));
  // Quiet hours (L25): a kind that does not break through waits, logged as held. It goes in the person's digest, or,
  // for an address without one, out on its own when quiet hours end (flushHeld; review sev 2).
  const quiet = KINDS[kind].breakthrough ? [] : subs.filter((s) => !s.done && inQuiet(s, now));
  for (const s of quiet) await db.tenant(tenant, ({ q }) => q("insert into email_deliveries(tenant, team, subscription, event, kind, status, held, error) values ($1, $2, $3, $4, $5, 'skipped', true, 'quiet hours: kept for the digest')", [tenant, team, s.id, event.id, kind]));
  const todo = subs.filter((s) => !s.done && !quiet.includes(s));
  if (!todo.length) return null;
  return (await sendTo(db, key, sink, event, kind, todo, { providers, readSecret, publicUrl, now, fetch: send })).error;
}

/** Is it inside this person's quiet hours, in their own time zone? (minutes of the day; may wrap past midnight) */
export function inQuiet({ timezone, quiet_start: a, quiet_end: b }, at = new Date()) {
  if (a === null || a === undefined || b === null || b === undefined || a === b) return false;
  const m = minuteOfDay(at, timezone || 'UTC');
  return a < b ? m >= a && m < b : m >= a || m < b;
}

export function minuteOfDay(at, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: 'numeric', minute: 'numeric' }).formatToParts(at).map((x) => [x.type, x.value]));
  return (Number(p.hour) % 24) * 60 + Number(p.minute);
}

/** Sends one event to the given subscriptions through the sink's provider, logging each try. */
async function sendTo(db, key, sink, event, kind, todo, { providers = PROVIDERS, readSecret, publicUrl = '', now = new Date(), fetch: send = fetch }) {
  const { tenant, team } = sink;
  const log = (s, status, extra = {}) => db.tenant(tenant, ({ q }) => q('insert into email_deliveries(tenant, team, subscription, event, kind, status, provider_id, error) values ($1, $2, $3, $4, $5, $6, $7, $8)',
    [tenant, team, s.id, event.id, kind, status, extra.id ?? null, extra.error ?? null]));
  const provider = providers[sink.provider];
  const apiKey = provider && sink.secret ? await readSecret(db, key, tenant, sink.secret) : null;
  if (!provider || !apiKey) {
    for (const s of todo) await log(s, 'skipped', { error: provider ? `no provider key stored as ${sink.secret}` : `unknown provider ${sink.provider}` });
    return { error: null, sent: 0 };
  }
  let error = null, sent = 0;
  for (const s of todo) {
    const mail = compose(event, { teamName: s.team_name });
    const msg = render(key, mail, { base: publicUrl, tenant, team, teamName: s.team_name, subscription: s.id, now });
    try {
      const r = await provider.send({ apiKey, from: sink.sender, to: s.email, ...msg }, { fetch: send });
      await log(s, 'sent', { id: r?.id });
      sent++;
    } catch (e) {
      error = String(e.message ?? e).slice(0, 200);
      await log(s, 'failed', { error });
    }
  }
  return { error, sent };
}

/**
 * When Slack fails (CPO story "Slack notifications", criterion 7): sends `event` by email to every verified address
 * the person has for the team, even one with that kind off for email (they asked for it in Slack, and email only
 * stands in for Slack here), unless an address already got it. Returns how
 * many emails went out (0 when the team has no email sink or no key, or the person has no verified address).
 */
export async function emailFallback(db, key, { tenant, team, principal, event }, opts = {}) {
  const kind = kindOfEvent(event?.type);
  if (!kind) return 0;
  const [sink] = await db.tenant(tenant, ({ q }) => q('select id, tenant, team, provider, sender, secret from email_sinks where team = $1 order by created_at limit 1', [team]));
  if (!sink) return 0;
  const subs = await db.tenant(tenant, ({ q }) => q(`select s.id, s.email, (select name from teams where id = s.team) as team_name
    from email_subscriptions s where s.team = $1 and s.principal = $2 and s.verified_at is not null and ${stillIn('s')}
      and not exists(select 1 from email_deliveries d where d.subscription = s.id and d.event = $3 and d.status = 'sent')`, [team, principal, event.id]));
  if (!subs.length) return 0;
  return (await sendTo(db, key, sink, event, kind, subs, opts)).sent;
}

// ---- quiet hours and the daily digest (L25) ---------------------------------------------------------------------

export const DIGEST_MAX_LINES = 20;
const DIGEST_TRIES = 3;

/** The person's local date (YYYY-MM-DD) in their zone. */
export function localDate(at, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Is this an IANA zone the server understands? */
export function isZone(z) {
  if (typeof z !== 'string' || !z || z.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; }
}

/** The digest email for one subscription: what quiet hours held plus the digest kinds, newest last. Pure. */
export function composeDigest(events, { team, teamName, date }) {
  const items = events.map((e) => compose(e, { teamName })).filter(Boolean);
  const tag = `[${teamName || team}]`;
  const shown = items.slice(-DIGEST_MAX_LINES).map((m) => `- ${m.subject.replace(`${tag} `, '')}`);
  const more = items.length - shown.length;
  return {
    kind: 'digest',
    subject: cutSubject(`${tag} Daily digest: ${items.length} ${items.length === 1 ? 'update' : 'updates'} (${date})`),
    lines: [items.length ? `Here is what happened while your emails were held or set to the digest.` : 'Nothing new since your last digest.', ...shown,
      more > 0 ? `And ${more} more in the Studio.` : null].filter(Boolean),
    link: { label: 'Open the team in the Studio', path: `/teams/${encodeURIComponent(team)}/inbox` },
  };
}

/**
 * One digest pass (run by the sink worker): for every subscription with "digest" turned on whose person's digest
 * time has passed today in their own zone, sends one digest, logged as event digest-<local date>. A sent or skipped
 * digest is not tried again that day; a failed one is tried up to three times.
 */
export async function digests(db, key, { providers = PROVIDERS, readSecret, publicUrl = '', now = new Date(), fetch: send = fetch } = {}) {
  const due = await db.system(`select s.id, s.tenant, s.team, s.email, s.principal, t.name as team_name, p.timezone, p.digest_at, p.digest_kinds
    from email_subscriptions s join teams t on t.id = s.team join notification_prefs p on p.tenant = s.tenant and p.principal = s.principal
    where s.verified_at is not null and 'digest' = any(s.kinds) and p.digest_at is not null and ${stillIn('s')}`);
  let sent = 0;
  for (const s of due) {
    const zone = isZone(s.timezone) ? s.timezone : 'UTC';
    if (minuteOfDay(now, zone) < s.digest_at) continue;
    const event = `digest-${localDate(now, zone)}`;
    const [state] = await db.tenant(s.tenant, ({ q }) => q(`select count(*) filter (where status in ('sent', 'skipped'))::int as done, count(*) filter (where status = 'failed')::int as failed
      from email_deliveries where subscription = $1 and event = $2`, [s.id, event]));
    if (state.done || state.failed >= DIGEST_TRIES) continue;
    const [sink] = await db.tenant(s.tenant, ({ q }) => q('select id, tenant, team, provider, sender, secret from email_sinks where team = $1 order by created_at limit 1', [s.team]));
    if (!sink) continue;
    // Since the last digest that went out, at most a week back.
    const types = (s.digest_kinds ?? []).map((k) => KINDS[k]?.type).filter(Boolean);
    const events = await db.tenant(s.tenant, ({ q }) => q(`with since as (
        select greatest(coalesce(max(at), $3::timestamptz - interval '1 day'), $3::timestamptz - interval '7 days') as at
        from email_deliveries where subscription = $1 and kind = 'digest' and status = 'sent')
      select e.envelope from events e, since where e.team = $2 and e.received_at > since.at and e.received_at <= $3 and (
        e.type = any($4) or exists(select 1 from email_deliveries d where d.subscription = $1 and d.held and d.event = e.id))
      order by e.seq`, [s.id, s.team, now, types]));
    // Nothing new: no email (the window carries on from the last digest that went out).
    if (!events.length) continue;
    const mail = composeDigest(events.map((r) => r.envelope), { team: s.team, teamName: s.team_name, date: event.slice(7) });
    const r = await sendMail(db, key, sink, { id: event }, mail, s, { providers, readSecret, publicUrl, now, fetch: send });
    sent += r;
  }
  return sent;
}

/**
 * When quiet hours end (run with the digests, once a minute): held mail for an address without a digest goes out as
 * usual, each event once. An address with the digest on keeps its held mail for the digest.
 */
export async function flushHeld(db, key, { providers = PROVIDERS, readSecret, publicUrl = '', now = new Date(), fetch: send = fetch } = {}) {
  const held = await db.system(`select s.id, s.tenant, s.team, s.email, t.name as team_name, p.timezone, p.quiet_start, p.quiet_end, d.kind, e.envelope
    from email_deliveries d join email_subscriptions s on s.id = d.subscription join teams t on t.id = s.team
    join events e on e.team = d.team and e.id = d.event
    left join notification_prefs p on p.tenant = s.tenant and p.principal = s.principal
    where d.held and d.at > $1::timestamptz - interval '7 days' and s.verified_at is not null and d.kind = any(s.kinds)
      and not ('digest' = any(s.kinds) and p.digest_at is not null)
      and not exists(select 1 from email_deliveries x where x.subscription = d.subscription and x.event = d.event and x.status = 'sent')
      -- A failing send is tried 3 times, like a digest (review sev 4).
      and (select count(*) from email_deliveries f where f.subscription = d.subscription and f.event = d.event and f.status = 'failed') < ${HELD_TRIES}
      -- Still inside the person's quiet hours: not yet, and not counted against the limit (review sev 4).
      and not coalesce((with z as (select case when exists(select 1 from pg_timezone_names n where n.name = p.timezone) then p.timezone else 'UTC' end as tz),
        m as (select (extract(hour from $1::timestamptz at time zone z.tz) * 60 + extract(minute from $1::timestamptz at time zone z.tz))::int as v from z)
        select case when p.quiet_start < p.quiet_end then m.v >= p.quiet_start and m.v < p.quiet_end else m.v >= p.quiet_start or m.v < p.quiet_end end from m), false)
      -- What a digest already carried is not sent again (the digest was on when it was held).
      and not exists(select 1 from email_deliveries g where g.subscription = d.subscription and g.kind = 'digest' and g.status = 'sent' and g.at >= d.at)
      and ${stillIn('s')}
    order by e.seq limit 200`, [now]);
  let sent = 0;
  for (const h of held) {
    if (inQuiet(h, now)) continue;
    const [sink] = await db.tenant(h.tenant, ({ q }) => q('select id, tenant, team, provider, sender, secret from email_sinks where team = $1 order by created_at limit 1', [h.team]));
    if (!sink) continue;
    sent += (await sendTo(db, key, sink, h.envelope, h.kind, [h], { providers, readSecret, publicUrl, now, fetch: send })).sent;
  }
  return sent;
}

/** Sends one composed mail to one subscription and logs it (the digest path; events go through sendTo). */
async function sendMail(db, key, sink, event, mail, s, { providers, readSecret, publicUrl, now, fetch: send }) {
  const { tenant, team } = sink;
  const log = (status, extra = {}) => db.tenant(tenant, ({ q }) => q('insert into email_deliveries(tenant, team, subscription, event, kind, status, provider_id, error) values ($1, $2, $3, $4, $5, $6, $7, $8)',
    [tenant, team, s.id, event.id, mail.kind, status, extra.id ?? null, extra.error ?? null]));
  const provider = providers[sink.provider];
  const apiKey = provider && sink.secret ? await readSecret(db, key, tenant, sink.secret) : null;
  if (!provider || !apiKey) { await log('skipped', { error: provider ? `no provider key stored as ${sink.secret}` : `unknown provider ${sink.provider}` }); return 0; }
  const msg = render(key, mail, { base: publicUrl, tenant, team, teamName: s.team_name, subscription: s.id, now });
  try {
    const r = await provider.send({ apiKey, from: sink.sender, to: s.email, ...msg }, { fetch: send });
    await log('sent', { id: r?.id });
    return 1;
  } catch (e) {
    await log('failed', { error: String(e.message ?? e).slice(0, 200) });
    return 0;
  }
}

const hm = (m) => (m === null || m === undefined ? null : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
const mins = (v, field) => {
  if (v === null) return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(v ?? ''));
  if (!m) throw new Problem(400, `${field} is a local time like "22:00", or null`);
  return Number(m[1]) * 60 + Number(m[2]);
};
const prefsView = (p) => ({
  timezone: p?.timezone ?? 'UTC',
  quietHours: p?.quiet_start === null || p?.quiet_start === undefined ? null : { from: hm(p.quiet_start), to: hm(p.quiet_end) },
  digest: p?.digest_at === null || p?.digest_at === undefined ? null : { at: hm(p.digest_at), kinds: p.digest_kinds ?? [] },
  breakthrough: Object.entries(KINDS).filter(([, k]) => k.breakthrough).map(([id]) => id),
});

/** GET/PUT /v1/me/notifications and the team delivery log. */
export function createNotifications({ db }) {
  return {
    async get(tenant, principal) {
      const [p] = await db.tenant(tenant, ({ q }) => q('select * from notification_prefs where tenant = $1 and principal = $2', [tenant, principal]));
      return prefsView(p);
    },

    /** Replaces the fields sent; a field left out keeps its value. */
    async put(tenant, principal, body = {}) {
      const [old] = await db.tenant(tenant, ({ q }) => q('select * from notification_prefs where tenant = $1 and principal = $2', [tenant, principal]));
      const next = { timezone: old?.timezone ?? 'UTC', quiet_start: old?.quiet_start ?? null, quiet_end: old?.quiet_end ?? null, digest_at: old?.digest_at ?? null, digest_kinds: old?.digest_kinds ?? [] };
      if ('timezone' in body) {
        // Both the server (Intl) and the database (flushHeld's `at time zone`) must know it (review sev 4).
        const known = isZone(body.timezone) && (await db.tenant(tenant, ({ q }) => q('select 1 from pg_timezone_names where name = $1', [body.timezone]))).length > 0;
        if (!known) throw new Problem(400, 'timezone is an IANA zone like "America/Los_Angeles"');
        next.timezone = body.timezone;
      }
      if ('quietHours' in body) {
        const qh = body.quietHours;
        if (qh === null) Object.assign(next, { quiet_start: null, quiet_end: null });
        else {
          if (typeof qh !== 'object') throw new Problem(400, 'quietHours is { from, to } or null');
          Object.assign(next, { quiet_start: mins(qh.from, 'quietHours.from'), quiet_end: mins(qh.to, 'quietHours.to') });
          if (next.quiet_start === null || next.quiet_end === null || next.quiet_start === next.quiet_end) throw new Problem(400, 'quietHours needs two different times');
        }
      }
      if ('digest' in body) {
        const d = body.digest;
        if (d === null) Object.assign(next, { digest_at: null });
        else {
          if (typeof d !== 'object') throw new Problem(400, 'digest is { at, kinds } or null');
          next.digest_at = mins(d.at, 'digest.at');
          if (next.digest_at === null) throw new Problem(400, 'digest.at is a local time like "08:00"');
          if ('kinds' in d) {
            const kinds = d.kinds;
            if (!Array.isArray(kinds) || kinds.some((k) => !KINDS[k] || k === 'digest')) throw new Problem(400, `digest.kinds from ${Object.keys(KINDS).filter((k) => k !== 'digest').join(', ')}`);
            next.digest_kinds = [...new Set(kinds)];
          }
        }
      }
      const [p] = await db.tenant(tenant, ({ q }) => q(`insert into notification_prefs(tenant, principal, timezone, quiet_start, quiet_end, digest_at, digest_kinds) values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (tenant, principal) do update set timezone = $3, quiet_start = $4, quiet_end = $5, digest_at = $6, digest_kinds = $7, updated_at = now() returning *`,
      [tenant, principal, next.timezone, next.quiet_start, next.quiet_end, next.digest_at, next.digest_kinds]));
      return prefsView(p);
    },

    /**
     * The team's delivery log, newest first: email and Slack, one row per try. A member sees only their own rows; an
     * admin (or owner) sees everyone's with all, including Slack channel posts (nobody's own). `to` (masked) is only
     * on the caller's own rows.
     */
    async log(tenant, team, principal, { all = false, limit = 50, before = null } = {}) {
      const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
      const cursor = before === null || before === undefined || before === '' ? null : String(before);
      if (cursor !== null && !/^\d{1,30}$/.test(cursor)) throw new Problem(400, 'before is the `at` of the last row, in ms');
      return db.tenant(tenant, async ({ q }) => {
        const rows = await q(`select * from (
            select 'email' as channel, d.at, d.event, d.kind, case when d.held then 'held' else d.status end as status, d.error, s.principal, s.email as target,
                d.status = 'failed' and exists(select 1 from email_deliveries h where h.subscription = d.subscription and h.event = d.event and h.held)
                  and (select count(*) from email_deliveries f where f.subscription = d.subscription and f.event = d.event and f.status = 'failed') >= ${HELD_TRIES} as final
              from email_deliveries d join email_subscriptions s on s.id = d.subscription where d.team = $1
            union all
            select 'slack' as channel, d.at, d.event, d.kind, d.status, d.error, l.principal, coalesce(l.slack_user, d.target) as target, false as final
              from slack_deliveries d left join slack_links l on l.id = d.target where d.team = $1
          ) x where ($2::boolean or x.principal = $3) and ($4::bigint is null or x.at < to_timestamp($4::bigint / 1000.0))
          order by x.at desc limit $5`, [team, all, principal, cursor, n]);
        // L25 follow-up: on all=1 each row names its person (name, else login), from members of this tenant only.
        const ids = all ? [...new Set(rows.map((r) => r.principal).filter(Boolean))] : [];
        const names = new Map(ids.length ? (await db.system(`select distinct p.id, coalesce(nullif(p.name, ''), p.login) as name from people p
          join members m on m.person = p.id and m.tenant = $1 where p.id = any($2)`, [tenant, ids])).map((x) => [x.id, x.name]) : []);
        const items = rows.map((r) => ({ channel: r.channel, at: r.at, event: r.event, kind: r.kind, status: r.status, reason: reasonOf(r), why: r.error ?? null,
          // Only your own rows say where they went: an admin's all=1 never shows someone else's address, even masked.
          ...(r.principal === principal ? { to: r.channel === 'email' ? maskEmail(r.target) : r.target } : {}),
          ...(all ? { principal: r.principal, name: r.principal ? names.get(r.principal) ?? null : null } : {}) }));
        const last = rows.at(-1);
        return { items, next: rows.length === n && last ? String(new Date(last.at).getTime()) : null };
      });
    },
  };
}

/**
 * A stable code for why a row in the delivery log was not sent, so the page can show the CPO's sentence and never the
 * provider's raw text: `final` (failed, and no more tries: held mail gives up after its last try), `retry` (failed,
 * tried again later), `nochannel` (no key or token for the channel, or a token of the wrong kind), `removed` (Slack
 * said the channel or person is gone). `off` and `unconfirmed` are reserved: today nothing is sent to, or logged for,
 * a kind that is off or an address that is not confirmed. Null for sent, held and emailed rows.
 */
export function reasonOf(r) {
  if (r.status === 'failed') return r.final ? 'final' : 'retry';
  if (r.status !== 'skipped') return null;
  if (/^(no provider key|unknown provider|no Slack token)/.test(r.error ?? '') || /not a bot token/i.test(r.error ?? '')) return 'nochannel';
  if (r.channel !== 'slack') return 'nochannel';
  // A Slack failure no retry can fix: the channel or person is gone, or the message itself was refused.
  return /channel_not_found|not_in_channel|is_archived|user_not_found|user_disabled|cannot_dm_bot|messages_tab_disabled/.test(r.error ?? '') ? 'removed' : 'final';
}

export const maskEmail = (e) => {
  const [u, d] = String(e ?? '').split('@');
  return d ? `${u.slice(0, 1)}${'*'.repeat(Math.max(u.length - 1, 1))}@${d}` : '';
};
