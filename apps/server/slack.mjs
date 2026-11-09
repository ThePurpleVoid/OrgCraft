// Slack notifications (PRD 6.8 O1 and O4, CPO story "Slack notifications", D55 to D60). The same pattern as email:
//
// - The provider sits behind one small interface (post, workspace, identify, authorizeUrl). It is only ever called
//   with a token read from the vault by name; no token stored, no call. Tests pass a fake.
// - Two destinations (D55). DMs go to people who linked their own Slack account by signing in to Slack (identity
//   only, D56) and switched kinds on. Channel posts go to channels an owner or admin picked, per kind; approval and
//   BLOCKED start off for channels.
// - Nothing is decided in Slack (D57). Every message has one link button into the Studio and nothing else: the app
//   asks for no interactivity, and an approval still needs sign-in and step-up in the Studio.
// - Channels see less (D58): no recommendation, no meeting decisions. Same limits as email (D59): links expire,
//   outside text quoted and cut to 120 characters, role titles not slugs.
// - Turning off is one step (D60): the DM's context line links the same ask-first page as email.
// - When Slack fails, a DM goes by email to the person's verified addresses instead (criterion 7), and the health
//   line says Slack is failing.
import { randomBytes } from 'node:crypto';
import { KINDS, LINK_TTL, SUGGESTED, emailFallback, kindOfEvent, money, outside, readToken, roleTitle, stillIn, token } from './email.mjs';
import { Problem, getTeam, id as newId } from './store.mjs';

/** Approval and BLOCKED name what the team is deciding, so a channel starts without them (D55). */
export const CHANNEL_DEFAULT_KINDS = ['budget80', 'budget100', 'minutes'];
const STATE_TTL = 10 * 60_000;
/** Only a bot token posts: a person's own token (xoxp-) would post as that person (security review of #110). */
const BOT = /^xoxb-/;
const notBot = (name) => `the token stored as ${name} is not a bot token (xoxb-…)`;
/** Slack errors that a retry cannot fix: the post is logged as failed and the sink moves on. */
const PERMANENT = new Set(['channel_not_found', 'not_in_channel', 'is_archived', 'user_not_found', 'cannot_dm_bot', 'user_disabled', 'messages_tab_disabled', 'restricted_action', 'invalid_blocks', 'msg_too_long']);

export class SlackError extends Error {
  constructor(code, status = 200) { super(`Slack: ${code}`); this.code = code; this.status = status; }
  get permanent() { return PERMANENT.has(this.code); }
}

// ---- the provider -----------------------------------------------------------------------------------------------

async function call(send, method, { token: bearer, json, form, timeoutMs = 15_000 }) {
  const res = await send(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), 'content-type': json ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded' },
    body: json ? JSON.stringify(json) : new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status >= 300) throw new SlackError(res.status === 429 ? 'ratelimited' : `HTTP ${res.status}`, res.status);
  if (!body?.ok) throw new SlackError(String(body?.error ?? 'unknown_error').slice(0, 80));
  return body;
}

/**
 * Slack's Web API. Bot scope: chat:write only. Person sign-in: Sign in with Slack (OpenID Connect, scopes openid and
 * profile), so linking proves who someone is in Slack and grants nothing else.
 */
export const PROVIDERS = {
  slack: {
    title: 'Slack',
    /** Posts one message (chat.postMessage). `channel` is a channel id, or a user id for a DM from the app. */
    async post({ token: bot, channel, text, blocks }, { fetch: send = fetch } = {}) {
      const r = await call(send, 'chat.postMessage', { token: bot, json: { channel, text, blocks, unfurl_links: false, unfurl_media: false } });
      return { id: String(r.ts ?? '') };
    },
    /** The workspace a bot token belongs to (auth.test). */
    async workspace({ token: bot }, { fetch: send = fetch } = {}) {
      const r = await call(send, 'auth.test', { token: bot, form: {} });
      return { workspace: String(r.team_id ?? ''), name: String(r.team ?? '') };
    },
    /** Who signed in: exchanges the code (openid.connect.token), then reads the identity (openid.connect.userInfo). */
    async identify({ clientId, clientSecret, code, redirectUri }, { fetch: send = fetch } = {}) {
      const t = await call(send, 'openid.connect.token', { form: { client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri } });
      const u = await call(send, 'openid.connect.userInfo', { token: t.access_token, form: {} });
      return { user: String(u['https://slack.com/user_id'] ?? ''), workspace: String(u['https://slack.com/team_id'] ?? ''), name: String(u.name ?? u.given_name ?? '') };
    },
    authorizeUrl({ clientId, state, redirectUri, nonce }) {
      const u = new URL('https://slack.com/openid/connect/authorize');
      for (const [k, v] of Object.entries({ response_type: 'code', scope: 'openid profile', client_id: clientId, state, redirect_uri: redirectUri, nonce })) u.searchParams.set(k, v);
      return u.toString();
    },
  },
};

