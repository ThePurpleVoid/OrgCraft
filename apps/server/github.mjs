// GitHub App installations a workspace has proven it owns (docs/specs/studio-embed.md S9; issues #123 and #139).
//
// The deployment's GitHub App key mints tokens for every installation, that is for every customer. So the hosted
// Studio and the runner only ever use an installation bound here to the tenant, and a binding needs proof:
//
//   POST   /v1/github/installations           admin + step-up: { url, expiresIn }, the app's install page with a
//                                             signed, single-use, ten-minute state
//   (GitHub)                                  the admin installs the app; with "Request user authorization (OAuth)
//                                             during installation" on, GitHub sends them back to the app's callback
//                                             URL, /oauth/callback/github, with a user code, the installation id,
//                                             setup_action and our state
//   GET    /oauth/callback/github?installation_id=…&setup_action=…   identity.mjs hands it here. As that person, with
//                                             the user code, GitHub must say: they are the same GitHub user the state
//                                             names (people.subject); the installation is in /user/installations and
//                                             not suspended; they administer its account (their own user, or an
//                                             active admin of the organization); and they can push to every repository
//                                             the installation holds. The user token is revoked once read.
//   GET    /v1/github/installations           admin: the bindings
//   DELETE /v1/github/installations/{id}      admin + step-up: unbind
//   POST   /v1/github/webhook                 GitHub's signed webhook (GITHUB_WEBHOOK_SECRET): an installation
//                                             deleted or suspended is unbound; a reinstall must be proven again
//
// An installation is bound to one tenant at most (unique installation_id). Every step lands in identity_audit.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Problem } from './store.mjs';

export const STATE_SECONDS = 600;
export const GITHUB_SLUG = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const MAX_PAGES = 30;
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

