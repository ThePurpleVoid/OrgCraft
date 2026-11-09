// Git objects without git: the managed team store's object layer (spec L9 section 3, ADR 0012). Blobs, trees and
// commits are written and read in Git's own format, so a team kept in OrgCraft has real commit SHAs and leaves as a
// standard bundle that plain `git clone` opens. node:crypto and node:zlib only: no child processes (ADR 0008), no
// third-party code.
//
//   hashObject(type, body)                      → sha1 hex of "<type> <len>\0<body>"
//   memoryStore() / store.get|put|has           → the object store interface (framed objects, uncompressed)
//   writeObject(store, type, body) / readObject → put and get, with every read hashed again
//   writeTree(entries) / readTree(body)         → tree bodies; modes 100644, 100755 and 40000 only
//   writeCommit(c) / readCommit(body)           → commit bodies
//   applyChanges(store, baseTree, changes)      → the new root tree, writing only the subtrees that changed
//   reachable(store, wants, haves)              → every object id reachable from wants and not from haves
//   packObjects(store, ids)                     → a version 2 pack of whole (non-delta) objects
//   writeBundle(store, refs)                    → a v2 bundle of everything reachable from refs
//   readBundle(bytes) / importBundle(store, b)  → refs and objects from a bundle, deltas included
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const TYPES = ['commit', 'tree', 'blob', 'tag'];
const PACK_TYPE = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_NAME = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const OFS_DELTA = 6;
const REF_DELTA = 7;
const SHA = /^[0-9a-f]{40}$/;
const FILE_MODES = new Set(['100644', '100755']);
const DIR_MODE = '40000';
/**
 * Size caps (code review L9a sev3): one object at most 20 MB (a team's whole read set is capped at 20 MB, so no file
 * in it is bigger), and a pack or bundle inflates to at most 100 MB in all. Checked before any buffer is allocated
 * or inflated, and again while inflating, so a header that lies can't get past them.
 */
export const MAX_OBJECT = 20 * 1024 * 1024;
export const MAX_PACK_TOTAL = 100 * 1024 * 1024;

const bytes = (v) => (Buffer.isBuffer(v) ? v : v instanceof Uint8Array ? Buffer.from(v) : Buffer.from(String(v), 'utf8'));
const frame = (type, body) => Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);

export class GitStoreError extends Error {
  constructor(message, code = 'invalid') { super(message); this.name = 'GitStoreError'; this.code = code; }
}
const fail = (message, code) => { throw new GitStoreError(message, code); };

/** The object id of a body of the given type. */
export function hashObject(type, body) {
  if (!TYPES.includes(type)) fail(`unknown object type ${type}`);
  return createHash('sha1').update(frame(type, bytes(body))).digest('hex');
}

/** Splits a framed object ("<type> <len>\0<body>") and checks the length. */
export function parseFramed(buf) {
  const nul = buf.indexOf(0);
  const m = nul > 0 ? /^(commit|tree|blob|tag) (\d+)$/.exec(buf.subarray(0, nul).toString('latin1')) : null;
  if (!m || Number(m[2]) !== buf.length - nul - 1) fail('not a git object');
  return { type: m[1], body: buf.subarray(nul + 1) };
}

/**
 * An in-memory store. Every store keeps framed objects ("<type> <len>\0<body>", uncompressed) under their sha;
 * compression and encryption are the backing store's business. Objects are immutable: a second put is a no-op.
 */
export function memoryStore() {
  const m = new Map();
  return {
    get: async (sha) => m.get(sha) ?? null,
    put: async (sha, framed) => { if (!m.has(sha)) m.set(sha, Buffer.from(framed)); },
    has: async (sha) => m.has(sha),
    get size() { return m.size; },
    ids: () => [...m.keys()],
  };
}

export async function writeObject(store, type, body) {
  const b = bytes(body);
  if (b.length > MAX_OBJECT) fail(`an object of ${b.length} bytes is larger than ${MAX_OBJECT}`, 'too-large');
  const sha = hashObject(type, b);
  await store.put(sha, frame(type, b));
  return sha;
}

