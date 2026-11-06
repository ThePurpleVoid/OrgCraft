// The secret scan the runner runs before anything leaves a working copy (commits, pushes) and on the memory file
// before it goes to the control plane. A hit stops the push; it is a net, not a guarantee.
const NAMES = [/(^|\/)\.env(\.[^/]*)?$/i, /\.pem$/i, /\.p12$/i, /\.pfx$/i, /\.key$/i, /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, /(^|\/)credentials[^/]*$/i, /(^|\/)\.npmrc$/i, /(^|\/)\.netrc$/i, /(^|\/)\.git-credentials$/i];
const ALLOW_NAMES = [/\.env\.(example|sample|template)$/i, /id_\w+\.pub$/i];
export const PATTERNS = [
  ['runner key', /\brnr_[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{32,}/],
  ['anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['github token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['aws access key', /\b(AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['stripe key', /\b[rs]k_live_[A-Za-z0-9]{16,}/],
  ['google key', /\bAIza[0-9A-Za-z_-]{35}\b/],
];

/** Returns a list of hits ("path: kind"), empty when clean. `values` are exact strings that must never appear. */
export function findSecrets({ files = [], text = null, values = [] }) {
  const hits = [];
  const exact = values.filter((v) => typeof v === 'string' && v.length >= 8);
  const scan = (where, body) => {
    for (const [kind, re] of PATTERNS) if (re.test(body)) hits.push(`${where}: ${kind}`);
    for (const v of exact) if (body.includes(v)) hits.push(`${where}: a session credential`);
  };
  for (const f of files) {
    if (NAMES.some((re) => re.test(f.path)) && !ALLOW_NAMES.some((re) => re.test(f.path))) hits.push(`${f.path}: a file that usually holds secrets`);
    if (f.text) scan(f.path, f.text);
  }
  if (text !== null) scan('memory', text);
  return hits;
}

/** The same text with every hit replaced, for things that must still be sent (the memory file). */
export function redactSecrets(text, values = []) {
  let out = String(text);
  for (const [, re] of PATTERNS) out = out.replace(new RegExp(re.source, 'g'), '[redacted]');
  for (const v of values.filter((x) => typeof x === 'string' && x.length >= 8)) out = out.split(v).join('[redacted]');
  return out;
}
