// Slack notifications (CPO story "Slack notifications", criteria 1 to 7): the Slack sink, DMs and channel posts,
// Connect Slack, turning off without sign-in, the email fallback and the health line. A fake provider stands in for
// Slack; the real one is never called without a token in the vault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { key, plane } from './helpers.mjs';
import { drain } from '../sinks.mjs';
import { KINDS, readToken } from '../email.mjs';
import { CHANNEL_DEFAULT_KINDS, PROVIDERS, composeSlack, deliverSlack, mrk, renderSlack } from '../slack.mjs';
import { readSecret } from '../store.mjs';

const PUBLIC = 'https://cp.example';
const STUDIO = 'https://studio.example';

class FakeSlackError extends Error { constructor(code) { super(`Slack: ${code}`); this.code = code; this.permanent = code === 'not_in_channel'; } }

function fakeSlack({ workspace = 'T0SHOP', user = 'U0OWNER', userWorkspace = workspace, name = 'Olive' } = {}) {
  const posts = [];
  return {
    posts, fail: null, failFor: new Set(), title: 'Fake Slack',
    async post(m) {
      if (this.fail && (!this.failFor.size || this.failFor.has(m.channel))) throw new FakeSlackError(this.fail);
      posts.push(m);
      return { id: `ts_${posts.length}` };
    },
    async workspace({ token }) { assert.equal(token, 'xoxb-test'); return { workspace, name: 'Shop HQ' }; },
    async identify({ clientId, clientSecret, code, redirectUri }) {
      assert.deepEqual([clientId, clientSecret, redirectUri], ['111.222', 'client-secret', `${STUDIO}/slack/callback`]);
      if (code !== 'good-code') throw new FakeSlackError('invalid_code');
      return { user, workspace: userWorkspace, name };
    },
    authorizeUrl: PROVIDERS.slack.authorizeUrl,
  };
}

function fakeEmail() {
  const sent = [];
  return { sent, title: 'Fake', async send(m) { sent.push(m); return { id: `fake_${sent.length}` }; } };
}

let n = 0;
const ev = (type, data, actor = 'web-dev') => ({ specversion: '1.0', id: `ev_${++n}_${Math.random().toString(36).slice(2, 8)}`, type, version: 1, source: '/tenants/acme/teams/shop', tenant: 'acme', team: 'shop', time: '2026-11-06T09:30:00.000Z', actor: { kind: 'role', id: actor }, data });
const LONG = 'Rotate the payments webhook secret and redeploy the API to production, then purge the CDN cache for every region before the evening launch';
const SAMPLES = {
  approval: ev('approval.requested', { approval: 'apr_1', action: 'deploy', why: LONG, recommendation: 'Approve: the change was reviewed and tested', cardId: 'card_1' }),
  budget80: ev('budget.warned', { scope: 'day', day: '2026-11-06', spent: 400, cap: 500, currency: 'USD' }),
  budget100: ev('budget.exhausted', { scope: 'day', day: '2026-11-06', spent: 500, cap: 500, currency: 'USD', cardId: 'card_2' }),
  blocked: ev('message.blocked', { to: 'chief-of-staff', task: 'Footer', detail: 'Which name goes in the footer: <!channel> "Acme Inc." or "Acme Labs"?', recommendation: 'Acme Inc., as on the invoices' }, 'qa-web'),
  minutes: ev('meeting.minutes', { meeting: 'Weekly planning', meetingId: 'mtg_1', date: '2026-11-06', decisions: [{ text: 'Ship the footer on Friday' }, { text: 'Hold the pricing page' }], actions: [{ to: 'web-dev', task: 'a' }, { to: 'cto', task: 'b' }, { to: 'cpo', task: 'c' }], needsYou: 1 }),
};
const again = (e, tag) => ({ ...e, id: `${e.id}_${tag}` });

const opts = (slack, email = fakeEmail()) => ({ publicUrl: PUBLIC, email: { providers: { fake: email }, studioUrl: STUDIO }, slack: { providers: { slack } } });
const drainOpts = (slack, email = fakeEmail()) => ({ email: { providers: { fake: email }, publicUrl: PUBLIC }, slack: { providers: { slack } } });
const secret = async (call, su, name, value) => assert.equal((await call('PUT', `/secrets/${name}`, { value }, await su())).status, 200);

