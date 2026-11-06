// A software passkey for tests: a P-256 key that answers navigator.credentials.create() and .get() the way a
// platform authenticator does ("none" attestation), in the JSON shapes @simplewebauthn speaks. Knobs let a test send
// what a real authenticator never should: no user verification, another origin or rpId, a counter that goes back.
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';

const sha256 = (b) => createHash('sha256').update(b).digest();
const b64u = (b) => Buffer.from(b).toString('base64url');
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };

/** The little CBOR the attestation needs: unsigned and negative ints, byte and text strings, maps. */
function cbor(v) {
  const head = (major, n) => (n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.concat([Buffer.from([(major << 5) | 25]), u16(n)]));
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new TypeError('cbor: unsupported value');
}

export function authenticator({ origin, rpId }) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { x, y } = publicKey.export({ format: 'jwk' });
  const credId = randomBytes(16);
  const id = b64u(credId);
  let count = 0;
  const flags = (uv) => 0x01 | (uv ? 0x04 : 0);
  return {
    id,
    set counter(n) { count = n; },
    /** navigator.credentials.create(options) → RegistrationResponseJSON. */
    create(options, { uv = true, from = origin, rp = rpId } = {}) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: from, crossOrigin: false }));
      const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(x, 'base64url')], [-3, Buffer.from(y, 'base64url')]]));
      const authData = Buffer.concat([sha256(rp), Buffer.from([flags(uv) | 0x40]), u32(count), Buffer.alloc(16), u16(credId.length), credId, cose]);
      const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return { id, rawId: id, type: 'public-key', response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] }, clientExtensionResults: {}, authenticatorAttachment: 'platform' };
    },
    /** navigator.credentials.get(options) → AuthenticationResponseJSON. The counter goes up by one unless told. */
    get(options, { uv = true, from = origin, rp = rpId, bump = true } = {}) {
      if (bump) count++;
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: from, crossOrigin: false }));
      const authenticatorData = Buffer.concat([sha256(rp), Buffer.from([flags(uv)]), u32(count)]);
      const signature = createSign('SHA256').update(Buffer.concat([authenticatorData, sha256(clientDataJSON)])).sign(privateKey);
      return { id, rawId: id, type: 'public-key', response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authenticatorData), signature: b64u(signature) }, clientExtensionResults: {}, authenticatorAttachment: 'platform' };
    },
  };
}