/** Reads an object and hashes it again: a store that answers with the wrong bytes is caught here. */
export async function readObject(store, sha, want) {
  if (!SHA.test(sha)) fail(`not an object id: ${sha}`);
  const raw = await store.get(sha);
  if (!raw) fail(`missing object ${sha}`, 'missing');
  const buf = bytes(raw);
  if (createHash('sha1').update(buf).digest('hex') !== sha) fail(`object ${sha} does not match its id`, 'corrupt');
  const o = parseFramed(buf);
  if (want && o.type !== want) fail(`object ${sha} is a ${o.type}, not a ${want}`);
  return o;
}

// Trees. Names are single path segments; Git sorts entries as if a directory's name ended in "/".
const checkName = (name) => {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || name.toLowerCase() === '.git' || /[/\0]/.test(name)) fail(`bad tree entry name ${JSON.stringify(name)}`);
};
const sortKey = (e) => Buffer.from(e.mode === DIR_MODE ? `${e.name}/` : e.name, 'utf8');

/** Encodes tree entries [{ mode, name, sha }]. */
export function writeTree(entries) {
  const seen = new Set();
  for (const e of entries) {
    checkName(e.name);
    if (!FILE_MODES.has(e.mode) && e.mode !== DIR_MODE) fail(`mode ${e.mode} is not allowed (regular files and folders only)`);
    if (!SHA.test(e.sha)) fail(`bad object id for ${e.name}`);
    if (seen.has(e.name)) fail(`duplicate tree entry ${e.name}`);
    seen.add(e.name);
  }
  const sorted = [...entries].sort((a, b) => Buffer.compare(sortKey(a), sortKey(b)));
  return Buffer.concat(sorted.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'), Buffer.from(e.sha, 'hex')]));
}

/** Decodes a tree body into [{ mode, name, sha }]. Trees from real Git may carry other modes; they are reported, not refused. */
export function readTree(body) {
  const out = [];
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    const nul = body.indexOf(0, sp);
    if (sp < 0 || nul < 0 || nul + 21 > body.length) fail('truncated tree');
    out.push({ mode: body.subarray(i, sp).toString('latin1'), name: body.subarray(sp + 1, nul).toString('utf8'), sha: body.subarray(nul + 1, nul + 21).toString('hex') });
    i = nul + 21;
  }
  return out;
}

// Commits. A person is { name, email, time (seconds), tz ("+0000") }.
const clean = (s, what) => {
  const v = String(s ?? '').replace(/[<>\n\r\0]/g, '').trim();
  if (!v && what === 'name') fail('a commit needs an author name');
  return v;
};
const person = (p) => {
  const time = Number.isInteger(p?.time) ? p.time : Math.floor(Date.now() / 1000);
  const tz = /^[+-]\d{4}$/.test(p?.tz ?? '') ? p.tz : '+0000';
  return `${clean(p?.name, 'name')} <${clean(p?.email, 'email')}> ${time} ${tz}`;
};
const parsePerson = (s) => {
  const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(s);
  return m ? { name: m[1], email: m[2], time: Number(m[3]), tz: m[4] } : null;
};

/** Encodes a commit: { tree, parents, author, committer, message }. */
export function writeCommit({ tree, parents = [], author, committer = author, message = '' }) {
  if (!SHA.test(tree ?? '')) fail('a commit needs a tree');
  for (const p of parents) if (!SHA.test(p)) fail(`bad parent ${p}`);
  const msg = String(message).replace(/\r/g, '');
  const head = [`tree ${tree}`, ...parents.map((p) => `parent ${p}`), `author ${person(author)}`, `committer ${person(committer)}`];
  return Buffer.from(`${head.join('\n')}\n\n${msg.endsWith('\n') ? msg : `${msg}\n`}`, 'utf8');
}

