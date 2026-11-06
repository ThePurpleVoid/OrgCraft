// What each role may do in a workspace (docs/specs/m4-sign-in.md section 4). Each role includes the ones below it:
//
//   viewer    reads everything a team shows (board, chat, cards, runs, budget, events)
//   editor    + chats, starts, pauses, resumes and stops runs
//   approver  + answers approvals and decision cards (approvals also need step-up)
//   admin     + creates teams, sets budgets, manages runners, report tokens, sinks, secrets, and members below owner
//   owner     + makes and removes owners
//
// Not listed, on purpose: routes that are not a person's (the x-team-token report intake, a runner redeeming its code,
// a session's tools, the cron's /internal, the signed links in team emails under /email and in Slack DMs under /slack), /health, and a person's own sign-in and passkeys (/me, /me/passkeys,
// /auth/step-up/challenge), which any signed-in person may use, member or not.
//
// Every other /v1 route a person can call is listed here, and api-v1.yaml states the same minimum as x-min-role (a test
// checks the two agree). A route missing from this table is refused, so a new route cannot ship without a role.
export const ROLES = ['viewer', 'editor', 'approver', 'admin', 'owner'];
export const rank = (role) => ROLES.indexOf(role);
export const atLeast = (role, min) => rank(role) >= 0 && rank(role) >= rank(min);

/** [method, path pattern (api-v1.yaml's, with {params}), minimum role]. */
export const ROUTES = [
  ['GET', '/me/summary', 'viewer'],
  ['GET', '/me/stream', 'viewer'],
  ['GET', '/me/inbox', 'viewer'],
  ['POST', '/auth/step-up', 'viewer'],
  ['POST', '/runs/{run}/{action}', 'editor'],
  ['POST', '/approvals/{approval}', 'approver'],
  ['GET', '/cards/{card}', 'viewer'],
  ['POST', '/cards/{card}', 'approver'],
  ['POST', '/runners/codes', 'admin'],
  ['GET', '/runners', 'admin'],
  ['DELETE', '/runners/{runner}', 'admin'],
  ['GET', '/teams', 'viewer'],
  ['POST', '/teams', 'admin'],
  ['GET', '/teams/{team}', 'viewer'],
  ['GET', '/teams/{team}/events', 'viewer'],
  ['POST', '/teams/{team}/events', 'admin'],
  ['GET', '/teams/{team}/events/stream', 'viewer'],
  ['GET', '/teams/{team}/budget', 'viewer'],
  ['PUT', '/teams/{team}/budget', 'admin'],
  ['GET', '/teams/{team}/runs', 'viewer'],
  ['POST', '/teams/{team}/runs', 'editor'],
  ['GET', '/teams/{team}/chat', 'viewer'],
  ['POST', '/teams/{team}/chat', 'editor'],
  ['GET', '/teams/{team}/meetings', 'viewer'],
  ['POST', '/teams/{team}/meetings', 'editor'],
  ['GET', '/teams/{team}/meetings/{meeting}', 'viewer'],
  ['GET', '/teams/{team}/board', 'viewer'],
  ['POST', '/teams/{team}/report-tokens', 'admin'],
  ['DELETE', '/teams/{team}/report-tokens/{token}', 'admin'],
  ['GET', '/teams/{team}/sinks', 'admin'],
  ['POST', '/teams/{team}/sinks', 'admin'],
  ['DELETE', '/teams/{team}/sinks/{sink}', 'admin'],
  // A person's own email addresses for a team: anyone who can see the team may get its emails (PRD 6.8 O7).
  ['GET', '/teams/{team}/emails', 'viewer'],
  ['POST', '/teams/{team}/emails', 'viewer'],
  ['PATCH', '/teams/{team}/emails/{email}', 'viewer'],
  ['DELETE', '/teams/{team}/emails/{email}', 'viewer'],
  ['POST', '/teams/{team}/emails/{email}/verify', 'viewer'],
  // Slack (CPO story "Slack notifications", D55): anyone who can see the team may link their own Slack for DMs; only
  // owners and admins pick the team's channels.
  ['GET', '/teams/{team}/slack', 'viewer'],
  ['POST', '/teams/{team}/slack/connect', 'viewer'],
  ['POST', '/teams/{team}/slack/link', 'viewer'],
  ['PATCH', '/teams/{team}/slack/me', 'viewer'],
  ['DELETE', '/teams/{team}/slack/me', 'viewer'],
  ['GET', '/teams/{team}/slack/channels', 'admin'],
  ['POST', '/teams/{team}/slack/channels', 'admin'],
  ['PATCH', '/teams/{team}/slack/channels/{channel}', 'admin'],
  ['DELETE', '/teams/{team}/slack/channels/{channel}', 'admin'],
  ['GET', '/secrets', 'admin'],
  ['PUT', '/secrets/{name}', 'admin'],
  ['GET', '/teams/{team}/roles/{role}', 'viewer'],
  ['POST', '/teams/{team}/preview', 'editor'],
  ['POST', '/teams/{team}/publish', 'admin'],
  ['POST', '/teams/{team}/resources', 'admin'],
  ['GET', '/connectors', 'viewer'],
  ['GET', '/me/devices', 'viewer'],
  ['POST', '/me/devices', 'viewer'],
  ['DELETE', '/me/devices/{device}', 'viewer'],
  ['GET', '/members', 'viewer'],
  ['PATCH', '/members/{member}', 'admin'],
  ['DELETE', '/members/{member}', 'admin'],
  ['GET', '/invitations', 'admin'],
  ['POST', '/invitations', 'admin'],
  ['DELETE', '/invitations/{invitation}', 'admin'],
];

const compiled = ROUTES.map(([method, path, role]) => ({ method, role, path, re: new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`) }));

/** The minimum role for a request under /v1 (path without the /v1 prefix), or null when the route is not listed. */
export function minRole(method, path) {
  const p = path.replace(/\/+$/, '') || '/';
  // A literal segment wins over a parameter (/runners/codes before /runners/{runner}).
  const hits = compiled.filter((r) => r.method === method && r.re.test(p));
  if (!hits.length) return null;
  hits.sort((x, y) => (y.path.match(/\{/g)?.length ?? 0) < (x.path.match(/\{/g)?.length ?? 0) ? 1 : -1);
  return hits[0].role;
}
