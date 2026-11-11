// Export targets (L9e; spec L9 section 5.2): the storage connectors a standing export writes its zip to, behind the
// connector interface (docs/contracts/connectors.md, capability `export`). Each one is a connector/1 manifest plus two
// pure functions the gateway's put-file effect calls (gateway.mjs putFile):
//
//   where(target)                              -> the parsed place to write, or throws a readable Error
//   put({ secret, where, name, bytes, send })  -> { id }   (send is the gateway's paced fetch, limited to `hosts`)
//
// The secret is the credential's value, released by the vault to the gateway for this one write (purpose
// standing-export); a target never stores it, never logs it, and never puts it in an error. Errors name what went
// wrong in the service's words, without the value or the request.
//
// Credential values (what an admin pastes in Add a credential; JSON):
//   google-drive  { "client_id", "client_secret", "refresh_token" }  (OAuth client with the drive.file scope), or a
//                 bare access token for a one-off test. Target: a folder id, or the folder's drive.google.com link.
//   s3            { "accessKeyId", "secretAccessKey", "region", "sessionToken"? }  (an IAM key that may s3:PutObject
//                 on the bucket). Target: "bucket/optional/prefix" or "s3://bucket/optional/prefix". AWS only: no
//                 custom endpoint, so a credential can never point the gateway at a host of its choosing.
import { createHash, createHmac } from 'node:crypto';

/** Storage services a standing export can write to (the vault's service names). */
export const EXPORT_SERVICES = new Set(['google-drive', 's3']);

const sha256hex = (b) => createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => createHmac('sha256', k).update(s).digest();

/** A credential value as JSON, without ever echoing it (JSON.parse's own message quotes the input). */
function parseValue(secret, what) {
  try {
    const v = JSON.parse(secret);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch { /* fall through */ }
  throw new Error(`the ${what} credential is not the JSON this connector expects; add it again in Settings`);
}

/** The service's own error words, short and on one line (never the request, which may carry the secret). */
async function said(res) {
  let t = '';
  try { t = await res.text(); } catch { /* no body */ }
  let msg = '';
  try { const b = JSON.parse(t); msg = b?.error?.message ?? b?.error_description ?? (typeof b?.error === 'string' ? b.error : '') ?? ''; } catch { msg = /<Code>([^<]{1,80})<\/Code>/.exec(t)?.[1] ?? ''; }
  return `HTTP ${res.status}${msg ? `: ${String(msg).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
}

// ---- Google Drive -----------------------------------------------------------------------------------------------

const DRIVE_FOLDER = /^[A-Za-z0-9_-]{10,200}$/;

const googleDrive = {
  manifest: {
    schema: 'connector/1', id: 'google-drive', name: 'Google Drive', version: '1.0.0', types: ['google-drive'],
    auth: { kind: 'oauth', secrets: [] },
    capabilities: { export: { putFile: true, target: 'a folder id or link' } },
    permissions: { read: [], write: [], deploy: [] },
  },
  hosts: ['oauth2.googleapis.com', 'www.googleapis.com'],
  where(target) {
    const t = String(target ?? '').trim();
    const link = /^https:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]+)/.exec(t);
    const folder = link ? link[1] : t;
    if (!DRIVE_FOLDER.test(folder)) throw new Error('the target is not a Google Drive folder id or folder link');
    return { folder };
  },
  async put({ secret, where, name, bytes, send }) {
    let token = String(secret ?? '').trim();
    if (token.startsWith('{')) {
      const v = parseValue(token, 'Google Drive');
      if (![v.client_id, v.client_secret, v.refresh_token].every((x) => typeof x === 'string' && x)) throw new Error('the Google Drive credential needs client_id, client_secret and refresh_token');
      const res = await send('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: v.client_id, client_secret: v.client_secret, refresh_token: v.refresh_token }).toString(),
      });
      if (!res.ok) throw new Error(`Google refused the sign-in (${await said(res)})`);
      const b = await res.json().catch(() => ({}));
      if (typeof b.access_token !== 'string' || !b.access_token) throw new Error('Google answered the sign-in without a token');
      token = b.access_token;
    }
    if (!token || /\s/.test(token)) throw new Error('the Google Drive credential is empty or malformed');
    const boundary = `orgcraft-${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}`;
    const meta = JSON.stringify({ name, parents: [where.folder], mimeType: 'application/zip' });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: application/zip\r\n\r\n`),
      bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await send('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}`, 'content-length': String(body.length) }, body,
    });
    if (!res.ok) throw new Error(`Google Drive refused the file (${await said(res)})`);
    const b = await res.json().catch(() => ({}));
    return { id: String(b.id ?? '').slice(0, 200) };
  },
};