// ---- the messages (the CPO's copy) ------------------------------------------------------------------------------

/** Slack's mrkdwn treats &, < and > as markup (links, mentions such as <!channel>): outside text never pings anyone. */
export const mrk = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nextUtcMidnight = (iso) => { const d = new Date(iso ?? Date.now()); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)); };
const hhmm = (d) => `${d.toISOString().slice(11, 16)} UTC`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The message for one event, for a DM or a channel: { kind, fallback, lines, button: { label, path } }, or null when
 * the event has no message. Lines are mrkdwn, already escaped. Pure, so tests can render every kind both ways.
 */
export function composeSlack(event, { teamName, where = 'dm', titles = {} } = {}) {
  const kind = kindOfEvent(event?.type);
  if (!kind) return null;
  const dm = where === 'dm';
  const d = event.data ?? {};
  const team = teamName || event.team;
  const role = roleTitle(event.actor?.kind === 'role' ? event.actor.id : (d.role ?? event.actor?.id), titles);
  const at = encodeURIComponent(event.team);
  const rec = dm && d.recommendation ? `Recommendation: ${mrk(outside(d.recommendation))}` : null;
  const out = (fallback, lines, label, path) => ({ kind, where: dm ? 'dm' : 'channel', fallback, lines: lines.filter(Boolean), button: { label, path } });
  if (kind === 'approval') {
    const summary = mrk(outside(d.summary ?? d.why ?? d.action ?? 'an action'));
    return out(dm ? `${team}: ${role} needs your approval` : `${team}: ${role} is waiting for an approval`, dm
      ? [`*${mrk(role)} needs your approval before it can go on.*`, `"${summary}"`, rec, "Nothing happens until you approve in the Studio. You can't approve from Slack."]
      : [`*${mrk(role)} is waiting for an approval.*`, `"${summary}"`, 'An owner approves in the Studio.'],
    'Review in the Studio', `/teams/${at}/inbox${d.cardId ? `?card=${encodeURIComponent(d.cardId)}` : ''}`);
  }
  if (kind === 'budget80') {
    return out(`${team}: 80% of today's budget used`, [`*${money(d.spent, d.currency)} of ${money(d.cap, d.currency)} used today.*`, 'Work carries on. At 100% only release-blocking fixes and checks keep running.'],
      "See today's usage", `/teams/${at}/budget`);
  }
  if (kind === 'budget100') {
    return out(`${team}: daily budget reached, new work paused`, [`*Daily budget of ${money(d.cap, d.currency)} reached. New work is paused until ${hhmm(nextUtcMidnight(event.time))}.*`, 'An owner can raise the cap in the Studio to resume sooner.'],
      'See usage and the cap', `/teams/${at}/budget`);
  }
  if (kind === 'blocked') {
    const question = mrk(outside(d.question ?? d.detail ?? d.task ?? 'a decision'));
    return out(`${team}: ${role} is waiting on a decision`, dm
      ? [`*${mrk(role)} is blocked on:* "${question}"`, rec, 'It keeps working on the recommendation unless the step cannot be undone.']
      : [`*${mrk(role)} is waiting on a decision from the owner.*`, `"${question}"`],
    'Answer in the Studio', `/teams/${at}/board?role=${encodeURIComponent(event.actor?.id ?? '')}`);
  }
  if (kind === 'ready') {
    // The CPO's copy, "Copy: Ready to try notification" in docs/team/lanes/cpo.md: the same in a DM and a channel.
    const feature = outside(d.title ?? 'A change');
    return out(`${team}: ${feature} is ready to try`, [`*"${mrk(feature)}" is ready to try.*`, "It's done and passed its checks."],
      d.preview ? 'See the preview in the Studio' : 'Try it in the Studio', `/teams/${at}/inbox${d.cardId ? `?card=${encodeURIComponent(d.cardId)}` : ''}`);
  }
  // minutes
  const decisions = Array.isArray(d.decisions) ? d.decisions : [], actions = Array.isArray(d.actions) ? d.actions : [];
  const date = String(d.date ?? event.time ?? '').slice(0, 10);
  const meeting = outside(d.meeting ?? 'Meeting', 40);
  const needs = Number(d.needsYou ?? 0);
  return out(`${team}: minutes from ${meeting}`, [`*Minutes: ${mrk(meeting)} (${date})*`, `${plural(decisions.length, 'decision', 'decisions')} and ${plural(actions.length, 'action item', 'action items')}.`,
    ...(dm ? [decisions.length ? `"${mrk(outside(decisions[0]?.text ?? decisions[0]))}"` : 'No decisions this time.', needs > 0 ? `${needs} ${needs === 1 ? 'item needs' : 'items need'} you.` : null] : [])],
  'Read the minutes', `/teams/${at}/meetings${d.meetingId ? `/${encodeURIComponent(d.meetingId)}` : ''}`);
}

