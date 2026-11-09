// The Notifications page of a hosted Studio, /teams/{team}/notifications (CPO story "email notifications", D49 to
// D54, opt-in copy). It is a person's own page: their addresses for this team, the code that verifies each one, and
// which kinds they want. Nothing is emailed until an address is verified and at least one kind is saved (D49), so the
// first time the suggested kinds are shown ticked with a Save button, never saved on their own. Every email links back
// here through "Manage all emails" (kit #101).
//
// The API (apps/server, kit #101): GET/POST /v1/teams/{team}/emails, POST …/emails/{id}/verify { code },
// PATCH …/emails/{id} { kinds }, DELETE …/emails/{id}. The page only calls its own origin, with the session cookie.
import { call, dismissNotices, ensureSignedIn, esc, noticesBanner } from './auth.js';
import { t } from './i18n.js';

// ---- quiet hours and the daily digest (L25; GET/PUT /v1/me/notifications)

/** The time zones this browser knows, with `current` first among them if it is missing. */
export function zones(current) {
  let all = [];
  try { all = Intl.supportedValuesOf('timeZone'); } catch { /* an older browser: the current zone only */ }
  return [...new Set([current, ...all].filter(Boolean))];
}

/**
 * The Quiet hours and daily digest section. st: { prefs: { timezone, quietHours, digest, breakthrough }, kinds, device,
 * notes }. Kinds come from the emails API; digest is not a kind of the digest.
 */
export function prefsHtml(st) {
  const p = st.prefs;
  if (!p) return '';
  const n = st.notes.get('prefs');
  const qh = p.quietHours;
  const dg = p.digest;
  const kinds = st.kinds.filter((k) => k.id !== 'digest' && !(p.breakthrough ?? []).includes(k.id));
  const opts = zones(p.timezone).map((z) => `<option${z === p.timezone ? ' selected' : ''}>${esc(z)}</option>`).join('');
  return `<section class="n-section" id="prefs" aria-labelledby="prefs-title">
    <h2 id="prefs-title">${esc(t('notify.quiet.heading'))}</h2>
    <p class="muted">${esc(t('notify.quiet.explainer'))}</p>
    <form id="prefs-form" class="stack">
      <label>${esc(t('notify.tz'))} <select name="timezone">${opts}</select></label>
      ${st.device && st.device !== p.timezone ? `<p><button type="button" class="link" id="zone-device">${esc(t('notify.zone.device', { zone: st.device }))}</button></p>` : ''}
      <label class="switch"><input type="checkbox" name="quiet"${qh ? '' : ' checked'}> ${esc(t('notify.quiet.none'))}</label>
      <div class="row"${qh ? '' : ' hidden'} id="quiet-times"><label>${esc(t('notify.quiet.from'))} <input type="time" name="from" value="${esc(qh?.from ?? '21:00')}"></label><label>${esc(t('notify.quiet.to'))} <input type="time" name="to" value="${esc(qh?.to ?? '07:00')}"></label></div>
      <p class="hint"><span title="${esc(t('notify.tip.breakthrough'))}">${esc(t('notify.breakthrough'))}</span></p>
      <label class="switch"><input type="checkbox" name="digest"${dg ? '' : ' checked'}> ${esc(t('notify.digest.off'))}</label>
      <div class="stack"${dg ? '' : ' hidden'} id="digest-opts">
        <label>${esc(t('notify.digest.at'))} <input type="time" name="at" value="${esc(dg?.at ?? '08:00')}"></label>
        <fieldset><legend>${esc(t('notify.digest.what'))}</legend><ul class="plain">${kinds.map((k) => `<li><label class="switch"><input type="checkbox" name="dkind" value="${esc(k.id)}"${dg?.kinds?.includes(k.id) ? ' checked' : ''}> ${esc(kindLabel(k.id, k.label))}</label></li>`).join('')}</ul></fieldset>
      </div>
      ${n ? `<p class="result ${n.kind === 'error' ? 'error' : 'ok'}" role="${n.kind === 'error' ? 'alert' : 'status'}" tabindex="-1">${esc(n.text)}</p>` : ''}
      <div class="row"><button type="submit" class="primary">${esc(t('notify.save'))}</button></div>
    </form>
  </section>`;
}

