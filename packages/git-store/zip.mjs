// A small zip writer for the team export (spec L9 section 5.1): stored or deflated entries, no third-party code.
// Entries: [{ name, data, mtime? }]. Names are forward-slash paths inside the archive, never absolute, never "..".
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const dosTime = (d) => {
  const y = Math.max(1980, d.getUTCFullYear());
  return { time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2), date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate() };
};

/** Builds a zip archive in memory. Small files are stored; larger ones deflated when that saves space. */
export function writeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  const names = new Set();
  for (const e of entries) {
    const name = String(e.name);
    if (!name || name.startsWith('/') || name.split('/').some((p) => p === '..' || p === '') || names.has(name)) throw new Error(`bad zip entry name ${JSON.stringify(name)}`);
    names.add(name);
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8');
    const deflated = data.length > 64 ? deflateRawSync(data) : null;
    const useDeflate = deflated && deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const { time, date } = dosTime(e.mtime instanceof Date ? e.mtime : new Date(0));
    const nameBuf = Buffer.from(name, 'utf8');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(useDeflate ? 8 : 0, 8);
    h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28);
    local.push(h, nameBuf, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(0x0314, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(useDeflate ? 8 : 0, 10);
    c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(((e.mode === '100755' ? 0o100755 : 0o100644) << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  if (offset > 0xffffffff || names.size > 0xffff) throw new Error('the export is too large for a zip without zip64');
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(names.size, 8); end.writeUInt16LE(names.size, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