/**
 * The chat.postMessage body for one composed message: { text, blocks } with a section (at most four lines), one
 * link button and the context line. A DM's context line turns that kind off (`link` is the person's slack_links id);
 * a channel's names who chose it.
 */
export function renderSlack(key, msg, { base, tenant, team, teamName, link = null, channelName = '', adminName = '', now = new Date() }) {
  const root = String(base ?? '').replace(/\/+$/, '');
  const ttl = LINK_TTL[msg.kind] ?? LINK_TTL.default;
  const url = `${root}/v1/email/link?t=${token(key, { t: tenant, p: msg.button.path, e: now.getTime() + ttl })}`;
  const manage = `${root}/v1/email/link?t=${token(key, { t: tenant, p: `/teams/${encodeURIComponent(team)}/notifications`, e: now.getTime() + LINK_TTL.default })}`;
  const context = msg.where === 'dm'
    ? `${mrk(teamName)} · You turned on "${KINDS[msg.kind].label}" messages · <${root}/v1/slack/unsubscribe?t=${token(key, { c: 'slack', t: tenant, l: link, k: msg.kind })}|Turn off these messages> · <${manage}|Manage>`
    : `${mrk(teamName)} · Posted in #${mrk(channelName)} by ${mrk(adminName)}'s choice · <${manage}|Manage>`;
  return {
    text: msg.fallback,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: msg.lines.join('\n') } },
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: msg.button.label }, url }] },
      { type: 'context', elements: [{ type: 'mrkdwn', text: context }] },
    ],
  };
}

const labels = (kinds) => kinds.map((k) => KINDS[k]?.label).filter(Boolean).join(', ');
/** The first DM after someone links Slack (no button). */
export const welcomeDm = (teamName, kinds) => {
  const text = `You'll get ${mrk(teamName)} messages here for: ${labels(kinds)}. You can't approve or decide anything from Slack; every message links to the Studio. Change this any time in Notifications.`;
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
};
/** The first post in a channel an admin picks. */
export const welcomeChannel = (adminName, teamName, kinds) => {
  const text = `${mrk(adminName)} set this channel to get ${mrk(teamName)} updates: ${labels(kinds)}. Messages here leave out recommendations and details; those stay in the Studio for the team.`;
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
};

// ---- the API side -----------------------------------------------------------------------------------------------

