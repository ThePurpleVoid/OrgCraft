// F-B5 (reviews/F-B5-design.md): in local mode the operator names the GitHub App installation the runner may push,
// open and merge pull requests through. There is no proof of it to make: the operator is the owner, the same trust as
// the deploy key and the model key. The boundary is here, at start-up, where the mode is defined: a pin is refused
// with a database (hosted, self-hosted) or with sign-in on. The runner still asks GitHub which installation each
// repository is under before every write and refuses unless it is this one; session.start carries nothing new.
import { GITHUB_SLUG, repoSlug } from './github.mjs';

/** Sign-in is on: the one predicate that turns identity on in bin.mjs, and the one the pin's guard uses (security). */
export const signInOn = (env) => Boolean(env.GITHUB_APP_CLIENT_ID);

const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|localhost)$/i;

/**
 * The installation pinned by AGENT_TEAM_GITHUB_INSTALLATION_ID, or null when it is not set. Throws an Error whose
 * message bin.mjs prints before exiting 2. AGENT_TEAM_GITHUB_REPOS (optional, "owner/name,owner/name") narrows it to
 * those repositories: for any other, installationsFor answers none and the runner refuses as it does today.
 */
export function installationPin(env, { host = '127.0.0.1', tenant = 'local' } = {}) {
  const pinned = env.AGENT_TEAM_GITHUB_INSTALLATION_ID;
  if (pinned === undefined || pinned === '') {
    if (env.AGENT_TEAM_GITHUB_REPOS) throw new Error('AGENT_TEAM_GITHUB_REPOS narrows AGENT_TEAM_GITHUB_INSTALLATION_ID; set both or neither');
    return null;
  }
  if (env.DATABASE_URL || signInOn(env)) throw new Error('AGENT_TEAM_GITHUB_INSTALLATION_ID is for local mode only (no DATABASE_URL, no sign-in); remove it');
  if (!/^[1-9]\d{0,15}$/.test(pinned)) throw new Error('AGENT_TEAM_GITHUB_INSTALLATION_ID must be a GitHub installation id (a number)');
  let repos = null;
  if (env.AGENT_TEAM_GITHUB_REPOS) {
    repos = String(env.AGENT_TEAM_GITHUB_REPOS).split(',').map((s) => s.trim()).filter(Boolean);
    if (!repos.length || repos.some((r) => !GITHUB_SLUG.test(r))) throw new Error('AGENT_TEAM_GITHUB_REPOS is a comma-separated list of owner/name');
    repos = new Set(repos.map((r) => r.toLowerCase()));
  }
  const id = Number(pinned);
  const warnings = ['Install the GitHub App on selected repositories only: any repository it covers can be written to by a run that names it.'];
  if (!LOOPBACK.test(host)) warnings.push(`this server listens on ${host}, not loopback, while a GitHub installation is pinned: anyone on the network with the admin token can make the team push. Use --host 127.0.0.1`);
  return {
    id, repos: repos ? [...repos].sort() : null, warnings,
    installationsFor: async (t, url) => {
      if (t !== tenant) return [];
      const slug = repoSlug(url)?.toLowerCase();
      return slug && (!repos || repos.has(slug)) ? [id] : [];
    },
  };
}
