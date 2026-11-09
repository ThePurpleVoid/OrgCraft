// The issuer's sign-in page (docs/specs/m4-sign-in.md section 2, step 2). The issuer sends a person here with an
// interaction id when they have no session, or with an error code after GitHub. Everything shown comes from a fixed
// list of messages: nothing from the address bar reaches the page as text.
import { esc, githubStart, signInUrl } from './auth.js';

const q = new URLSearchParams(location.search);
const body = document.getElementById('auth-body');
const title = document.getElementById('auth-title');

const MESSAGES = {
  'not-invited': {
    title: 'Ask an owner to invite you',
    // No login from the address bar: anyone can craft this link, so the page names no account (security review, #59).
    text: () => 'The GitHub account you signed in with is not a member of any workspace here, and has no open invitation. Ask an owner of the workspace to invite you, then sign in again. Nothing was created for you.',
  },
  expired: { title: 'That sign-in took too long', text: () => 'The sign-in link expired before it finished. Start again.' },
  denied: { title: 'GitHub did not sign you in', text: () => 'The sign-in was cancelled or refused at GitHub. Start again when you are ready.' },
  'signed-out': { title: 'You are signed out', text: () => 'Your session here has ended. Sign in again to get back to your team.' },
};

const again = `<p><a class="button primary" href="${esc(signInUrl('/'))}">Sign in again</a></p>`;
const err = q.get('error');
const start = githubStart(q.get('interaction'));

if (err && MESSAGES[err]) {
  const m = MESSAGES[err];
  title.textContent = m.title;
  document.title = `${m.title} · OrgCraft Studio`;
  body.innerHTML = `<p>${m.text()}</p>${again}`;
} else if (err) {
  title.textContent = 'Sign-in did not finish';
  body.innerHTML = `<p>Something went wrong while signing you in. Start again.</p>${again}`;
} else if (start) {
  body.innerHTML = `
    <p class="muted">Use your GitHub account. This deployment learns only who you are: it gets no access to your repositories and does not keep your GitHub token.</p>
    <p><a class="button primary github" href="${esc(start)}" id="github">Continue with GitHub</a></p>
    <p class="hint">Only members of a workspace here, and people with an open invitation, can sign in.</p>`;
} else {
  // Opened directly: start the flow, so the issuer hands out a fresh interaction.
  body.innerHTML = `<p class="muted">Sign in to get to your team.</p>${again.replace('Sign in again', 'Sign in')}`;
}
