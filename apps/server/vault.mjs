// Secrets sealed with AES-256-GCM under a master key. Sealed text is "v1.<iv>.<tag>.<ciphertext>" in base64url; the
// tenant and name are bound in as associated data, so a sealed value cannot be moved to another tenant or name.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function masterKey(text) {
  const key = Buffer.from(String(text ?? ''), 'base64');
  if (key.length !== 32) throw new Error('the master key must be 32 bytes, base64 encoded (openssl rand -base64 32)');
  return key;
}

export function seal(key, tenant, name, value) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(`${tenant}/${name}`));
  const body = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), body].map((b) => (typeof b === 'string' ? b : b.toString('base64url'))).join('.');
}

export function unseal(key, tenant, name, sealed) {
  const [v, iv, tag, body] = String(sealed).split('.');
  if (v !== 'v1') throw new Error('unknown sealed format');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(`${tenant}/${name}`));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
}
