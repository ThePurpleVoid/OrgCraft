// Passkeys and step-up for signed-in people (docs/specs/m4-sign-in.md section 3, ADR 0007 K2, section 4a S5 and S6).
//
// WebAuthn is @simplewebauthn/server's (K1): this file keeps challenges, credentials and policy. Step-up is only ever
// a single-use su_ token minted from a passkey assertion with user verification; no session or sign-in time counts.
//
//   GET    /v1/me/passkeys              the person's passkeys
//   GET    /v1/me/passkeys/options      registration options (userVerification: required), a 2-minute challenge
//   POST   /v1/me/passkeys              { name, credential } → { id, name, createdAt }. The first one needs a sign-in
//                                       under 5 minutes old; any later one needs step-up
//   DELETE /v1/me/passkeys/{id}         needs step-up
//   GET    /v1/auth/step-up/challenge   authentication options for the person's passkeys, a 2-minute challenge
//   POST   /v1/auth/step-up             { webauthn } → { token: su_…, expires }, bound to the person and the tenant
import { createHash, randomBytes } from 'node:crypto';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { Problem } from './store.mjs';
import { STEP_UP_SCOPE } from './m3.mjs';

const CHALLENGE_SECONDS = 120;
const FIRST_PASSKEY_MS = 5 * 60_000;
const LOCKOUT = { failures: 5, minutes: 15 };
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const rid = (p, n = 12) => `${p}${randomBytes(n).toString('base64url')}`;

export class StepUpNeeded extends Problem {
  constructor(what) { super(401, `${what} needs step-up: confirm with your passkey`, { type: 'step-up-required' }); }
}

/**
 * `origin` is the deployment's public origin (the WebAuthn origin, checked exactly); the rpId is its host name.
 * `m3` mints and spends su_ tokens in a tenant (m3.mintStepUp, m3.requireStepUp).
 */
