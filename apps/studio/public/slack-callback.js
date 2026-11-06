// /slack/callback: where Sign in with Slack sends a person back after "Connect Slack" on the Notifications page (CPO
// Slack story, D56). Slack hands back only `code` and `state`; the team was kept in this tab's sessionStorage when the
// person started. The control plane checks the state is this person's and this team's, and that it is under 10
// minutes old, then links their Slack account (POST /v1/teams/{team}/slack/link). Then back to Notifications.
import { call, ensureSignedIn, esc } from './auth.js';

const TEAM = /^[a-z0-9][a-z0-9_-]{0,62}$/i;

/** What the page does with the address Slack sent back: { team, code, state } to link, or { error } to show. */
export function callbackOf(search, storedTeam) {
  const q = new URLSearchParams(search ?? '');
  const team = TEAM.test(storedTeam ?? '') ? storedTeam : null;
  if (q.get('error')) return { team, error: q.get('error') === 'access_denied' ? 'You cancelled the sign-in with Slack. Nothing changed.' : 'Slack did not finish the sign-in. Nothing changed; try again.' };
  if (!team) return { team, error: 'This page does not know which team you were connecting. Open Notifications from the team and choose Connect Slack again.' };
  const code = q.get('code'), state = q.get('state');
  if (!code || !state) return { team, error: 'Slack did not send back what this page needs. Choose Connect Slack again.' };
  return { team, code, state };
}

/** Why linking failed, in words a person can act on. */
export function linkError(status, error) {
  if (status === 410) return 'That took more than 10 minutes. Choose Connect Slack again.';
  if (status === 400) return 'This sign-in with Slack was started somewhere else. Choose Connect Slack again from Notifications.';
  return error || `Slack could not be connected (HTTP ${status}).`;
}

const back = (team) => (team ? `/teams/${encodeURIComponent(team)}/notifications` : '/');

async function start() {
  const root = document.getElementById('slack-callback');
  let stored = null;
  try { stored = sessionStorage.getItem('agent-team-slack-team'); } catch { /* none */ }
  const c = callbackOf(location.search, stored);
  const fail = (text) => {
    document.getElementById('slack-title').textContent = 'Slack is not connected';
    root.innerHTML = `<p class="result error" role="alert">${esc(text)}</p><p><a href="${esc(back(c.team))}">Back to Notifications</a></p>`;
  };
  if (c.error) return fail(c.error);
  const me = await ensureSignedIn();
  if (!me) return;
  // The code works once: take it out of the address bar before anything else can read or reload it.
  history.replaceState(null, '', location.pathname);
  const r = await call('POST', `/v1/teams/${encodeURIComponent(c.team)}/slack/link`, { code: c.code, state: c.state });
  // Kept after a failure, so "Back to Notifications" and a second try know the team; gone once it is linked.
  if (!r.ok) return fail(linkError(r.status, r.data?.error ?? r.data?.title));
  try { sessionStorage.removeItem('agent-team-slack-team'); } catch { /* fine */ }
  const text = r.data.kinds?.length ? `Connected as @${r.data.name || 'you'}.` : `Connected as @${r.data.name || 'you'}. Choose what to get in Slack, then save.`;
  try { sessionStorage.setItem('agent-team-slack-done', JSON.stringify({ team: c.team, text })); } catch { /* the page shows the link anyway */ }
  location.replace(back(c.team));
}

if (globalThis.document?.getElementById('slack-callback')) start().catch((e) => {
  document.getElementById('slack-callback').innerHTML = `<p class="result error" role="alert">${esc(e.message)}</p>`;
});