const kindsOf = (body, fallback) => {
  if (body?.kinds === undefined && fallback) return fallback;
  const kinds = Array.isArray(body?.kinds) ? [...new Set(body.kinds.map(String))] : null;
  // The digest is email only (L25).
  if (!kinds || kinds.some((k) => !KINDS[k]?.type)) throw new Problem(400, `send { kinds: [...] } from ${Object.keys(KINDS).filter((k) => KINDS[k].type).join(', ')}`);
  return kinds;
};
const CHANNEL = /^[CG][A-Z0-9]{2,20}$/;
const CHANNEL_NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const linkView = (r) => (r ? { linked: true, id: r.id, name: r.slack_name, kinds: r.kinds ?? [] } : { linked: false, kinds: [] });
const channelView = (r) => ({ id: r.id, channel: r.channel, name: r.name, kinds: r.kinds ?? [], addedBy: r.added_by_name, createdAt: r.created_at });

/** The team's Slack sink (one per team). */
const slackSink = async (q, team) => (await q('select id, tenant, team, secret, client_id, client_secret, failing_since, last_error from slack_sinks where team = $1', [team]))[0] ?? null;

/**
 * The Slack side of the API, for one deployment. `redirectUri` is the Studio page Slack sends a person back to
 * after "Connect Slack"; that page posts { code, state } to POST /teams/{team}/slack/link with the person's session,
 * so a link always belongs to whoever is signed in.
 */