export function createPasskeys({ db, m3, origin, rpName = 'Agent Team', now = () => new Date() }) {
  const rpID = new URL(origin).hostname;

  const challenges = {
    put: (kind, person, challenge) => db.system('insert into oidc_store(model, id_hash, payload, expires_at) values ($1, $2, $3, $4)',
      ['WebAuthn', sha(challenge), { kind, person }, new Date(Date.now() + CHALLENGE_SECONDS * 1000)]),
    /** Single use: a challenge is gone the moment anyone presents it, right or wrong. */
    take: async (kind, person, challenge) => {
      if (typeof challenge !== 'string' || !challenge || challenge.length > 200) return false;
      const [r] = await db.system("delete from oidc_store where model = 'WebAuthn' and id_hash = $1 and expires_at > now() returning payload", [sha(challenge)]);
      return !!r && r.payload.kind === kind && r.payload.person === person;
    },
  };
  const challengeOf = (cred) => {
    try { return JSON.parse(Buffer.from(String(cred?.response?.clientDataJSON ?? ''), 'base64url').toString('utf8')).challenge; } catch { return null; }
  };
  const audit = (person, action, detail = {}) => db.system('insert into identity_audit(person, action, detail) values ($1, $2, $3)', [person, action, detail]);
  /** A passkey change is also written to the audit log of every workspace the person is in (S5). */
  async function auditWorkspaces(who, action, target) {
    for (const w of who.workspaces ?? []) {
      await db.tenant(w.tenant, ({ q }) => q("insert into audit(tenant, actor_kind, actor_id, action, target, decision) values ($1, 'person', $2, $3, $4, 'allowed')", [w.tenant, who.principal, action, target]));
    }
  }

  const mine = (person) => db.system('select id, name, credential_id, public_key, sign_count, created_at, last_used from passkeys where person = $1 order by created_at', [person]);
  const view = (p) => ({ id: p.id, name: p.name, createdAt: new Date(p.created_at).toISOString(), lastUsed: p.last_used ? new Date(p.last_used).toISOString() : null });

  async function list(who) { return { passkeys: (await mine(who.principal)).map(view) }; }

  async function registrationOptions(who) {
    const options = await generateRegistrationOptions({
      rpName, rpID, userName: who.session.login, userDisplayName: who.session.name ?? who.session.login,
      userID: new TextEncoder().encode(who.principal), attestationType: 'none',
      excludeCredentials: (await mine(who.principal)).map((p) => ({ id: p.credential_id })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      timeout: CHALLENGE_SECONDS * 1000,
    });
    await challenges.put('register', who.principal, options.challenge);
    return options;
  }

  async function register(who, body, stepUp) {
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
    if (!name) throw new Problem(400, 'send { name, credential }: a name the person will recognise ("Dana\'s MacBook")');
    const existing = await mine(who.principal);
    // The very first passkey: a sign-in no older than 5 minutes (the only place auth_time is a gate). Any other: step-up.
    if (existing.length) await requireStepUp(who, stepUp, 'Adding a passkey');
    else if (!who.session.authTime || now().getTime() - Date.parse(who.session.authTime) > FIRST_PASSKEY_MS) throw new Problem(401, 'sign in again to add your first passkey (a sign-in under 5 minutes old)', { type: 'step-up-required' });
    const challenge = challengeOf(body?.credential);
    if (!(await challenges.take('register', who.principal, challenge))) throw new Problem(400, 'that challenge is unknown, used or expired; ask for new options', { type: 'webauthn-failed' });
    let out;
    try {
      out = await verifyRegistrationResponse({ response: body.credential, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
    } catch (e) {
      await audit(who.principal, 'passkey.refused', { reason: String(e.message).slice(0, 200) });
      throw new Problem(400, 'the passkey could not be verified', { type: 'webauthn-failed' });
    }
    if (!out.verified || !out.registrationInfo) throw new Problem(400, 'the passkey could not be verified', { type: 'webauthn-failed' });
    const { credential } = out.registrationInfo;
    const id = rid('pk_');
    const [row] = await db.system('insert into passkeys(id, person, credential_id, public_key, sign_count, name) values ($1, $2, $3, $4, $5, $6) returning created_at',
      [id, who.principal, credential.id, Buffer.from(credential.publicKey).toString('base64url'), credential.counter ?? 0, name]);
    await audit(who.principal, 'passkey.added', { passkey: id, name });
    await auditWorkspaces(who, 'passkey.added', id);
    return { id, name, createdAt: new Date(row.created_at).toISOString() };
  }

  async function remove(who, id, stepUp) {
    const [p] = await db.system('select id from passkeys where id = $1 and person = $2', [id, who.principal]);
    if (!p) throw new Problem(404, 'no such passkey');
    await requireStepUp(who, stepUp, 'Removing a passkey');
    await db.system('delete from passkeys where id = $1 and person = $2', [id, who.principal]);
    await audit(who.principal, 'passkey.removed', { passkey: id });
    await auditWorkspaces(who, 'passkey.removed', id);
    return { ok: true };
  }

  async function challenge(who) {
    const keys = await mine(who.principal);
    if (!keys.length) throw new Problem(409, 'add a passkey first: step-up needs one', { type: 'no-passkey' });
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: keys.map((k) => ({ id: k.credential_id })), timeout: CHALLENGE_SECONDS * 1000 });
    await challenges.put('step-up', who.principal, options.challenge);
    return options;
  }

  /**
   * Trades a passkey assertion for a su_ token. Five failed tries in 15 minutes lock the person out (429); the
   * attempt is counted before it is checked, under a per-person lock, so parallel guesses cannot all slip through.
   */
  async function stepUp(who, assertion, scope = null) {
    if (!who.tenant) throw new Problem(404, 'not found');
    if (scope !== null && (typeof scope !== 'string' || !STEP_UP_SCOPE.test(scope))) throw new Problem(400, 'scope names one change, like resume:<run id>');
    const attempt = await db.systemTx(async ({ q }) => {
      await q('select pg_advisory_xact_lock(4853, hashtext($1))', [who.principal]);
      const [{ n }] = await q("select count(*)::int as n from identity_audit where person = $1 and action = 'step-up.failed' and at > now() - make_interval(mins => $2)", [who.principal, LOCKOUT.minutes]);
      if (n >= LOCKOUT.failures) return null;
      return (await q("insert into identity_audit(person, action, detail) values ($1, 'step-up.failed', $2) returning id", [who.principal, { pending: true }]))[0].id;
    });
    if (attempt === null) {
      await audit(who.principal, 'step-up.locked', {});
      throw new Problem(429, `too many failed step-ups; try again in ${LOCKOUT.minutes} minutes`);
    }
    const fail = async (why, status = 401) => {
      await db.system("update identity_audit set detail = $2 where id = $1", [attempt, { reason: why }]);
      throw new Problem(status, `step-up failed: ${why}`, { type: 'step-up-failed' });
    };
    const ch = challengeOf(assertion);
    if (!(await challenges.take('step-up', who.principal, ch))) return fail('that challenge is unknown, used or expired');
    const [key] = await db.system('select id, credential_id, public_key, sign_count from passkeys where person = $1 and credential_id = $2', [who.principal, String(assertion?.id ?? '')]);
    if (!key) return fail('that is not one of your passkeys');
    let out;
    try {
      // The library's own counter check refuses a counter that does not increase; S6 says log and flag that instead,
      // so it is given 0 and the comparison is made here.
      out = await verifyAuthenticationResponse({ response: assertion, expectedChallenge: ch, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: key.credential_id, publicKey: Buffer.from(key.public_key, 'base64url'), counter: 0 } });
    } catch (e) {
      return fail(String(e.message).slice(0, 200));
    }
    if (!out.verified) return fail('the assertion did not verify');
    const counter = out.authenticationInfo.newCounter;
    if ((counter > 0 || Number(key.sign_count) > 0) && counter <= Number(key.sign_count)) await audit(who.principal, 'passkey.sign-count-flagged', { passkey: key.id, stored: Number(key.sign_count), got: counter });
    await db.system('update passkeys set sign_count = greatest(sign_count, $2), last_used = now() where id = $1', [key.id, counter]);
    await db.system('delete from identity_audit where id = $1', [attempt]);
    if (who.session.session) await db.system('update person_sessions set last_step_up = now(), amr = array(select distinct unnest(amr || $2::text[])) where id_hash = $1', [who.session.session, ['hwk', 'user']]);
    return m3.mintStepUp(who.tenant, who.principal, { method: 'passkey', passkey: key.id }, scope);
  }

  /** A su_ token for this person in this tenant, used up here. */
  async function requireStepUp(who, token, what) {
    if (!who.tenant || !token) throw new StepUpNeeded(what);
    try { return await m3.requireStepUp(who.tenant, who.principal, token, what); } catch (e) { if (e?.type === 'step-up-required') throw new StepUpNeeded(what); throw e; }
  }

  return { list, registrationOptions, register, remove, challenge, stepUp, requireStepUp, rpID };
}