export function readCommit(body) {
  const text = bytes(body).toString('utf8');
  const split = text.indexOf('\n\n');
  const headers = (split < 0 ? text : text.slice(0, split)).split('\n');
  const c = { tree: null, parents: [], author: null, committer: null, message: split < 0 ? '' : text.slice(split + 2) };
  for (const h of headers) {
    const sp = h.indexOf(' ');
    const k = h.slice(0, sp); const v = h.slice(sp + 1);
    if (k === 'tree') c.tree = v;
    else if (k === 'parent') c.parents.push(v);
    else if (k === 'author') c.author = parsePerson(v);
    else if (k === 'committer') c.committer = parsePerson(v);
  }
  if (!SHA.test(c.tree ?? '')) fail('commit without a tree');
  return c;
}

/** Splits and checks a repository path: no empty, ".", ".." or ".git" segments. */
export function splitPath(path) {
  const parts = String(path).split('/');
  if (!path || path.startsWith('/') || parts.some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git' || p.includes('\0'))) fail(`bad path ${JSON.stringify(path)}`);
  return parts;
}

/**
 * Applies [{ path, mode, content | null }] (null deletes) to baseTree (a tree id, or null for none) and returns the
 * new root tree id. Only the subtrees on a changed path are rewritten. A folder that ends up empty disappears, as in Git.
 */
export async function applyChanges(store, baseTree, changes) {
  const root = { entries: null, tree: baseTree, kids: new Map() };
  const load = async (node) => {
    if (node.entries) return;
    node.entries = new Map();
    if (node.tree) for (const e of readTree((await readObject(store, node.tree, 'tree')).body)) node.entries.set(e.name, e);
  };
  const files = new Map();
  for (const ch of changes) {
    const parts = splitPath(ch.path);
    if (ch.content !== null && ch.content !== undefined && !FILE_MODES.has(ch.mode ?? '100644')) fail(`mode ${ch.mode} is not allowed for ${ch.path}`);
    if (files.has(ch.path)) fail(`${ch.path} is changed twice`);
    files.set(ch.path, ch);
    let node = root;
    for (const seg of parts.slice(0, -1)) {
      await load(node);
      if (!node.kids.has(seg)) {
        const e = node.entries.get(seg);
        if (e && e.mode !== DIR_MODE) fail(`${ch.path}: ${seg} is a file`);
        node.kids.set(seg, { entries: null, tree: e?.sha ?? null, kids: new Map() });
      }
      node = node.kids.get(seg);
    }
    await load(node);
    const name = parts.at(-1);
    if (node.kids.has(name) || node.entries.get(name)?.mode === DIR_MODE) fail(`${ch.path} is a folder`);
    if (ch.content === null || ch.content === undefined) node.entries.delete(name);
    else node.entries.set(name, { mode: ch.mode ?? '100644', name, sha: await writeObject(store, 'blob', ch.content) });
  }
  const finish = async (node) => {
    for (const [name, kid] of node.kids) {
      const sha = await finish(kid);
      if (sha) node.entries.set(name, { mode: DIR_MODE, name, sha }); else node.entries.delete(name);
    }
    if (!node.entries.size) return null;
    return writeObject(store, 'tree', writeTree([...node.entries.values()]));
  };
  await load(root);
  return (await finish(root)) ?? writeObject(store, 'tree', Buffer.alloc(0));
}

/** Lists every file under a tree: [{ path, mode, sha }]. */
export async function listTree(store, tree, prefix = '') {
  const out = [];
  for (const e of readTree((await readObject(store, tree, 'tree')).body)) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === DIR_MODE) out.push(...await listTree(store, e.sha, p));
    else out.push({ path: p, mode: e.mode, sha: e.sha });
  }
  return out;
}

/** Every object id reachable from `wants` (commits) and not from `haves`, parents first is not promised. */
export async function reachable(store, wants, haves = []) {
  const skip = new Set();
  const walk = async (starts, into) => {
    const stack = [...starts];
    while (stack.length) {
      const sha = stack.pop();
      if (into.has(sha) || (into !== skip && skip.has(sha))) continue;
      into.add(sha);
      const o = await readObject(store, sha);
      if (o.type === 'commit') { const c = readCommit(o.body); stack.push(c.tree, ...c.parents); }
      else if (o.type === 'tree') for (const e of readTree(o.body)) { if (e.mode === '160000') fail('submodules are not supported'); stack.push(e.sha); }
    }
  };
  if (haves.length) await walk(haves, skip);
  const out = new Set();
  await walk(wants, out);
  return [...out];
}

