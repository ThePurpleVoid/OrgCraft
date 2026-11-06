// An app's access token on /v1 (docs/specs/m4-sign-in.md section 2, S3): `Authorization: DPoP <token>` with a
// `DPoP` proof signed by the device key the token is bound to (RFC 9449). The token itself is oidc-provider's
// (AccessToken.find); the proof is checked here with jose, the library oidc-provider uses for its own DPoP checks,
// and the same rules: typ dpop+jwt, an asymmetric alg, the method and URL of this request, a fresh iat, ath of this
// token, the key's thumbprint equal to the token's jkt, and a jti never seen before (kept 5 minutes).
import { createHash } from 'node:crypto';
import { EmbeddedJWK, calculateJwkThumbprint, decodeProtectedHeader, jwtVerify } from 'jose';
import { Problem } from './store.mjs';

// The algorithms the issuer accepts for DPoP (identity.mjs dPoP), no wider.
const ALGS = ['ES256', 'EdDSA'];
const PRIVATE = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth'];
const IAT_SKEW = 60;
const JTI_SECONDS = 300;
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const unauthorized = (why) => new Problem(401, `app token refused: ${why}`, { type: 'unauthenticated' });

/** The `htu` a proof must name: the deployment's origin and this path, no query or fragment (RFC 9449 4.3). */
export const htuOf = (origin, path) => `${origin}${path}`;

/**
 * Checks a request's app credentials. Returns { person, client, grant } or throws 401. `provider` is the live
 * oidc-provider; `origin` the deployment's public origin; `db` keeps used jtis.
 */
export async function appCaller({ db, provider, origin, now = () => new Date() }, req, path) {
  const auth = /^DPoP ([A-Za-z0-9._~+/-]+=*)$/.exec(req.headers.authorization ?? '');
  if (!auth) throw unauthorized('send Authorization: DPoP <access token> and a DPoP proof');
  const token = auth[1];
  const proof = req.headers.dpop;
  if (typeof proof !== 'string' || !proof || proof.length > 8192) throw unauthorized('a DPoP proof is required');
  const at = await provider.AccessToken.find(token);
  if (!at || at.isExpired) throw unauthorized('the token is unknown, expired or revoked');
  if (!at.jkt) throw unauthorized('only device-bound tokens are accepted');
  let header, payload;
  try {
    // A proof carries the device's public key only; a key with private members is refused outright.
    const jwk = decodeProtectedHeader(proof).jwk;
    if (!jwk || typeof jwk !== 'object' || PRIVATE.some((k) => k in jwk)) throw new Error('jwk');
    ({ protectedHeader: header, payload } = await jwtVerify(proof, EmbeddedJWK, { algorithms: ALGS, typ: 'dpop+jwt' }));
  } catch { throw unauthorized('the DPoP proof did not verify'); }
  const t = Math.floor(now().getTime() / 1000);
  if (typeof payload.iat !== 'number' || Math.abs(t - payload.iat) > IAT_SKEW) throw unauthorized('the DPoP proof is not fresh');
  if (typeof payload.jti !== 'string' || !payload.jti || payload.jti.length > 200) throw unauthorized('the DPoP proof has no jti');
  if (payload.htm !== req.method) throw unauthorized('the DPoP proof is for another method');
  if (payload.htu !== htuOf(origin, path)) throw unauthorized('the DPoP proof is for another URL');
  if (payload.ath !== createHash('sha256').update(token).digest('base64url')) throw unauthorized('the DPoP proof is for another token');
  if ((await calculateJwkThumbprint(header.jwk)) !== at.jkt) throw unauthorized('the DPoP proof is signed by another key');
  // Single use: a proof replayed within its window is refused (the insert wins once).
  const fresh = await db.system(`insert into oidc_store(model, id_hash, payload, expires_at) values ('DPoPJti', $1, '{}', $2)
    on conflict do nothing returning id_hash`, [sha(`${at.jkt}:${payload.jti}`), new Date(now().getTime() + JTI_SECONDS * 1000)]);
  if (!fresh.length) throw unauthorized('that DPoP proof was used already');
  return { person: at.accountId, client: at.clientId, grant: at.grantId };
}