/** owner/name of a github.com repository URL (https, ssh:// or git@github.com:), or null for anything else. */
export function repoSlug(url) {
  if (typeof url !== 'string' || url.length > 500) return null;
  const m = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

const ownerOf = (slug) => slug.split('/')[0].toLowerCase();

/**
 * `upstream` is identity.mjs's githubUpstream (installer() trades an install code for a short-lived user session);
 * `appSlug` the app's URL name (github.com/apps/<slug>); `webhookSecret` GitHub's webhook secret, or null.
 * Enabled only with sign-in on and an app slug, so local mode is unchanged.
 */
export function createInstallations({ db, key, tenant, upstream = null, appSlug = null, webhookSecret = null, url = 'https://github.com', now = () => new Date() }) {
  const enabled = Boolean(upstream?.installer && appSlug && /^[a-z0-9-]{1,100}$/i.test(appSlug));
  const base = String(url).replace(/\/+$/, '');
  const macKey = createHmac('sha256', key).update('agent-team github install state v1').digest();
  const mac = (t, person, nonce) => createHmac('sha256', macKey).update(`${t}\n${person}\n${nonce}`).digest('base64url');
  const audit = (person, action, detail) => db.system('insert into identity_audit(person, action, detail) values ($1, $2, $3)', [person, action, detail]);
  const off = () => { if (!enabled) throw new Problem(404, 'GitHub App installations need sign-in and GITHUB_APP_SLUG on this deployment'); };

  /** The ids bound to the tenant whose account is the repository's owner, or [] (studio.mjs and the runner). */
  async function forOwner(t, owner) {
    return (await db.system('select installation_id from github_installations where tenant = $1 and lower(account_login) = $2 order by installation_id', [t, owner]))
      .map((r) => Number(r.installation_id));
  }

  /** Proves an installation as the person the state names, or returns why not. Never throws on GitHub's answers. */
  async function prove(st, installationId, code) {
    const [p] = await db.system(`select p.id, p.subject, m.role from people p join members m on m.person = p.id and m.tenant = $2 and m.removed_at is null
      where p.id = $1`, [st.person, st.tenant]);
    if (!p || !['owner', 'admin'].includes(p.role)) return { why: 'not-admin' };
    let gh;
    try { gh = await upstream.installer({ code }); } catch { return { why: 'denied' }; }
    try {
      if (gh.subject !== p.subject) return { why: 'other-user', login: gh.login };
      const pages = async (path, field) => {
        const out = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
          const r = await gh.get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
          const list = r?.[field];
          if (!Array.isArray(list)) throw new Error('GitHub did not answer');
          out.push(...list);
          if (list.length < 100) return out;
        }
        throw new Error('too many to check');
      };
      const install = (await pages('/user/installations', 'installations')).find((i) => Number(i?.id) === installationId);
      if (!install) return { why: 'not-listed', login: gh.login };
      if (install.app_slug && String(install.app_slug).toLowerCase() !== appSlug.toLowerCase()) return { why: 'not-listed', login: gh.login };
      if (install.suspended_at) return { why: 'suspended', login: gh.login };
      const acc = install.account ?? {};
      if (typeof acc.login !== 'string' || !Number.isSafeInteger(acc.id) || !['User', 'Organization'].includes(acc.type)) return { why: 'not-listed', login: gh.login };
      if (acc.type === 'User' && String(acc.id) !== gh.subject) return { why: 'not-account-admin', login: gh.login, account: acc.login };
      if (acc.type === 'Organization') {
        const mem = await gh.get(`/user/memberships/orgs/${encodeURIComponent(acc.login)}`);
        if (mem?.state !== 'active' || mem?.role !== 'admin') return { why: 'not-account-admin', login: gh.login, account: acc.login };
      }
      const repos = await pages(`/user/installations/${installationId}/repositories`, 'repositories');
      const weak = repos.filter((r) => !(r?.permissions?.admin || r?.permissions?.push)).map((r) => String(r?.full_name ?? '?'));
      if (weak.length) return { why: 'no-push', login: gh.login, account: acc.login, repos: weak.slice(0, 10) };
      return { ok: true, login: gh.login, account: acc, repos: repos.length };
    } catch { return { why: 'github', login: gh.login }; } finally { await gh.drop().catch(() => {}); }
  }

  const SAYS = {
    'expired': 'This link has expired or was already used. Start again from the Studio: Settings, Connect GitHub.',
    'no-code': 'GitHub did not send a sign-in code. In the GitHub App\'s settings, turn on "Request user authorization (OAuth) during installation", then start again.',
    'not-admin': 'Only an owner or admin of the workspace can connect GitHub.',
    'denied': 'GitHub did not accept the code. Start again.',
    'other-user': 'You installed the app as a different GitHub user than the one you sign in with here.',
    'not-listed': 'GitHub does not list that installation for you.',
    'suspended': 'That installation is suspended on GitHub. Unsuspend it, then start again.',
    'not-account-admin': 'You need to be an admin of the GitHub account the app is installed on.',
    'no-push': 'You need write access to every repository the app is installed on.',
    'github': 'GitHub did not answer. Try again in a minute.',
    'taken': 'That installation is already connected to another workspace. Disconnect it there first.',
  };

  return {
    enabled,

    /** POST /v1/github/installations: the install page with a signed state for this person. */
    async start(t, person) {
      off();
      if (t !== tenant) throw new Problem(400, 'GitHub installations belong to this deployment\'s workspace');
      const nonce = randomBytes(24).toString('base64url');
      await db.system('delete from github_install_states where expires_at < now() - interval \'1 day\'');
      await db.system('insert into github_install_states(hash, tenant, person, expires_at) values ($1, $2, $3, $4)',
        [sha(nonce), t, person, new Date(now().getTime() + STATE_SECONDS * 1000)]);
      const state = `${nonce}.${mac(t, person, nonce)}`;
      return { url: `${base}/apps/${encodeURIComponent(appSlug)}/installations/new?state=${encodeURIComponent(state)}`, expiresIn: STATE_SECONDS };
    },

    /**
     * The install callback (identity.mjs routes /oauth/callback/github here when it carries setup_action). Returns
     * { ok, message } for the page; never throws on what GitHub or the browser sent.
     */
    async callback(params) {
      const action = params.get('setup_action');
      const raw = params.get('state') ?? '';
      const installationId = Number(params.get('installation_id'));
      if (!enabled) return { ok: false, message: 'GitHub installations are not set up on this deployment.' };
      // A change of repositories on GitHub (setup_action=update) brings no state: the binding stays as it was, and
      // studio.mjs and the runner check the installation fresh anyway.
      if (action === 'update' && !raw) return { ok: true, message: 'GitHub saved the change. Nothing else to do here.' };
      const [nonce, sig] = raw.split('.');
      if (!nonce || !sig || !/^[A-Za-z0-9_-]{20,64}$/.test(nonce)) return { ok: false, message: SAYS.expired };
      const [row] = await db.system('select tenant, person from github_install_states where hash = $1', [sha(nonce)]);
      if (!row || !same(sig, mac(row.tenant, row.person, nonce))) return { ok: false, message: SAYS.expired };
      const [st] = await db.system('update github_install_states set used_at = now() where hash = $1 and used_at is null and expires_at > now() returning tenant, person', [sha(nonce)]);
      if (!st) return { ok: false, message: SAYS.expired };
      if (!['install', 'update'].includes(action) || !Number.isSafeInteger(installationId) || installationId <= 0) return { ok: false, message: SAYS.expired };
      const code = params.get('code');
      if (!code) { await audit(st.person, 'github.installation.refused', { installation: installationId, why: 'no-code' }); return { ok: false, message: SAYS['no-code'] }; }
      const r = await prove(st, installationId, code);
      if (!r.ok) {
        await audit(st.person, 'github.installation.refused', { installation: installationId, why: r.why, ...(r.login ? { github: r.login } : {}), ...(r.account ? { account: r.account } : {}), ...(r.repos ? { repos: r.repos } : {}) });
        return { ok: false, message: SAYS[r.why] ?? SAYS.github };
      }
      const [b] = await db.system(`insert into github_installations(installation_id, tenant, account_login, account_id, account_type, proven_by, github_login, method)
        values ($1, $2, $3, $4, $5, $6, $7, 'install-callback')
        on conflict (installation_id) do update set account_login = excluded.account_login, account_id = excluded.account_id, account_type = excluded.account_type,
          proven_by = excluded.proven_by, github_login = excluded.github_login, proven_at = now()
        where github_installations.tenant = excluded.tenant returning installation_id`,
      [installationId, st.tenant, r.account.login, r.account.id, r.account.type, st.person, r.login]);
      if (!b) {
        await audit(st.person, 'github.installation.refused', { installation: installationId, why: 'taken', github: r.login, account: r.account.login });
        return { ok: false, message: SAYS.taken };
      }
      await audit(st.person, 'github.installation.bound', { installation: installationId, account: r.account.login, accountType: r.account.type, github: r.login, repos: r.repos });
      return { ok: true, message: `Connected: the GitHub App on ${r.account.login} now works for this workspace.` };
    },

    async list(t) {
      // proverLeft (security review of #148): the person who proved it is no longer an owner or admin here. The
      // binding still works (the app is installed on the account either way); the Studio shows it so an admin can
      // prove it again or disconnect it.
      const rows = await db.system(`select g.*, exists (select 1 from members m where m.tenant = g.tenant and m.person = g.proven_by and m.removed_at is null
          and m.role in ('owner', 'admin')) as prover_here
        from github_installations g where g.tenant = $1 order by g.proven_at, g.installation_id`, [t]);
      return { installations: rows.map((r) => ({ id: Number(r.installation_id), account: r.account_login, accountType: r.account_type, provenBy: r.proven_by, githubLogin: r.github_login, provenAt: new Date(r.proven_at).toISOString(), method: r.method, proverLeft: !r.prover_here })) };
    },

    async unbind(t, id, by) {
      const n = Number(id);
      if (!Number.isSafeInteger(n) || n <= 0) throw new Problem(404, 'no such installation');
      const [r] = await db.system('delete from github_installations where installation_id = $1 and tenant = $2 returning account_login', [n, t]);
      if (!r) throw new Problem(404, 'no such installation');
      await audit(by, 'github.installation.unbound', { installation: n, account: r.account_login, why: 'admin' });
      return { ok: true };
    },

    /** POST /v1/github/webhook: GitHub's signed delivery. Returns { status, body }. */
    async webhook(rawBody, headers) {
      if (!webhookSecret) throw new Problem(404, 'not found');
      const sig = String(headers['x-hub-signature-256'] ?? '');
      const want = `sha256=${createHmac('sha256', webhookSecret).update(rawBody).digest('hex')}`;
      if (!same(sig, want)) throw new Problem(401, 'bad signature', { type: 'unauthenticated' });
      let p; try { p = JSON.parse(rawBody.toString('utf8')); } catch { throw new Problem(400, 'not JSON'); }
      const event = String(headers['x-github-event'] ?? '');
      const id = Number(p?.installation?.id);
      if (!Number.isSafeInteger(id) || id <= 0) return { ok: true, ignored: true };
      if (event === 'installation' && ['deleted', 'suspend'].includes(p.action)) {
        const gone = await db.system('delete from github_installations where installation_id = $1 returning tenant, account_login', [id]);
        for (const g of gone) await audit(null, 'github.installation.unbound', { installation: id, tenant: g.tenant, account: g.account_login, why: p.action === 'deleted' ? 'uninstalled' : 'suspended' });
        return { ok: true, unbound: gone.length };
      }
      // A renamed account keeps its installation; repositories are then named by the new login.
      if (event === 'installation_target' && p.action === 'renamed' && typeof p.account?.login === 'string') {
        await db.system('update github_installations set account_login = $2 where installation_id = $1', [id, p.account.login.slice(0, 100)]);
        return { ok: true };
      }
      return { ok: true, ignored: true };
    },

    /** The bound installation ids of a tenant (studio.mjs). */
    async bound(t) {
      return (await db.system('select installation_id from github_installations where tenant = $1', [t])).map((r) => Number(r.installation_id));
    },

    /** The team's repository, owner/name, only when its owner is an account the tenant has proven (studio.mjs). */
    async teamRepo(t, team) {
      const [r] = await db.system('select repo from teams where id = $1 and tenant = $2', [team, t]);
      if (!r?.repo || !GITHUB_SLUG.test(r.repo)) return null;
      return (await forOwner(t, ownerOf(r.repo))).length ? r.repo : null;
    },

    /**
     * For a run's repository: null when it is not on github.com (nothing to bind), else the bound installation ids of
     * its owner, possibly [] (the run is then refused while installations are enabled).
     */
    async forRepo(t, repoUrl) {
      const slug = repoSlug(repoUrl);
      return slug ? forOwner(t, ownerOf(slug)) : null;
    },
  };
}