async function connected(call, su) {
  await call('POST', '/teams', { id: 'shop', name: 'Shop' });
  const s = await call('POST', '/teams/shop/sinks', { format: 'slack', secret: 'SLACK_BOT_TOKEN', clientId: '111.222', clientSecret: 'SLACK_CLIENT_SECRET' });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  await secret(call, su, 'SLACK_BOT_TOKEN', 'xoxb-test');
  await secret(call, su, 'SLACK_CLIENT_SECRET', 'client-secret');
}

async function linked(call, kinds) {
  const c = await call('POST', '/teams/shop/slack/connect');
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const state = new URL(c.body.url).searchParams.get('state');
  const l = await call('POST', '/teams/shop/slack/link', { code: 'good-code', state, ...(kinds ? { kinds } : {}) });
  assert.equal(l.status, 201, JSON.stringify(l.body));
  return l.body;
}

const lines = (body) => body.blocks[0].text.text.split('\n');
const button = (body) => body.blocks[1].elements;
const context = (body) => body.blocks[2].elements[0].text;

test('every kind, DM and channel: fallback text, at most four lines, one link button, the context line (criteria 2, 3, 5)', () => {
  const now = new Date('2026-11-06T09:30:00Z');
  for (const [kind, e] of Object.entries(SAMPLES)) {
    for (const where of ['dm', 'channel']) {
      const msg = composeSlack(e, { teamName: 'Shop', where });
      assert.equal(msg.kind, kind);
      assert.ok(msg.fallback.startsWith('Shop: '), msg.fallback);
      const body = renderSlack(key, msg, { base: PUBLIC, tenant: 'acme', team: 'shop', teamName: 'Shop', link: 'slk_x', channelName: 'launch', adminName: 'Olive', now });
      assert.equal(body.text, msg.fallback, 'the fallback is the notification text');
      assert.deepEqual(body.blocks.map((b) => b.type), ['section', 'actions', 'context'], `${kind} ${where}`);
      assert.ok(lines(body).length >= 1 && lines(body).length <= 4, `${kind} ${where}: ${lines(body).length} lines`);
      // Exactly one button, a plain link: no action id, no value, nothing Slack would send back to an app (D57).
      assert.equal(button(body).length, 1);
      assert.deepEqual(Object.keys(button(body)[0]).sort(), ['text', 'type', 'url']);
      assert.equal(button(body)[0].text.text, msg.button.label);
      const tk = readToken(key, new URL(button(body)[0].url).searchParams.get('t'));
      assert.equal(tk.e - now.getTime(), kind === 'approval' ? 86_400_000 : 7 * 86_400_000, `${kind}: links expire`);
      assert.ok(tk.p.startsWith('/teams/shop/'), tk.p);
      if (where === 'dm') {
        assert.match(context(body), new RegExp(`^Shop · You turned on "${KINDS[kind].label}" messages · <https://cp\\.example/v1/slack/unsubscribe\\?t=[^|]+\\|Turn off these messages> · <https://cp\\.example/v1/email/link\\?t=[^|]+\\|Manage>$`));
      } else {
        assert.match(context(body), /^Shop · Posted in #launch by Olive's choice · <https:\/\/cp\.example\/v1\/email\/link\?t=[^|]+\|Manage>$/);
      }
      assert.doesNotMatch(JSON.stringify(body), /\breply\b/i);
    }
  }
  // The copy, word for word where it has no placeholders.
  const a = composeSlack(SAMPLES.approval, { teamName: 'Shop' });
  assert.equal(a.fallback, 'Shop: Web dev needs your approval');
  assert.equal(a.lines[0], '*Web dev needs your approval before it can go on.*');
  assert.equal(a.lines.at(-1), "Nothing happens until you approve in the Studio. You can't approve from Slack.");
  assert.equal(a.button.label, 'Review in the Studio');
  assert.deepEqual(composeSlack(SAMPLES.budget80, { teamName: 'Shop' }).lines, ['*$4.00 of $5.00 used today.*', 'Work carries on. At 100% only release-blocking fixes and checks keep running.']);
  assert.deepEqual(composeSlack(SAMPLES.budget100, { teamName: 'Shop' }).lines, ['*Daily budget of $5.00 reached. New work is paused until 00:00 UTC.*', 'An owner can raise the cap in the Studio to resume sooner.']);
  assert.equal(composeSlack(SAMPLES.budget100, { teamName: 'Shop' }).fallback, 'Shop: daily budget reached, new work paused');
  assert.deepEqual(composeSlack(SAMPLES.minutes, { teamName: 'Shop' }).lines, ['*Minutes: Weekly planning (2026-11-06)*', '2 decisions and 3 action items.', '"Ship the footer on Friday"', '1 item needs you.']);
  assert.equal(composeSlack(SAMPLES.minutes, { teamName: 'Shop' }).fallback, 'Shop: minutes from Weekly planning');
  assert.equal(composeSlack(ev('report.status', { status: 'working' })), null, 'no message for other events');
  // Outside text: quoted, cut to 120 characters, and never a mention.
  const quoted = a.lines[1];
  assert.match(quoted, /^".+…"$/);
  assert.equal(quoted.length - 2, 120);
  const b = composeSlack(SAMPLES.blocked, { teamName: 'Shop' });
  assert.equal(b.fallback, 'Shop: QA web is waiting on a decision');
  assert.match(b.lines[0], /^\*QA web is blocked on:\* ".*&lt;!channel&gt;.*"$/);
  assert.doesNotMatch(JSON.stringify(b), /<!channel>/);
  assert.equal(mrk('a & <b>'), 'a &amp; &lt;b&gt;');
});

test('channels leave out recommendations and meeting decisions (criterion 4)', () => {
  for (const [kind, e] of Object.entries(SAMPLES)) {
    const dm = composeSlack(e, { teamName: 'Shop', where: 'dm' }), ch = composeSlack(e, { teamName: 'Shop', where: 'channel' });
    assert.doesNotMatch(ch.fallback, /\byour\b/i, `${kind}: a channel's notification text is not addressed to one person (CPO review)`);
    assert.doesNotMatch(ch.lines.join('\n'), /Recommendation|Acme Inc\., as on the invoices|Ship the footer|needs? you/, kind);
    assert.equal(ch.button.path, dm.button.path, `${kind}: the same place in the Studio, behind sign-in`);
    if (kind === 'approval' || kind === 'blocked') assert.match(dm.lines.join('\n'), /Recommendation: /, kind);
    if (kind === 'budget80' || kind === 'budget100') assert.deepEqual(ch.lines, dm.lines, `${kind}: the same in both`);
  }
  assert.deepEqual(composeSlack(SAMPLES.approval, { teamName: 'Shop', where: 'channel' }).lines.map((l) => l.slice(0, 30)), ['*Web dev is waiting for an app', `"${LONG.slice(0, 29)}`, 'An owner approves in the Studi']);
  assert.equal(composeSlack(SAMPLES.approval, { teamName: 'Shop', where: 'channel' }).fallback, 'Shop: Web dev is waiting for an approval');
  assert.deepEqual(composeSlack(SAMPLES.blocked, { teamName: 'Shop', where: 'channel' }).lines[0], '*QA web is waiting on a decision from the owner.*');
  assert.deepEqual(composeSlack(SAMPLES.minutes, { teamName: 'Shop', where: 'channel' }).lines, ['*Minutes: Weekly planning (2026-11-06)*', '2 decisions and 3 action items.']);
});

test('nothing is posted until the token is stored and a person linked and chose kinds, or an admin picked a channel (criteria 1 and 6)', async () => {
  const slack = fakeSlack();
  await plane(async ({ db, call, su, base }) => {
    await call('POST', '/teams', { id: 'shop', name: 'Shop' });
    // Not connected: the page says so, and Connect Slack is refused.
    let st = (await call('GET', '/teams/shop/slack')).body;
    assert.deepEqual([st.connected, st.ready, st.canLink, st.me.linked], [false, false, false, false]);
    assert.equal((await call('POST', '/teams/shop/slack/connect')).status, 409);
    assert.equal((await call('POST', '/teams/shop/sinks', { format: 'slack', secret: 'GITHUB_TOKEN' })).status, 400, 'only SLACK_ secrets');
    assert.equal((await call('POST', '/teams/shop/sinks', { format: 'slack', secret: 'SLACK_BOT_TOKEN', clientId: '111.222' })).status, 400, 'client id and secret together');
    assert.equal((await call('POST', '/teams/shop/sinks', { format: 'slack', secret: 'SLACK_BOT_TOKEN', clientId: '111.222', clientSecret: 'SLACK_CLIENT_SECRET' })).status, 201);
    assert.equal((await call('POST', '/teams/shop/sinks', { format: 'slack', secret: 'SLACK_OTHER' })).status, 409, 'one Slack workspace per team');
    st = (await call('GET', '/teams/shop/slack')).body;
    assert.deepEqual([st.connected, st.ready, st.health.status], [true, false, 'waiting for its token']);
    // Connected but no token stored: a link cannot finish, and nothing calls Slack.
    const c = await call('POST', '/teams/shop/slack/connect');
    assert.equal(c.status, 200);
    const url = new URL(c.body.url);
    assert.equal(url.origin + url.pathname, 'https://slack.com/openid/connect/authorize');
    assert.deepEqual([url.searchParams.get('scope'), url.searchParams.get('client_id'), url.searchParams.get('redirect_uri')], ['openid profile', '111.222', `${STUDIO}/slack/callback`]);
    assert.equal((await call('POST', '/teams/shop/slack/link', { code: 'good-code', state: url.searchParams.get('state') })).status, 409);
    await secret(call, su, 'SLACK_BOT_TOKEN', 'xoxb-test');
    await secret(call, su, 'SLACK_CLIENT_SECRET', 'client-secret');

    // Linked with nothing switched on: no welcome, no messages.
    const link = await linked(call);
    assert.deepEqual([link.linked, link.name, link.kinds, link.welcomed], [true, 'Olive', [], false]);
    await call('POST', '/teams/shop/events', { events: [SAMPLES.approval] });
    await drain(db, key, drainOpts(slack));
    assert.equal(slack.posts.length, 0);
    // The first switch on: the welcome DM, once.
    assert.equal((await call('PATCH', '/teams/shop/slack/me', { kinds: ['nope'] })).status, 400);
    assert.equal((await call('PATCH', '/teams/shop/slack/me', { kinds: ['approval', 'blocked'] })).status, 200);
    assert.equal(slack.posts.length, 1);
    assert.equal(slack.posts[0].channel, 'U0OWNER');
    assert.equal(slack.posts[0].text, "You'll get Shop messages here for: Approval needed, A role is blocked. You can't approve or decide anything from Slack; every message links to the Studio. Change this any time in Notifications.");
    assert.deepEqual(slack.posts[0].blocks.map((b) => b.type), ['section'], 'no button');
    await call('PATCH', '/teams/shop/slack/me', { kinds: ['approval', 'blocked', 'budget80'] });
    assert.equal(slack.posts.length, 1, 'the welcome goes once');

    // An admin picks a channel: approval and BLOCKED start off, and the channel is told who chose it.
    assert.equal((await call('POST', '/teams/shop/slack/channels', { channel: 'not-an-id', name: 'launch' })).status, 400);
    const ch = await call('POST', '/teams/shop/slack/channels', { channel: 'C0LAUNCH', name: '#Launch' });
    assert.equal(ch.status, 201, JSON.stringify(ch.body));
    assert.deepEqual([ch.body.name, ch.body.kinds, ch.body.posted], ['launch', CHANNEL_DEFAULT_KINDS, true]);
    assert.equal(slack.posts.at(-1).channel, 'C0LAUNCH');
    assert.equal(slack.posts.at(-1).text, 'The admin set this channel to get Shop updates: Budget at 80%, Budget at 100%, Meeting minutes. Messages here leave out recommendations and details; those stay in the Studio for the team.');
    assert.equal((await call('POST', '/teams/shop/slack/channels', { channel: 'C0LAUNCH', name: 'launch' })).status, 409);

    // Events: the approval goes only to the DM, the budget warning to both, each once.
    slack.posts.length = 0;
    const [{ cursor: before }] = await db.tenant('acme', ({ q }) => q('select cursor from slack_sinks'));
    await call('POST', '/teams/shop/events', { events: [again(SAMPLES.approval, 'b'), SAMPLES.budget80, SAMPLES.blocked] });
    await drain(db, key, drainOpts(slack));
    assert.deepEqual(slack.posts.map((p) => [p.channel, p.text]), [
      ['U0OWNER', 'Shop: Web dev needs your approval'],
      ['U0OWNER', "Shop: 80% of today's budget used"],
      ['C0LAUNCH', "Shop: 80% of today's budget used"],
      ['U0OWNER', 'Shop: QA web is waiting on a decision'],
    ]);
    assert.ok(slack.posts.every((p) => p.token === 'xoxb-test'));
    await db.tenant('acme', ({ q }) => q('update slack_sinks set next_at = now(), cursor = $1', [before]));
    await drain(db, key, drainOpts(slack));
    assert.equal(slack.posts.length, 4, 'nothing twice, even when the log is replayed');
    assert.equal((await call('GET', '/teams/shop/slack')).body.health.status, 'working');

    // "Turn off these messages": a GET only asks; the button turns off that kind, for that person.
    const unsub = /<([^|>]+)\|Turn off these messages>/.exec(context(slack.posts[0]))[1].replace(PUBLIC + '/v1', base);
    const ask = await fetch(unsub);
    const askHtml = await ask.text();
    assert.equal(ask.status, 200);
    assert.match(askHtml, /Stop &quot;Approval needed&quot; Slack messages for Shop\?/);
    assert.match(askHtml, /Other messages you turned on still arrive\. Slack stays connected\./);
    assert.deepEqual((await call('GET', '/teams/shop/slack')).body.me.kinds, ['approval', 'blocked', 'budget80'], 'a GET changes nothing');
    const off = await fetch(unsub, { method: 'POST' });
    assert.match(await off.text(), /You won&#39;t get &quot;Approval needed&quot; Slack messages for Shop/);
    assert.deepEqual((await call('GET', '/teams/shop/slack')).body.me.kinds, ['blocked', 'budget80']);
    assert.equal((await fetch(`${base}/slack/unsubscribe?t=abc.def`)).status, 400);
    // An email unsubscribe token is not a Slack one, and the other way round.
    assert.equal((await fetch(unsub.replace('/slack/unsubscribe', '/email/unsubscribe'))).status, 400);
    // The button lands in the Studio, behind sign-in.
    const go = await fetch(button(slack.posts[0])[0].url.replace(PUBLIC + '/v1', base), { redirect: 'manual' });
    assert.equal(go.status, 302);
    assert.equal(go.headers.get('location'), `${STUDIO}/teams/shop/inbox?card=card_1`);

    // Disconnect Slack stops every DM; the channel keeps getting what the admin chose, until it is removed.
    assert.equal((await call('DELETE', '/teams/shop/slack/me')).status, 200);
    slack.posts.length = 0;
    await call('POST', '/teams/shop/events', { events: [again(SAMPLES.budget80, 'c')] });
    await drain(db, key, drainOpts(slack));
    assert.deepEqual(slack.posts.map((p) => p.channel), ['C0LAUNCH']);
    const chans = (await call('GET', '/teams/shop/slack/channels')).body.channels;
    assert.equal((await call('PATCH', `/teams/shop/slack/channels/${chans[0].id}`, { kinds: ['approval'] })).status, 200);
    assert.equal((await call('DELETE', `/teams/shop/slack/channels/${chans[0].id}`)).status, 200);
    await call('POST', '/teams/shop/events', { events: [again(SAMPLES.budget80, 'd'), again(SAMPLES.approval, 'd')] });
    await drain(db, key, drainOpts(slack));
    assert.equal(slack.posts.length, 1);
  }, opts(slack));
});

test('Connect Slack only links the signed-in person who started it, within 10 minutes, in the team\'s own workspace (D56)', async () => {
  let clock = new Date('2026-11-06T09:00:00Z');
  const slack = fakeSlack();
  await plane(async ({ call, su }) => {
    await connected(call, su);
    await call('POST', '/teams', { id: 'other', name: 'Other' });
    const state = new URL((await call('POST', '/teams/shop/slack/connect')).body.url).searchParams.get('state');
    assert.equal((await call('POST', '/teams/other/slack/link', { code: 'good-code', state })).status, 400, 'another team');
    assert.equal((await call('POST', '/teams/shop/slack/link', { code: 'good-code', state: 'forged.state' })).status, 400);
    assert.equal((await call('POST', '/teams/shop/slack/link', { code: 'bad code!', state })).status, 400);
    assert.equal((await call('POST', '/teams/shop/slack/link', { code: 'nope', state })).status, 502, 'Slack refused the code');
    clock = new Date(clock.getTime() + 11 * 60_000);
    assert.equal((await call('POST', '/teams/shop/slack/link', { code: 'good-code', state })).status, 410);
    // Someone signed in to another Slack workspace: refused.
    slack.identify = async () => ({ user: 'U0STRANGER', workspace: 'T0ELSEWHERE', name: 'S' });
    const fresh = new URL((await call('POST', '/teams/shop/slack/connect')).body.url).searchParams.get('state');
    const r = await call('POST', '/teams/shop/slack/link', { code: 'good-code', state: fresh });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /Shop HQ Slack workspace/);
    assert.equal((await call('GET', '/teams/shop/slack')).body.me.linked, false);
  }, { ...opts(slack), now: () => clock });
});

test('without a bot token in the vault Slack is never called and deliveries are logged as skipped (criterion 1)', async () => {
  let calls = 0;
  const fetch = async () => { calls++; return new Response('{"ok":true}', { status: 200 }); };
  await plane(async ({ db, call, su }) => {
    await call('POST', '/teams', { id: 'shop', name: 'Shop' });
    assert.equal((await call('POST', '/teams/shop/sinks', { format: 'slack', secret: 'SLACK_BOT_TOKEN' })).status, 201);
    await db.tenant('acme', ({ q }) => q(`insert into slack_links(id, tenant, team, principal, slack_user, slack_workspace, kinds) values ('slk_v', 'acme', 'shop', 'admin', 'U0OWNER', 'T0SHOP', '{approval}')`));
    await db.tenant('acme', ({ q }) => q(`insert into slack_channels(id, tenant, team, channel, name, kinds, added_by, added_by_name) values ('slc_v', 'acme', 'shop', 'C0LAUNCH', 'launch', '{approval}', 'admin', 'The admin')`));
    const ch = await call('POST', '/teams/shop/slack/channels', { channel: 'C0OTHER', name: 'other' });
    assert.deepEqual([ch.body.posted, ch.body.reason], [false, 'no Slack token stored as SLACK_BOT_TOKEN']);
    await call('POST', '/teams/shop/events', { events: [SAMPLES.approval] });
    await drain(db, key, { fetch, email: { publicUrl: PUBLIC } });
    assert.equal(calls, 0);
    const rows = await db.tenant('acme', ({ q }) => q('select target, status, error from slack_deliveries order by target desc'));
    assert.deepEqual(rows, [{ target: 'slk_v', status: 'skipped', error: 'no Slack token stored as SLACK_BOT_TOKEN' }, { target: 'slc_v', status: 'skipped', error: 'no Slack token stored as SLACK_BOT_TOKEN' }]);
    // A person's token (not a bot's) is refused too: posts would go out as that person (security review).
    assert.equal((await call('PUT', '/secrets/SLACK_BOT_TOKEN', { value: 'xoxp-person' }, await su())).status, 200);
    await call('POST', '/teams/shop/events', { events: [again(SAMPLES.approval, 'user-token')] });
    await drain(db, key, { fetch, email: { publicUrl: PUBLIC } });
    assert.equal(calls, 0);
    const refused = await db.tenant('acme', ({ q }) => q("select distinct error from slack_deliveries where event like '%user-token'"));
    assert.deepEqual(refused, [{ error: 'the token stored as SLACK_BOT_TOKEN is not a bot token (xoxb-…)' }]);
    assert.equal((await call('GET', '/teams/shop/slack')).body.ready, false);
  }, { publicUrl: PUBLIC, slack: { fetch } });
  // The real provider, given a token, posts one message to chat.postMessage, and reads Slack's error codes.
  const seen = [];
  const ok = await PROVIDERS.slack.post({ token: 'xoxb-1', channel: 'C1', text: 't', blocks: [] }, { fetch: async (url, init) => { seen.push({ url, init }); return new Response('{"ok":true,"ts":"1.2"}', { status: 200 }); } });
  assert.equal(ok.id, '1.2');
  assert.equal(seen[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(seen[0].init.headers.authorization, 'Bearer xoxb-1');
  assert.deepEqual(JSON.parse(seen[0].init.body), { channel: 'C1', text: 't', blocks: [], unfurl_links: false, unfurl_media: false });
  await assert.rejects(PROVIDERS.slack.post({ token: 'x', channel: 'C1', text: 't' }, { fetch: async () => new Response('{"ok":false,"error":"not_in_channel"}', { status: 200 }) }), (e) => e.code === 'not_in_channel' && e.permanent);
  await assert.rejects(PROVIDERS.slack.post({ token: 'x', channel: 'C1', text: 't' }, { fetch: async () => new Response('', { status: 429 }) }), (e) => e.code === 'ratelimited' && !e.permanent);
  const who = await PROVIDERS.slack.identify({ clientId: '1.2', clientSecret: 's', code: 'c', redirectUri: 'https://studio.example/slack/callback' }, {
    fetch: async (url) => new Response(url.endsWith('openid.connect.token') ? '{"ok":true,"access_token":"xoxp-1"}' : '{"ok":true,"https://slack.com/user_id":"U1","https://slack.com/team_id":"T1","name":"Ann"}', { status: 200 }),
  });
  assert.deepEqual(who, { user: 'U1', workspace: 'T1', name: 'Ann' });
});

test('when Slack fails a DM goes by email instead and the health line says so; a removed channel does not hold up the rest (criterion 7)', async () => {
  const slack = fakeSlack();
  const mail = fakeEmail();
  await plane(async ({ db, call, su }) => {
    await connected(call, su);
    await linked(call, ['blocked']);
    await call('POST', '/teams/shop/slack/channels', { channel: 'C0LAUNCH', name: 'launch', kinds: ['budget80'] });
    // An email address with no kinds on: email only ever stands in for Slack.
    assert.equal((await call('POST', '/teams/shop/sinks', { format: 'email', provider: 'fake', sender: 'team@shop.example', secret: 'EMAIL_PROVIDER_KEY' })).status, 201);
    await secret(call, su, 'EMAIL_PROVIDER_KEY', 're_test');
    const add = await call('POST', '/teams/shop/emails', { email: 'owner@shop.example' });
    const code = /(\d{6})$/.exec(mail.sent.at(-1).subject)[1];
    assert.equal((await call('POST', `/teams/shop/emails/${add.body.id}/verify`, { code })).status, 200);
    mail.sent.length = 0;

    slack.fail = 'service_unavailable';
    await call('POST', '/teams/shop/events', { events: [SAMPLES.blocked] });
    await drain(db, key, drainOpts(slack, mail));
    assert.deepEqual(mail.sent.map((m) => [m.to, m.subject]), [['owner@shop.example', '[Shop] QA web is waiting on a decision']]);
    let st = (await call('GET', '/teams/shop/slack')).body;
    assert.equal(st.health.status, 'failing');
    assert.ok(st.health.since);
    // Slack comes back: the DM that went by email is not posted again, and the next post clears the health line.
    slack.fail = null;
    await db.tenant('acme', ({ q }) => q('update slack_sinks set next_at = now()'));
    await drain(db, key, drainOpts(slack, mail));
    assert.equal(slack.posts.filter((p) => p.text.includes('waiting on a decision')).length, 0);
    await call('POST', '/teams/shop/events', { events: [again(SAMPLES.blocked, 'ok')] });
    await drain(db, key, drainOpts(slack, mail));
    assert.equal(slack.posts.at(-1).text, 'Shop: QA web is waiting on a decision');
    assert.equal((await call('GET', '/teams/shop/slack')).body.health.status, 'working');
    assert.equal(mail.sent.length, 1, 'no email once Slack works');

    // The bot was removed from the channel: logged as failed, the sink moves on, the health line shows it.
    slack.fail = 'not_in_channel';
    slack.failFor = new Set(['C0LAUNCH']);
    await call('POST', '/teams/shop/events', { events: [SAMPLES.budget80, again(SAMPLES.blocked, 'after')] });
    await drain(db, key, drainOpts(slack, mail));
    assert.equal(slack.posts.at(-1).text, 'Shop: QA web is waiting on a decision', 'later events still go out');
    const failed = await db.tenant('acme', ({ q }) => q("select target, status, error from slack_deliveries where status in ('failed', 'emailed') order by id"));
    assert.deepEqual(failed.map((r) => [r.status, r.error]), [['emailed', 'Slack: service_unavailable']]);
    const gone = await db.tenant('acme', ({ q }) => q("select status, error from slack_deliveries where error like '%not_in_channel'"));
    assert.deepEqual(gone, [{ status: 'skipped', error: 'Slack: not_in_channel' }], 'logged once, never retried');
    // A DM that can never go out (here: the same permanent error) still goes by email (backend-dev review).
    slack.failFor = new Set(['U0OWNER']);
    mail.sent.length = 0;
    await call('POST', '/teams/shop/events', { events: [again(SAMPLES.blocked, 'gone')] });
    await drain(db, key, drainOpts(slack, mail));
    assert.deepEqual(mail.sent.map((m) => m.to), ['owner@shop.example']);
    st = (await call('GET', '/teams/shop/slack')).body;
    assert.equal(st.health.status, 'failing');
  }, opts(slack, mail));
});

test('someone who is no longer a member gets no DMs (security review V1; members.test checks removal deletes the link)', async () => {
  const slack = fakeSlack();
  await plane(async ({ db, call, su }) => {
    await connected(call, su);
    await db.system(`insert into people(id, provider, subject, login) values ('per_staysmember', 'github', '201', 'stays'), ('per_leftmember', 'github', '202', 'left')`);
    await db.system(`insert into members(id, tenant, person, role, removed_at) values ('mem_s', 'acme', 'per_staysmember', 'viewer', null), ('mem_l', 'acme', 'per_leftmember', 'editor', now())`);
    await db.system(`insert into slack_links(id, tenant, team, principal, slack_user, slack_workspace, kinds, welcomed_at) values
      ('slk_stays', 'acme', 'shop', 'per_staysmember', 'U0STAYS', 'T0SHOP', '{blocked}', now()),
      ('slk_left', 'acme', 'shop', 'per_leftmember', 'U0LEFT', 'T0SHOP', '{blocked}', now()),
      ('slk_never', 'acme', 'shop', 'per_nevermember', 'U0NEVER', 'T0SHOP', '{blocked}', now())`);
    await call('POST', '/teams/shop/events', { events: [SAMPLES.blocked] });
    await drain(db, key, drainOpts(slack));
    assert.deepEqual(slack.posts.map((p) => p.channel), ['U0STAYS']);
  }, opts(slack));
});

test('a log write that fails after Slack took the post retries later, and never sends the email fallback too (backend-dev review)', async () => {
  const slack = fakeSlack();
  const mail = fakeEmail();
  await plane(async ({ db, call, su }) => {
    await connected(call, su);
    await linked(call, ['blocked']);
    assert.equal((await call('POST', '/teams/shop/sinks', { format: 'email', provider: 'fake', sender: 'team@shop.example', secret: 'EMAIL_PROVIDER_KEY' })).status, 201);
    await secret(call, su, 'EMAIL_PROVIDER_KEY', 're_test');
    await db.system("insert into email_subscriptions(id, tenant, team, principal, email, kinds, verified_at) values ('eml_o', 'acme', 'shop', 'admin', 'owner@shop.example', '{}', now())");
    mail.sent.length = 0;
    slack.posts.length = 0;
    let blip = true;
    const flaky = { ...db, tenant: (t, fn) => db.tenant(t, (ctx) => fn({ ...ctx, q: (sql, p) => {
      if (blip && sql.startsWith('insert into slack_deliveries') && p?.[5] === 'sent') { blip = false; throw new Error('connection reset'); }
      return ctx.q(sql, p);
    } })) };
    const [sink] = await db.tenant('acme', ({ q }) => q('select * from slack_sinks'));
    const out = await deliverSlack(flaky, key, sink, { envelope: SAMPLES.blocked }, { readSecret, publicUrl: PUBLIC, providers: { slack }, email: { providers: { fake: mail } } });
    assert.equal(slack.posts.length, 1);
    assert.deepEqual([out.posted, out.failed, /delivery log failed/.test(out.retry)], [1, false, true]);
    assert.equal(mail.sent.length, 0, 'no email on top of a post Slack took');
  }, opts(slack, mail));
});

test('linking Slack again keeps the switches unless new ones are sent, and welcomes once (backend-dev review)', async () => {
  const slack = fakeSlack();
  await plane(async ({ call, su }) => {
    await connected(call, su);
    await linked(call, ['approval', 'minutes']);
    assert.equal(slack.posts.length, 1, 'welcome');
    const again = await linked(call);
    assert.deepEqual(again.kinds, ['approval', 'minutes']);
    assert.equal(slack.posts.length, 1, 'no second welcome for the same account');
    assert.deepEqual((await linked(call, ['budget80'])).kinds, ['budget80']);
  }, opts(slack));
});