export function createSlack({ db, key, publicUrl = '', redirectUri = '', providers = PROVIDERS, readSecret, now = () => new Date(), fetch: send = fetch }) {
  const provider = () => providers.slack;
  const botToken = async (tenant, sink) => (sink ? readSecret(db, key, tenant, sink.secret) : null);
  async function post(tenant, sink, channel, message) {
    const bot = await botToken(tenant, sink);
    if (!bot) return { posted: false, reason: `no Slack token stored as ${sink?.secret}` };
    if (!BOT.test(bot)) return { posted: false, reason: notBot(sink.secret) };
    try { await provider().post({ token: bot, channel, ...message }, { fetch: send }); return { posted: true }; } catch (e) { return { posted: false, reason: String(e.message ?? e).slice(0, 200) }; }
  }
  const teamName = async (tenant, team) => (await getTeam(db, tenant, team)).name ?? team;
  async function welcome(tenant, team, row) {
    const sink = await db.tenant(tenant, ({ q }) => slackSink(q, team));
    const r = await post(tenant, sink, row.slack_user, welcomeDm(await teamName(tenant, team), row.kinds));
    if (r.posted) await db.tenant(tenant, ({ q }) => q('update slack_links set welcomed_at = now() where id = $1', [row.id]));
    return r;
  }

  return {
    /** What the Notifications page shows: is Slack connected, is it working (O1), and the caller's own link. */
    async status(tenant, team, principal) {
      await getTeam(db, tenant, team);
      const [sink, mine] = await db.tenant(tenant, async ({ q }) => [await slackSink(q, team), (await q('select id, slack_name, kinds from slack_links where team = $1 and principal = $2', [team, principal]))[0]]);
      const ready = !!(sink && BOT.test((await botToken(tenant, sink)) ?? ''));
      return {
        connected: !!sink, ready, canLink: !!(ready && sink.client_id && sink.client_secret),
        health: !sink ? null : sink.failing_since ? { status: 'failing', since: new Date(sink.failing_since).toISOString(), error: sink.last_error } : { status: ready ? 'working' : 'waiting for its token' },
        // suggested: ticked (not saved) the first time a person's DM switches show, as for email (D49).
        kinds: Object.entries(KINDS).filter(([, k]) => k.type).map(([id, k]) => ({ id, label: k.label, suggested: SUGGESTED.includes(id), channelDefault: CHANNEL_DEFAULT_KINDS.includes(id) })),
        me: linkView(mine),
      };
    },

    /** Starts "Connect Slack": the Sign in with Slack URL, with a signed state bound to this person and team. */
    async connect(tenant, team, principal) {
      await getTeam(db, tenant, team);
      const sink = await db.tenant(tenant, ({ q }) => slackSink(q, team));
      if (!sink) throw new Problem(409, "Slack isn't connected for this team yet. Ask an owner to add it.");
      if (!sink.client_id || !sink.client_secret || !redirectUri) throw new Problem(409, 'this Slack connection has no sign-in client yet');
      const state = token(key, { c: 'slack-link', t: tenant, team, p: principal, e: now().getTime() + STATE_TTL, n: randomBytes(9).toString('base64url') });
      return { url: provider().authorizeUrl({ clientId: sink.client_id, state, redirectUri, nonce: randomBytes(12).toString('base64url') }) };
    },

    /** Finishes "Connect Slack" (D56): the signed-in person's Slack identity, from the code Slack handed back. */
    async link(tenant, team, principal, body) {
      const st = readToken(key, body?.state);
      if (st?.c !== 'slack-link' || st.t !== tenant || st.team !== team || st.p !== principal) throw new Problem(400, 'this sign-in with Slack was not started here; start again');
      if (!(Number(st.e) > now().getTime())) throw new Problem(410, 'the sign-in with Slack took too long; start again');
      const kinds = kindsOf(body, []);
      const code = String(body?.code ?? '');
      if (!/^[A-Za-z0-9._-]{1,512}$/.test(code)) throw new Problem(400, 'send { code, state } from Slack');
      const sink = await db.tenant(tenant, ({ q }) => slackSink(q, team));
      const bot = await botToken(tenant, sink);
      const clientSecret = sink?.client_secret ? await readSecret(db, key, tenant, sink.client_secret) : null;
      if (!bot || !clientSecret) throw new Problem(409, "Slack isn't connected for this team yet. Ask an owner to add it.");
      if (!BOT.test(bot)) throw new Problem(409, notBot(sink.secret));
      let who, home;
      try {
        who = await provider().identify({ clientId: sink.client_id, clientSecret, code, redirectUri }, { fetch: send });
        home = await provider().workspace({ token: bot }, { fetch: send });
      } catch (e) { throw new Problem(502, `Slack refused the sign-in: ${String(e.message ?? e).slice(0, 120)}`); }
      if (!/^[UW][A-Z0-9]{2,20}$/.test(who.user) || !/^[TE][A-Z0-9]{2,20}$/.test(who.workspace)) throw new Problem(502, 'Slack did not say who signed in');
      if (who.workspace !== home.workspace) throw new Problem(409, `sign in to the ${home.name || 'team'} Slack workspace, the one this team is connected to`);
      const row = await db.tenant(tenant, async ({ q }) => (await q(`insert into slack_links(id, tenant, team, principal, slack_user, slack_workspace, slack_name, kinds) values ($1, $2, $3, $4, $5, $6, $7, $8)
        on conflict (team, principal) do update set slack_user = excluded.slack_user, slack_workspace = excluded.slack_workspace, slack_name = excluded.slack_name,
          kinds = case when $9 then excluded.kinds else slack_links.kinds end,
          welcomed_at = case when slack_links.slack_user = excluded.slack_user then slack_links.welcomed_at end
        returning id, slack_user, slack_name, kinds, welcomed_at`, [newId('slk'), tenant, team, principal, who.user, who.workspace, outside(who.name, 80) || null, kinds, body?.kinds !== undefined]))[0]);
      // Linking again keeps the switches unless new ones are sent; the welcome goes once per Slack account.
      const welcomed = row.kinds.length && !row.welcomed_at ? await welcome(tenant, team, row) : { posted: false };
      return { ...linkView(row), welcomed: welcomed.posted };
    },

    /** Switches the caller's DM kinds (the five switches). The first time any is on, the welcome DM goes out. */
    async setKinds(tenant, team, principal, body) {
      const kinds = kindsOf(body);
      const row = await db.tenant(tenant, async ({ q }) => (await q('update slack_links set kinds = $3 where team = $1 and principal = $2 returning id, slack_user, slack_name, kinds, welcomed_at', [team, principal, kinds]))[0]);
      if (!row) throw new Problem(404, 'connect Slack first');
      if (!row.welcomed_at && kinds.length) await welcome(tenant, team, row);
      return linkView(row);
    },

    /** "Disconnect Slack": stops every DM from this team at once (D60). Channel posts keep going. */
    async unlink(tenant, team, principal) {
      const rows = await db.tenant(tenant, ({ q }) => q('delete from slack_links where team = $1 and principal = $2 returning id', [team, principal]));
      if (!rows.length) throw new Problem(404, 'Slack is not connected for you');
      return { ok: true };
    },

    async channels(tenant, team) {
      await getTeam(db, tenant, team);
      return { channels: (await db.tenant(tenant, ({ q }) => q('select * from slack_channels where team = $1 order by created_at', [team]))).map(channelView) };
    },

    /** An owner or admin picks a channel and its kinds; the channel gets a first post saying so. */
    async addChannel(tenant, team, who, body) {
      await getTeam(db, tenant, team);
      const channel = String(body?.channel ?? ''), name = String(body?.name ?? '').replace(/^#/, '').toLowerCase();
      if (!CHANNEL.test(channel) || !CHANNEL_NAME.test(name)) throw new Problem(400, 'send { channel, name } with the Slack channel id (like C0123ABCD) and its name');
      const kinds = kindsOf(body, CHANNEL_DEFAULT_KINDS);
      const sink = await db.tenant(tenant, ({ q }) => slackSink(q, team));
      if (!sink) throw new Problem(409, "Slack isn't connected for this team yet");
      const adminName = outside(who.name, 80) || 'An admin';
      const row = await db.tenant(tenant, async ({ q }) => {
        const [old] = await q('select id from slack_channels where team = $1 and channel = $2', [team, channel]);
        if (old) throw new Problem(409, 'this channel is already picked; change its kinds instead');
        return (await q('insert into slack_channels(id, tenant, team, channel, name, kinds, added_by, added_by_name) values ($1, $2, $3, $4, $5, $6, $7, $8) returning *',
          [newId('slc'), tenant, team, channel, name, kinds, who.principal, adminName]))[0];
      });
      const r = await post(tenant, sink, channel, welcomeChannel(adminName, await teamName(tenant, team), kinds));
      return { ...channelView(row), posted: r.posted, ...(r.posted ? {} : { reason: r.reason }) };
    },

    async setChannelKinds(tenant, team, cid, body) {
      const kinds = kindsOf(body);
      const [row] = await db.tenant(tenant, ({ q }) => q('update slack_channels set kinds = $3 where team = $1 and id = $2 returning *', [team, cid, kinds]));
      if (!row) throw new Problem(404, 'no such channel');
      return channelView(row);
    },

    async removeChannel(tenant, team, cid) {
      const rows = await db.tenant(tenant, ({ q }) => q('delete from slack_channels where team = $1 and id = $2 returning id', [team, cid]));
      if (!rows.length) throw new Problem(404, 'no such channel');
      return { ok: true };
    },

    /** What a "Turn off these messages" token is about, without changing anything (the page a GET shows). */
    async peekToken(text) {
      const tk = readToken(key, text);
      if (tk?.c !== 'slack' || !tk.t || !tk.l || !KINDS[tk.k]) return null;
      return db.tenant(tk.t, async ({ q }) => {
        const [s] = await q('select l.team, t.name from slack_links l join teams t on t.id = l.team where l.id = $1', [tk.l]);
        return s ? { teamName: s.name, team: s.team, kind: tk.k, label: KINDS[tk.k].label } : null;
      });
    },

    /** Turns one kind off (or back on) for that person from a signed token, without sign-in (D60). */
    async fromToken(text, on) {
      const tk = readToken(key, text);
      if (tk?.c !== 'slack' || !tk.t || !tk.l || !KINDS[tk.k]) return null;
      return db.tenant(tk.t, async ({ q }) => {
        const [s] = await q('select l.id, l.team, l.kinds, t.name from slack_links l join teams t on t.id = l.team where l.id = $1', [tk.l]);
        if (!s) return null;
        const kinds = on ? [...new Set([...(s.kinds ?? []), tk.k])] : (s.kinds ?? []).filter((k) => k !== tk.k);
        await q('update slack_links set kinds = $2 where id = $1', [s.id, kinds]);
        return { teamName: s.name, team: s.team, kind: tk.k, label: KINDS[tk.k].label, on };
      });
    },
  };
}

/**
 * The Slack side of the sink worker: posts `event` to every linked person who has its kind on and still has a way
 * in, and to every picked channel with its kind on, and logs each try. Returns { retry, failed, posted }: `retry` is an error
 * text when the event should be tried again later (a target that got it is never posted twice), `failed` whether any
 * post failed (the health line). A DM that fails goes by email instead when the person has a verified address. With
 * no token in the vault, nothing is posted: the deliveries are logged as skipped.
 */
export async function deliverSlack(db, key, sink, row, { providers = PROVIDERS, readSecret, publicUrl = '', now = new Date(), fetch: send = fetch, email = {} } = {}) {
  const event = row.envelope;
  const kind = kindOfEvent(event?.type);
  if (!kind) return { retry: null, failed: false, posted: 0 };
  const { tenant, team } = sink;
  // Done for this target: sent, sent by email, or skipped (no token, or a failure no retry can fix).
  const done = (alias) => `not exists(select 1 from slack_deliveries d where d.target = ${alias}.id and d.event = $3 and d.status in ('sent', 'emailed', 'skipped'))`;
  const [links, channels, [{ name: teamName }]] = await db.tenant(tenant, async ({ q }) => [
    await q(`select l.id, l.principal, l.slack_user from slack_links l where l.team = $1 and $2 = any(l.kinds) and ${stillIn('l')} and ${done('l')}`, [team, kind, event.id]),
    await q(`select c.id, c.channel, c.name, c.added_by_name from slack_channels c where c.team = $1 and $2 = any(c.kinds) and ${done('c')}`, [team, kind, event.id]),
    await q('select name from teams where id = $1', [team]),
  ]);
  const targets = [...links.map((l) => ({ ...l, where: 'dm', to: l.slack_user })), ...channels.map((c) => ({ ...c, where: 'channel', to: c.channel }))];
  if (!targets.length) return { retry: null, failed: false, posted: 0 };
  const log = (t, status, error = null) => db.tenant(tenant, ({ q }) => q('insert into slack_deliveries(tenant, team, target, event, kind, status, error) values ($1, $2, $3, $4, $5, $6, $7)',
    [tenant, team, t.id, event.id, kind, status, error]));
  const provider = providers.slack;
  const bot = provider ? await readSecret(db, key, tenant, sink.secret) : null;
  if (!bot || !BOT.test(bot)) {
    for (const t of targets) await log(t, 'skipped', bot ? notBot(sink.secret) : `no Slack token stored as ${sink.secret}`);
    return { retry: null, failed: false, posted: 0 };
  }
  let retry = null, failed = false, posted = 0;
  for (const t of targets) {
    const msg = composeSlack(event, { teamName, where: t.where });
    const body = renderSlack(key, msg, { base: publicUrl, tenant, team, teamName, link: t.where === 'dm' ? t.id : null, channelName: t.name, adminName: t.added_by_name, now });
    let err = null;
    try { await provider.post({ token: bot, channel: t.to, ...body }, { fetch: send }); } catch (e) { err = e; }
    if (!err) {
      posted++;
      // Slack took it. If only the log write fails, retry the event later (this target may get it twice) but never
      // treat it as a Slack failure: no email on top (backend-dev review).
      try { await log(t, 'sent'); } catch (e) { retry = `the delivery log failed: ${String(e.message ?? e).slice(0, 160)}`; }
      continue;
    }
    failed = true;
    const error = String(err.message ?? err).slice(0, 200);
    // Criterion 7: a DM that did not go out goes by email, if the person has a verified address for the team.
    const emailed = t.where === 'dm' ? await emailFallback(db, key, { tenant, team, principal: t.principal, event }, { readSecret, publicUrl, now, fetch: send, ...email }).catch(() => 0) : 0;
    // A failure no retry can fix (a removed channel, a deactivated user) is logged as skipped, so later retries leave
    // this target alone.
    if (err.permanent && !emailed) { await log(t, 'skipped', error); continue; }
    await log(t, emailed ? 'emailed' : 'failed', error);
    if (!emailed) retry = error;
  }
  return { retry, failed, posted };
}