// Packs: version 2, whole objects only (no deltas): simple, valid, and small enough at team scale.
const packHeader = (type, size) => {
  const out = [];
  let b = (type << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) { out.push(b | 0x80); b = size & 0x7f; size = Math.floor(size / 128); }
  out.push(b);
  return Buffer.from(out);
};

export async function packObjects(store, ids) {
  const parts = [Buffer.from('PACK'), Buffer.alloc(8)];
  parts[1].writeUInt32BE(2, 0);
  parts[1].writeUInt32BE(ids.length, 4);
  for (const sha of ids) {
    const { type, body } = await readObject(store, sha);
    parts.push(packHeader(PACK_TYPE[type], body.length), deflateSync(body));
  }
  const pack = Buffer.concat(parts);
  return Buffer.concat([pack, createHash('sha1').update(pack).digest()]);
}

/** A v2 bundle of refs { "refs/heads/main": sha } with every object they reach. */
export async function writeBundle(store, refs) {
  const names = Object.keys(refs);
  if (!names.length) fail('a bundle needs at least one ref');
  for (const n of names) if (!/^refs\/[A-Za-z0-9._/-]+$/.test(n) || n.includes('..') || !SHA.test(refs[n])) fail(`bad ref ${n}`);
  const ids = await reachable(store, [...new Set(Object.values(refs))]);
  const head = `# v2 git bundle\n${names.map((n) => `${refs[n]} ${n}\n`).join('')}\n`;
  return Buffer.concat([Buffer.from(head), await packObjects(store, ids)]);
}

// Reading packs from real Git, which writes deltas.
function applyDelta(base, delta, max = MAX_OBJECT) {
  let i = 0;
  const varint = () => { let v = 0; let shift = 0; let b; do { b = delta[i++]; v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80); return v; };
  if (varint() !== base.length) fail('delta base has the wrong size', 'corrupt');
  const size = varint();
  if (size > max) fail(`a delta result of ${size} bytes is larger than ${max}`, 'too-large');
  const out = Buffer.alloc(size);
  let o = 0;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let off = 0; let len = 0;
      for (let k = 0; k < 4; k++) if (op & (1 << k)) off += delta[i++] * 2 ** (8 * k);
      for (let k = 0; k < 3; k++) if (op & (1 << (4 + k))) len += delta[i++] * 2 ** (8 * k);
      if (len === 0) len = 0x10000;
      if (off + len > base.length || o + len > size) fail('delta copies past the end', 'corrupt');
      base.copy(out, o, off, off + len); o += len;
    } else if (op) {
      if (o + op > size || i + op > delta.length) fail('delta inserts past the end', 'corrupt');
      delta.copy(out, o, i, i + op); o += op; i += op;
    } else fail('bad delta opcode', 'corrupt');
  }
  if (o !== size) fail('delta result has the wrong size', 'corrupt');
  return out;
}