// ---- Amazon S3 --------------------------------------------------------------------------------------------------

const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
const PREFIX = /^[A-Za-z0-9!_.*'()\/ -]{0,200}$/;
/** S3's URI encoding for a key: every byte but unreserved characters, and '/' kept between segments. */
const s3Path = (key) => key.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

/**
 * AWS Signature Version 4 for one request (pure; tested against AWS's published example). Headers are lower-case;
 * every header given is signed. Answers the Authorization header's value.
 */
export function sigV4({ method, host, path, query = '', headers, payloadHash, accessKeyId, secretAccessKey, region, service = 's3', amzDate }) {
  const day = amzDate.slice(0, 8);
  const all = Object.fromEntries(Object.entries({ host, ...headers }).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const names = Object.keys(all).sort();
  const canonHeaders = names.map((k) => `${k}:${all[k]}\n`).join('');
  const signed = names.join(';');
  const canonical = [method, path, query, canonHeaders, signed, payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
}

const s3 = {
  manifest: {
    schema: 'connector/1', id: 's3', name: 'Amazon S3', version: '1.0.0', types: ['s3'],
    auth: { kind: 'api-key', secrets: [] },
    capabilities: { export: { putFile: true, target: 'bucket/prefix' } },
    permissions: { read: [], write: [], deploy: [] },
  },
  // Virtual-hosted style only: <bucket>.s3.<region>.amazonaws.com (the gateway checks the host against this).
  hosts: [/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.s3\.[a-z]{2}(?:-[a-z]+)+-\d{1,2}\.amazonaws\.com$/],
  where(target) {
    const t = String(target ?? '').trim().replace(/^s3:\/\//, '');
    const [bucket, ...rest] = t.split('/');
    const prefix = rest.filter(Boolean).join('/');
    if (!BUCKET.test(bucket ?? '')) throw new Error('the target is not an S3 bucket name (lowercase letters, digits and hyphens), optionally followed by /prefix');
    if (!PREFIX.test(prefix) || prefix.split('/').some((s) => s === '.' || s === '..')) throw new Error('the S3 prefix has characters a key cannot have');
    return { bucket, prefix };
  },
  async put({ secret, where, name, bytes, send, now = new Date() }) {
    const v = parseValue(secret, 'S3');
    const { accessKeyId, secretAccessKey, region, sessionToken } = v;
    if (typeof accessKeyId !== 'string' || !/^[A-Z0-9]{16,128}$/.test(accessKeyId) || typeof secretAccessKey !== 'string' || !secretAccessKey) throw new Error('the S3 credential needs accessKeyId and secretAccessKey');
    if (typeof region !== 'string' || !REGION.test(region)) throw new Error('the S3 credential needs its bucket\'s region, like us-east-1');
    const host = `${where.bucket}.s3.${region}.amazonaws.com`;
    const key = where.prefix ? `${where.prefix}/${name}` : name;
    const path = `/${s3Path(key)}`;
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const payloadHash = sha256hex(bytes);
    const headers = { 'content-type': 'application/zip', 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...(typeof sessionToken === 'string' && sessionToken ? { 'x-amz-security-token': sessionToken } : {}) };
    const authorization = sigV4({ method: 'PUT', host, path, headers, payloadHash, accessKeyId, secretAccessKey, region, amzDate });
    const res = await send(`https://${host}${path}`, { method: 'PUT', headers: { ...headers, 'content-length': String(bytes.length), authorization }, body: bytes });
    if (!res.ok) throw new Error(`S3 refused the file (${await said(res)})`);
    return { id: `s3://${where.bucket}/${key}`.slice(0, 300), etag: String(res.headers?.get?.('etag') ?? '').replace(/"/g, '').slice(0, 80) };
  },
};

/** The export connectors by service name. */
export const EXPORT_CONNECTORS = Object.freeze({ 'google-drive': googleDrive, s3 });

/** Is `url` one of the connector's own hosts (https only)? */
export function allowedHost(connector, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  return connector.hosts.some((h) => (typeof h === 'string' ? h === u.hostname : h.test(u.hostname)));
}