/** A kind in the CPO's words (notify.kind.*), else the server's label. */
export function kindLabel(id, fallback = id) {
  const k = `notify.kind.${id}`;
  return t(k) === k ? fallback ?? '' : t(k);
}

/** The PUT body from the form: every field, so what is shown is what is saved. */
export function prefsBody(form) {
  // The switches read "No quiet hours" and "No daily digest": ticked means off.
  const quiet = !form.quiet.checked;
  const digest = !form.digest.checked;
  return {
    timezone: form.timezone.value,
    quietHours: quiet ? { from: form.from.value, to: form.to.value } : null,
    digest: digest ? { at: form.at.value, kinds: [...form.querySelectorAll('input[name="dkind"]:checked')].map((i) => i.value) } : null,
  };
}

// ---- the delivery log (L25; GET /v1/teams/{team}/notifications/log, PRD O6)

/** A row's time, in this browser's zone: today as HH:MM, otherwise with the day. */
export function when(at, now = new Date()) {
  const d = new Date(at);
  if (Number.isNaN(+d)) return '';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

/** The Delivery log section. st: { log: { items, next, all, error }, owner, kinds }. */
export function logHtml(st) {
  const lg = st.log;
  if (!lg) return '';
  const label = (id) => kindLabel(id, st.kinds.find((k) => k.id === id)?.label ?? id);
  const word = (key, fb) => (t(key) === key ? fb : t(key));
  // Why is always a plain sentence (CPO): held and emailed have one; a provider's own error is never shown.
  const why = (s) => word(`notify.status.${s}.why`, '');
  const who = lg.all;
  const head = [t('notify.log.when'), t('notify.log.what'), t('notify.log.where'), ...(who ? [t('notify.log.who')] : []), t('notify.log.status'), t('notify.log.why')];
  const rows = (lg.items ?? []).map((r) => `<tr class="st-${esc(r.status)}"><td>${esc(when(r.at))}</td><td>${esc(label(r.kind))}</td><td>${esc(t(`notify.channel.${r.channel}`))}${r.to ? ` <span class="muted">${esc(r.to)}</span>` : ''}</td>${who ? `<td>${esc(r.principal ?? '')}</td>` : ''}<td${why(r.status) ? ` title="${esc(why(r.status))}"` : ''}>${esc(word(`notify.status.${r.status}`, r.status))}</td><td>${esc(why(r.status))}</td></tr>`).join('');
  return `<section class="n-section" id="log" aria-labelledby="log-title">
    <h2 id="log-title">${esc(t('notify.log.heading'))}</h2>
    <p class="muted">${esc(t('notify.log.explainer'))}</p>
    ${st.owner ? `<div class="row" role="group" aria-labelledby="log-scope"><span id="log-scope">${esc(t('notify.scope.label'))}</span><button type="button" data-log-all="" aria-pressed="${!who}">${esc(t('notify.scope.me'))}</button><button type="button" data-log-all="1" aria-pressed="${!!who}">${esc(t('notify.scope.all'))}</button></div>` : ''}
    ${lg.error ? `<p class="result error" role="alert">${esc(lg.error)}</p>` : ''}
    ${rows ? `<div class="table-wrap" tabindex="0" aria-labelledby="log-title"><table class="log"><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>` : lg.error ? '' : `<p class="muted">${esc(t('notify.log.empty'))}</p>`}
    ${lg.next ? `<button type="button" id="log-older">${esc(t('notify.older'))}</button>` : ''}
  </section>`;
}

/** The team in /teams/{team}/notifications, or null. */
export function teamFromPath(pathname) {
  const m = /^\/teams\/([^/]+)\/notifications\/?$/.exec(pathname ?? '');
  if (!m) return null;
  try { const t = decodeURIComponent(m[1]); return /^[a-z0-9][a-z0-9_-]{0,62}$/i.test(t) ? t : null; } catch { return null; }
}

/** Words under a kind's switch (copy): only approvals carry one. */
const UNDER = {
  approval: 'The email links to the Studio. You always approve there, never by replying.',
  ready: 'When something the team built is ready for you to look at.',
};

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
      <p>We sent a code to <strong>${esc(s.email)}</strong>. It expires in 15 minutes.</p>
      <p class="row"><label>Code <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required size="8"></label>
      <button type="submit" class="primary">Verify</button></p>
      <p class="row"><button type="button" class="link" data-resend="${esc(s.id)}">Send a new code</button> <button type="button" class="link" data-remove="${esc(s.id)}">Use another address</button></p>
      ${note(s.id)}
    </form>`;
  const add = !st.emails.length || st.adding
    ? `<form id="email-add" class="n-address"><p class="row"><label>Your email address <input type="email" name="email" required autocomplete="email" maxlength="254"></label>
        <button type="submit" class="primary">Send a code</button></p>${note('add')}</form>`
    : `<p><button type="button" id="email-another">Add another address</button></p>${note('add')}`;
  // No email provider connected yet (CPO, #130): no code form at all, only who can set it up.
  const notReady = st.ready === false
    ? `<p class="notice" role="status">Emails aren't set up for this team yet. ${st.owner ? 'An owner connects an email provider in Systems.' : 'Ask an owner to connect one.'}</p>
       <p class="row"><label>Your email address <input type="email" disabled></label> <button type="button" class="primary" disabled>Send a code</button></p>`
    : null;
  return `<section class="n-section" aria-labelledby="emails-title">
    <h2 id="emails-title">Emails</h2>
    <p>Get an email when something needs you. Nothing is sent until you verify your address and choose what you want.</p>
    ${notReady ?? `${st.emails.map((s) => (s.verified ? verified(s) : pending(s))).join('')}
    ${add}`}
  </section>`;
}

// ------------------------------------------------------------------------------------------------ Slack

/** Words under a kind's Slack DM switch (copy, CPO Slack story). */
const READY_HINT = 'When something the team built is ready for you to look at.';
const UNDER_SLACK = { approval: 'The message links to the Studio. You always approve there, never in Slack.', ready: READY_HINT };
/** The kinds a new channel starts with: what the server says (budget and minutes; approval and BLOCKED off, D58). */
export const channelDefaults = (kinds) => new Set(kinds.filter((k) => k.channelDefault).map((k) => k.id));
/** Where Connect Slack may send the browser: Slack's own sign-in, over https, nowhere else. */
export const slackSignInUrl = (raw) => { try { const u = new URL(raw); return u.protocol === 'https:' && (u.hostname === 'slack.com' || u.hostname.endsWith('.slack.com')) ? u.href : null; } catch { return null; } };
/** The health line (O1). */
export function slackHealth(h, fmt = (iso) => new Date(iso).toLocaleString()) {
  if (!h) return '';
  if (h.status === 'failing') return `Slack · failing since ${fmt(h.since)}, sending by email instead`;
  return `Slack · ${h.status}`;
}

/**
 * The Slack section. st: { slack: GET …/slack, channels: [..] or null (not an admin), owner, teamName, notes,
 * slackCleared (the DM switches were all turned off this visit), addingChannel }.
 */
export function slackHtml(st) {
  const note = (key) => { const n = st.notes.get(key); return n ? `<p class="result ${n.kind === 'error' ? 'error' : 'ok'}" role="${n.kind === 'error' ? 'alert' : 'status'}">${esc(n.text)}</p>` : ''; };
  const s = st.slack;
  const head = '<h2 id="slack-title">Slack</h2>';
  if (!s) return '';
  if (!s.connected || !s.ready) {
    const why = !s.connected
      ? (st.owner ? '<p>Connect your Slack workspace so the team can message you there.</p>' : "<p class=\"notice\" role=\"status\">Slack isn't connected for this team yet. Ask an owner to add it.</p>")
      : `<p class="notice" role="status">${esc(slackHealth(s.health))}. ${st.owner ? 'Store its bot token to finish.' : 'Ask an owner to finish setting it up.'}</p>`;
    // There is no one-click install yet: the workspace is a connector an owner adds once (D56). The steps, in place.
    const steps = st.owner ? `<details class="n-steps"><summary class="button primary">Add to Slack</summary>
        <ol>
          <li>Make a Slack app for your workspace. Bot scope: <code>chat:write</code> only. Turn on Sign in with Slack (scopes <code>openid</code> and <code>profile</code>) with this redirect URL: <code class="n-redirect">${esc(st.redirectUrl ?? '')}</code></li>
          <li>Install it in the workspace, and store its bot token and client secret as secrets of this workspace (names starting <code>SLACK_</code>).</li>
          <li>Add a Slack connection for this team with the bot token's secret, the app's client id, and the client secret's name.</li>
        </ol>
        <p class="hint">Nothing in Slack can approve or decide anything; the app asks for no interactive scopes.</p></details>` : '';
    return `<section class="n-section" aria-labelledby="slack-title">${head}${why}${steps}</section>`;
  }
  const health = `<p class="hint n-health${s.health?.status === 'failing' ? ' error' : ''}">${esc(slackHealth(s.health))}</p>`;
  const kindRows = (attrs, on, under = {}) => s.kinds.map((k) => `<li><label class="switch"><input type="checkbox" ${attrs} data-kind="${esc(k.id)}"${on.has(k.id) ? ' checked' : ''}> ${esc(k.label)}</label>${under[k.id] ? `<p class="hint">${esc(under[k.id])}</p>` : ''}</li>`).join('');
  let me;
  if (!s.me?.linked) {
    me = `<div class="n-address"><p>Get messages as a Slack DM.</p>
      <p><button type="button" class="primary" id="slack-connect"${s.canLink ? '' : ' disabled'}>Connect Slack</button></p>
      ${s.canLink ? '' : `<p class="hint">${st.owner ? 'This Slack connection has no sign-in client yet: add the app\'s client id and secret to it.' : 'Connect Slack is not set up yet. Ask an owner.'}</p>`}
      ${note('slack')}</div>`;
  } else {
    const first = !s.me.kinds?.length && !st.slackCleared;
    const on = first ? new Set(s.kinds.filter((k) => k.suggested).map((k) => k.id)) : new Set(s.me.kinds);
    me = `<div class="n-address n-slack-me">
      <p class="row"><strong>Connected as @${esc(s.me.name || 'you')}.</strong> <button type="button" class="link" id="slack-disconnect">Disconnect Slack</button></p>
      <p>Get messages as a Slack DM:</p>
      <ul class="plain n-kinds">${kindRows('data-slack-me', on, UNDER_SLACK)}</ul>
      ${first ? '<p class="hint">Nothing is sent to you in Slack yet. These are suggested to start with; change them, then save.</p><p><button type="button" class="primary" id="slack-save">Save</button></p>' : ''}
      ${note('slack')}</div>`;
  }
  let channels = '';
  if (Array.isArray(st.channels)) {
    const rows = st.channels.map((c) => `<div class="n-address n-channel" data-channel="${esc(c.id)}">
        <p class="row"><strong>#${esc(c.name)}</strong> <span class="hint">added by ${esc(c.addedBy || 'an admin')}</span> <button type="button" class="link" data-channel-remove="${esc(c.id)}">Stop posting here</button></p>
        <ul class="plain n-kinds">${kindRows(`data-channel-kind="${esc(c.id)}"`, new Set(c.kinds), { ready: READY_HINT })}</ul>
        ${note(`ch:${c.id}`)}</div>`).join('');
    const add = st.addingChannel
      ? `<form id="channel-add" class="n-address">
          <p class="row"><label>Channel name <input name="name" required maxlength="80" placeholder="team-updates" autocomplete="off"></label>
          <label>Channel ID <input name="channel" required pattern="[CGcg][A-Za-z0-9]{2,20}" placeholder="C0123ABCD" autocomplete="off"></label></p>
          <p class="hint">In Slack, open the channel's details: the ID is at the bottom. Invite the team's Slack app to the channel first (type /invite @ and the app's name in the channel).</p>
          <ul class="plain n-kinds">${kindRows('data-new-channel', st.channelDraft ? new Set(st.channelDraft.kinds) : channelDefaults(s.kinds), { ready: READY_HINT })}</ul>
          <p class="row"><button type="submit" class="primary">Add the channel</button> <button type="button" id="channel-cancel">Cancel</button></p>
          ${note('channel-add')}</form>`
      : `<p><button type="button" id="channel-new">Add a channel</button></p>${note('channel-add')}`;
    channels = `<h3>Team channels</h3>
      <p>Post updates to a channel everyone on it can read. Channels get less detail than DMs.</p>
      ${rows}${add}`;
  }
  return `<section class="n-section" aria-labelledby="slack-title">${head}${health}${me}${channels}</section>`;
}

/**
 * A channel name as Slack writes it: no #, lowercase, spaces as dashes. Null when it still is not one Slack allows
 * (letters, digits, dots, dashes and underscores, up to 80, starting with a letter or digit).
 */
export function channelName(raw) {
  const name = String(raw ?? '').trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-');
  return /^[a-z0-9][a-z0-9._-]{0,79}$/.test(name) ? name : null;
}

/** Why a channel could not be added, in words a person can act on. */
export function channelError(status, error) {
  if (status === 409 && /already/.test(error ?? '')) return 'That channel is already added. Change its switches below instead.';
  if (status === 400) return 'Check the channel ID: it starts with C or G, like C0123ABCD.';
  if (status === 403) return 'Only an owner or admin can add a channel.';
  return sentence(error) || `The channel could not be added (HTTP ${status}).`;
}

/** Server text as a sentence: a capital first letter and a full stop. */
export const sentence = (t) => { const s = String(t ?? '').trim(); return s ? `${s[0].toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? '' : '.'}` : ''; };

const errorOf = (r) => r.data?.error ?? r.data?.title ?? `HTTP ${r.status}`;

function start() {
  const root = document.getElementById('notifications');
  const team = teamFromPath(location.pathname);
  const st = { me: null, teamName: team, ready: true, owner: false, kinds: [], emails: [], adding: false, cleared: new Set(), notes: new Map(),
    slack: null, channels: null, slackCleared: false, addingChannel: false, channelDraft: null, redirectUrl: `${location.origin}/slack/callback`,
    prefs: null, device: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } })(), log: null };
  const base = () => `/v1/teams/${encodeURIComponent(team)}/emails`;
  const slackBase = () => `/v1/teams/${encodeURIComponent(team)}/slack`;

  function render() {
    root.innerHTML = `${noticesBanner(st.me)}
      <p class="muted">For ${esc(st.teamName)}. Only you see these settings.</p>
      ${emailsHtml(st)}
      ${prefsHtml(st)}
      ${slackHtml(st)}
      ${logHtml(st)}`;
    // What was typed in Add a channel survives a re-render (an error), set through the DOM, not markup.
    const add = root.querySelector('#channel-add');
    if (add && st.channelDraft) { add.name.value = st.channelDraft.name; add.channel.value = st.channelDraft.channel; }
  }
  /** The Slack section's state: the status, and the channels when the caller is an owner or admin (403 otherwise). */
  async function loadSlack() {
    const r = await call('GET', slackBase());
    st.slack = r.ok ? r.data : null;
    if (st.slack?.connected && st.owner) {
      const c = await call('GET', `${slackBase()}/channels`);
      st.channels = c.ok ? c.data.channels ?? [] : null;
    } else st.channels = null;
  }
  async function load() {
    const r = await call('GET', base());
    if (!r.ok) throw new Error(r.status === 404 ? `There is no team called ${team} here, or you are not on it.` : errorOf(r));
    st.kinds = r.data.kinds ?? [];
    st.teamName = r.data.teamName || team;
    st.ready = r.data.ready !== false;
    st.emails = r.data.emails ?? [];
    await loadSlack();
    await Promise.all([loadPrefs(), loadLog(false)]);
    render();
  }
  async function loadPrefs() {
    const r = await call('GET', '/v1/me/notifications');
    st.prefs = r.ok ? r.data : null;
  }
  /** The log from the top (more = false) or its next page; all keeps the admin's choice. */
  async function loadLog(more, all = st.log?.all ?? false) {
    const q = new URLSearchParams();
    if (all) q.set('all', '1');
    if (more && st.log?.next) q.set('before', st.log.next);
    const r = await call('GET', `/v1/teams/${encodeURIComponent(team)}/notifications/log${q.size ? `?${q}` : ''}`);
    if (!r.ok) { st.log = { items: more ? st.log?.items ?? [] : [], next: null, all, error: errorOf(r) }; return; }
    st.log = { items: [...(more ? st.log?.items ?? [] : []), ...(r.data.items ?? [])], next: r.data.next ?? null, all, error: null };
  }
  const say = (key, kind, text) => { st.notes.clear(); if (text) st.notes.set(key, { kind, text }); };
  /** After a code was asked for: sent, or why not (no email sink yet, or no provider key). */
  const sent = (r) => (r.data.sent === false && r.data.reason && !r.data.verified ? ['error', `The code could not be sent: ${r.data.reason}.`] : ['ok', '']);

  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    if (form.id === 'prefs-form') {
      const r = await call('PUT', '/v1/me/notifications', prefsBody(form));
      button.disabled = false;
      if (!r.ok) { say('prefs', 'error', t('notify.failed')); return render(); }
      st.prefs = r.data;
      say('prefs', 'ok', t('notify.saved'));
      render();
      return root.querySelector('#prefs .result')?.focus?.();
    }
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
    if (form.id === 'channel-add') {
      const kinds = [...form.querySelectorAll('input[data-new-channel]:checked')].map((i) => i.dataset.kind);
      st.channelDraft = { name: form.name.value, channel: form.channel.value, kinds };
      const name = channelName(form.name.value);
      const stop = (text) => { button.disabled = false; say('channel-add', 'error', text); render(); root.querySelector('#channel-add input[name="name"]')?.focus(); };
      if (!name) return stop('A channel name can have lowercase letters, numbers, dashes, dots and underscores, up to 80. Copy it from Slack, without the #.');
      if (!kinds.length) return stop('Choose at least one thing to post to this channel.');
      const r = await call('POST', `${slackBase()}/channels`, { channel: form.channel.value.trim().toUpperCase(), name, kinds });
      button.disabled = false;
      if (!r.ok) return stop(channelError(r.status, r.data?.error ?? r.data?.title));
      st.addingChannel = false;
      st.channelDraft = null;
      await loadSlack();
      say(`ch:${r.data.id}`, r.data.posted ? 'ok' : 'error', r.data.posted ? `Added. A first post in #${r.data.name} says who chose it.` : `Added, but the first post did not go through: ${r.data.reason}. Invite the Slack app to the channel.`);
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
    if (b.id === 'zone-device') { const sel = root.querySelector('#prefs-form select[name="timezone"]'); if (sel) { if (![...sel.options].some((o) => o.value === st.device)) sel.add(new Option(st.device)); sel.value = st.device; } return; }
    if (b.dataset.logAll !== undefined) { await loadLog(false, b.dataset.logAll === '1'); render(); return root.querySelector(`[data-log-all="${b.dataset.logAll}"]`)?.focus(); }
    if (b.id === 'log-older') { const n = st.log.items.length; await loadLog(true); render(); return root.querySelectorAll('#log tbody tr')[n]?.querySelector('td')?.setAttribute('tabindex', '-1'), root.querySelectorAll('#log tbody tr')[n]?.querySelector('td')?.focus(); }
    if (b.id === 'email-another') { st.adding = true; say('add', 'ok', ''); render(); return root.querySelector('#email-add input')?.focus(); }
    if (b.dataset.remove) {
      const s = st.emails.find((x) => x.id === b.dataset.remove);
      if (s?.verified && !confirm(`Stop all emails to ${s.email} from ${st.teamName}?`)) return;
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
    if (b.id === 'slack-connect') {
      b.disabled = true;
      const r = await call('POST', `${slackBase()}/connect`, {});
      const to = r.ok ? slackSignInUrl(r.data.url) : null;
      if (!to) { b.disabled = false; say('slack', 'error', r.ok ? 'Slack sent back an address this page will not open.' : errorOf(r)); return render(); }
      // The callback page finishes the link for this team (D56); Slack hands back only a code and the state.
      try { sessionStorage.setItem('agent-team-slack-team', team); } catch { /* the callback asks to start again */ }
      return location.assign(to);
    }
    if (b.id === 'slack-save') return saveSlack('Saved. You will get these Slack messages.');
    if (b.id === 'slack-disconnect') {
      if (!confirm(`Stop all Slack DMs from ${st.teamName}? Channel posts an admin chose keep going.`)) return;
      const r = await call('DELETE', `${slackBase()}/me`);
      if (!r.ok && r.status !== 404) { say('slack', 'error', errorOf(r)); return render(); }
      st.slackCleared = false;
      await loadSlack();
      say('slack', 'ok', 'Disconnected. No more Slack DMs from this team.');
      return render();
    }
    if (b.id === 'channel-new') { st.addingChannel = true; st.channelDraft = null; say('channel-add', 'ok', ''); render(); return root.querySelector('#channel-add input')?.focus(); }
    if (b.id === 'channel-cancel') { st.addingChannel = false; st.channelDraft = null; return render(); }
    if (b.dataset.channelRemove) {
      const c = st.channels?.find((x) => x.id === b.dataset.channelRemove);
      if (!confirm(`Stop posting ${st.teamName} updates to #${c?.name ?? 'this channel'}?`)) return;
      const r = await call('DELETE', `${slackBase()}/channels/${encodeURIComponent(b.dataset.channelRemove)}`);
      if (!r.ok && r.status !== 404) { say(`ch:${b.dataset.channelRemove}`, 'error', errorOf(r)); return render(); }
      await loadSlack();
      say('channel-add', 'ok', `Stopped posting to #${c?.name ?? 'the channel'}.`);
      return render();
    }
  });

  /** Add a channel's typed values and switches, so another section's re-render does not wipe them. */
  function keepDraft() {
    const f = root.querySelector('#channel-add');
    if (f) st.channelDraft = { name: f.name.value, channel: f.channel.value, kinds: [...f.querySelectorAll('input[data-new-channel]:checked')].map((i) => i.dataset.kind) };
  }
  root.addEventListener('input', (e) => { if (e.target.closest('#channel-add')) keepDraft(); });

  root.addEventListener('change', async (e) => {
    // Quiet hours and the digest: their times show only when they are on (saved with Save).
    if (e.target.name === 'quiet') { root.querySelector('#quiet-times').hidden = e.target.checked; return; }
    if (e.target.name === 'digest') { root.querySelector('#digest-opts').hidden = e.target.checked; return; }
    const box = e.target.closest('input[data-kind]');
    if (!box) return;
    if (box.hasAttribute('data-new-channel')) return keepDraft(); // saved with Add the channel
    if (box.hasAttribute('data-slack-me')) {
      // As for email: the first time, ticks wait for Save; after that each switch saves at once.
      if (st.slack?.me?.kinds?.length || st.slackCleared) saveSlack('Saved.');
      return;
    }
    if (box.dataset.channelKind) {
      const id = box.dataset.channelKind;
      const kinds = [...root.querySelectorAll(`input[data-channel-kind="${CSS.escape(id)}"]:checked`)].map((i) => i.dataset.kind);
      const r = await call('PATCH', `${slackBase()}/channels/${encodeURIComponent(id)}`, { kinds });
      if (!r.ok) { say(`ch:${id}`, 'error', errorOf(r)); return render(); }
      const i = st.channels.findIndex((c) => c.id === id);
      if (i >= 0) st.channels[i] = r.data;
      say(`ch:${id}`, 'ok', kinds.length ? 'Saved.' : 'Saved. Nothing is posted to this channel now.');
      return render();
    }
    const s = st.emails.find((x) => x.id === box.dataset.sub);
    // The first time, ticks wait for Save (D49); after that each switch saves at once.
    if (s?.kinds?.length || st.cleared.has(s?.id)) save(s.id, 'Saved.');
  });

  /** PATCHes the caller's Slack DM kinds. Unticking every kind is allowed: Slack stays connected. */
  async function saveSlack(done) {
    const kinds = [...root.querySelectorAll('input[data-slack-me]:checked')].map((i) => i.dataset.kind);
    const r = await call('PATCH', `${slackBase()}/me`, { kinds });
    if (!r.ok) { say('slack', 'error', errorOf(r)); return render(); }
    st.slack.me = { ...st.slack.me, ...r.data };
    st.slackCleared = !kinds.length;
    say('slack', 'ok', kinds.length ? done : 'Saved. Nothing is sent to you in Slack now; it stays connected.');
    render();
  }

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
    st.owner = (st.me.workspaces ?? []).some((w) => w.role === 'owner' || w.role === 'admin');
    await load();
    // Back from /slack/callback: what happened there.
    let back = null;
    try { back = JSON.parse(sessionStorage.getItem('agent-team-slack-done') ?? 'null'); sessionStorage.removeItem('agent-team-slack-done'); } catch { /* none */ }
    if (back?.team === team && back.text) { say('slack', 'ok', back.text); render(); }
  })().catch((e) => { root.innerHTML = `<p class="result error" role="alert">${esc(e.message)}</p>`; });
}

if (globalThis.document?.getElementById('notifications')) start();