/** Parses a version 2 pack into { objects: [{ type, body, sha }], deltas }, resolving deltas. Checks the trailing checksum. */
export function readPack(pack, { maxObject = MAX_OBJECT, maxTotal = MAX_PACK_TOTAL } = {}) {
  if (pack.length < 32 || pack.toString('latin1', 0, 4) !== 'PACK') fail('not a pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) fail(`pack version ${version} is not supported`);
  const body = pack.subarray(0, pack.length - 20);
  if (createHash('sha1').update(body).digest('hex') !== pack.subarray(pack.length - 20).toString('hex')) fail('pack checksum does not match', 'corrupt');
  const count = pack.readUInt32BE(8);
  const byOffset = new Map();
  const bySha = new Map();
  const pending = [];
  let deltas = 0;
  let total = 0;
  let i = 12;
  for (let n = 0; n < count; n++) {
    const start = i;
    let b = pack[i++];
    const type = (b >> 4) & 7;
    let size = b & 0x0f; let shift = 4;
    while (b & 0x80) { b = pack[i++]; size += (b & 0x7f) * 2 ** shift; shift += 7; }
    let ref = null;
    if (type === OFS_DELTA) {
      b = pack[i++]; let off = b & 0x7f;
      while (b & 0x80) { b = pack[i++]; off = (off + 1) * 128 + (b & 0x7f); }
      ref = { offset: start - off };
    } else if (type === REF_DELTA) { ref = { sha: pack.subarray(i, i + 20).toString('hex') }; i += 20; }
    else if (!PACK_NAME[type]) fail(`unknown pack entry type ${type}`, 'corrupt');
    if (i >= body.length) fail('truncated pack', 'corrupt');
    if (size > maxObject) fail(`a pack entry of ${size} bytes is larger than ${maxObject}`, 'too-large');
    if ((total += size) > maxTotal) fail(`the pack holds more than ${maxTotal} bytes`, 'too-large');
    let data, engine;
    // Never inflate past the size the header gave: a lying header fails here, not after the memory is spent.
    try { ({ buffer: data, engine } = inflateSync(pack.subarray(i, body.length), { info: true, maxOutputLength: Math.max(size, 1) })); } catch (e) { fail(`pack entry does not inflate to its size (${String(e?.code ?? e?.message ?? e).slice(0, 60)})`, 'corrupt'); }
    if (data.length !== size) fail('pack entry has the wrong size', 'corrupt');
    i += engine.bytesWritten;
    const entry = { start, type: PACK_NAME[type] ?? null, data, ref };
    if (ref) { pending.push(entry); deltas++; }
    else { entry.body = data; entry.sha = hashObject(entry.type, data); byOffset.set(start, entry); bySha.set(entry.sha, entry); }
  }
  // Resolve deltas in as many passes as their chains need.
  let progress = true;
  while (pending.length && progress) {
    progress = false;
    for (let k = pending.length - 1; k >= 0; k--) {
      const e = pending[k];
      const base = e.ref.sha ? bySha.get(e.ref.sha) : byOffset.get(e.ref.offset);
      if (!base) continue;
      e.type = base.type; e.body = applyDelta(base.body, e.data, maxObject);
      if ((total += e.body.length) > maxTotal) fail(`the pack holds more than ${maxTotal} bytes`, 'too-large');
      e.sha = hashObject(e.type, e.body);
      byOffset.set(e.start, e); bySha.set(e.sha, e);
      pending.splice(k, 1); progress = true;
    }
  }
  if (pending.length) fail('a delta in the pack has no base in it (thin packs are not supported)', 'corrupt');
  return { objects: [...byOffset.values()].sort((a, b) => a.start - b.start).map(({ type, body, sha }) => ({ type, body, sha })), deltas };
}

/** Parses a v2 or v3 bundle: { refs: { name: sha }, objects, deltas }. Bundles that need objects we don't have are refused. */
export function readBundle(buf) {
  const b = bytes(buf);
  const end = b.indexOf('\n\n');
  if (end < 0) fail('not a git bundle');
  const lines = b.subarray(0, end).toString('utf8').split('\n');
  const sig = lines.shift();
  if (sig !== '# v2 git bundle' && sig !== '# v3 git bundle') fail('not a git bundle');
  const refs = {};
  for (const l of lines) {
    if (l.startsWith('@')) { if (!/^@object-format=sha1$/.test(l)) fail(`bundle capability ${l} is not supported`); continue; }
    if (l.startsWith('-')) fail('the bundle is incomplete: it needs history it does not carry (make it with --all or from the first commit)');
    const m = /^([0-9a-f]{40}) (\S+)$/.exec(l);
    if (!m) fail('bad bundle ref line');
    refs[m[2]] = m[1];
  }
  return { refs, ...readPack(b.subarray(end + 2)) };
}

/** Writes a bundle's objects into a store (each hashed again) and checks every ref and everything it reaches is there. */
export async function importBundle(store, buf) {
  const { refs, objects } = readBundle(buf);
  for (const o of objects) await writeObject(store, o.type, o.body);
  const heads = Object.values(refs);
  for (const sha of heads) if (!(await store.has(sha))) fail(`ref target ${sha} is not in the bundle`, 'missing');
  await reachable(store, heads);
  return { refs, count: objects.length };
}
