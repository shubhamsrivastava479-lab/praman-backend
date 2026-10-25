// Facts read straight out of a stored file. No AI and no guessing:
//   - sha256: the exact fingerprint of the bytes (same file anywhere = same value)
//   - PDF: Producer / Creator, created and modified dates, how many times it was saved
//   - JPEG photo: camera make and model, editing software, date taken, GPS
// Recorded when a file is saved (storage.saveFile), and for older files by a slow
// background job. Kept in db.data.fileFacts, one record per stored file URL.
const crypto = require('crypto');
const fs = require('fs');

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const idFor = url => 'ff_' + crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 24);

// ---- PDF ----
function pdfDate(s) {
  const m = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s || '');
  if (!m) return null;
  const iso = `${m[1]}-${m[2] || '01'}-${m[3] || '01'}T${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}`;
  return isNaN(Date.parse(iso + 'Z')) ? null : iso;
}
function pdfString(txt, key) {
  const m = new RegExp('/' + key + '\\s*\\(((?:\\\\.|[^\\\\)])*)\\)').exec(txt);
  if (m) return m[1].replace(/\\(.)/g, '$1').replace(/[^\x20-\x7E]/g, '').trim().slice(0, 120) || null;
  const h = new RegExp('/' + key + '\\s*<([0-9A-Fa-f\\s]+)>').exec(txt); // hex string (often UTF-16)
  if (!h) return null;
  const b = Buffer.from(h[1].replace(/\s/g, ''), 'hex');
  const s = b[0] === 0xfe && b[1] === 0xff ? b.slice(2).swap16().toString('utf16le') : b.toString('latin1');
  return s.replace(/[^\x20-\x7E]/g, '').trim().slice(0, 120) || null;
}
function pdfFacts(buf) {
  const txt = buf.toString('latin1');
  return {
    producer: pdfString(txt, 'Producer'),
    creator: pdfString(txt, 'Creator'),
    created: pdfDate((/\/CreationDate\s*\(([^)]*)\)/.exec(txt) || [])[1]),
    modified: pdfDate((/\/ModDate\s*\(([^)]*)\)/.exec(txt) || [])[1]),
    saves: Math.max(1, (txt.match(/%%EOF/g) || []).length) // more than 1 = saved again after it was made
  };
}

// ---- JPEG EXIF ----
function exifFacts(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let p = 2;
  while (p + 4 < buf.length && buf[p] === 0xff) {
    const marker = buf[p + 1], len = buf.readUInt16BE(p + 2);
    if (marker === 0xe1 && buf.toString('latin1', p + 4, p + 10) === 'Exif\0\0') return parseTiff(buf.slice(p + 10, p + 2 + len));
    if (marker === 0xda) break; // image data starts: no EXIF
    p += 2 + len;
  }
  return null;
}
function parseTiff(t) {
  if (t.length < 8) return null;
  const le = t.toString('latin1', 0, 2) === 'II';
  const u16 = o => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = o => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  function ifd(off) {
    const out = {};
    if (off <= 0 || off + 2 > t.length) return out;
    const n = u16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12; if (e + 12 > t.length) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const bytes = (SIZE[type] || 1) * count;
      const at = bytes > 4 ? u32(e + 8) : e + 8;
      if (at + bytes > t.length) continue;
      if (type === 2) out[tag] = t.toString('latin1', at, at + count).replace(/\0+$/, '').trim();
      else if (type === 3) out[tag] = u16(at);
      else if (type === 4) out[tag] = u32(at);
      else if (type === 5) out[tag] = Array.from({ length: count }, (_, k) => { const d = u32(at + k * 8 + 4); return d ? u32(at + k * 8) / d : 0; });
    }
    return out;
  }
  try {
    const i0 = ifd(u32(4));
    const ex = i0[0x8769] ? ifd(i0[0x8769]) : {};
    const gp = i0[0x8825] ? ifd(i0[0x8825]) : {};
    const dms = (v, ref) => Array.isArray(v) && v.length === 3 ? +(((v[0] + v[1] / 60 + v[2] / 3600) * (/[SW]/.test(ref || '') ? -1 : 1)).toFixed(6)) : null;
    const lat = dms(gp[2], gp[1]), lng = dms(gp[4], gp[3]);
    const when = s => { const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s || ''); return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null; };
    return {
      make: i0[0x010f] || null, model: i0[0x0110] || null, software: i0[0x0131] || null,
      taken: when(ex[0x9003]) || when(i0[0x0132]), gps: lat != null && lng != null ? { lat, lng } : null
    };
  } catch { return null; }
}

function analyze(buf, mime = '') {
  const kind = buf.slice(0, 5).toString('latin1') === '%PDF-' ? 'pdf' : (buf[0] === 0xff && buf[1] === 0xd8) ? 'jpeg' : (String(mime).split('/')[0] || 'file');
  const out = { sha256: sha256(buf), size: buf.length, kind };
  try {
    if (kind === 'pdf') out.pdf = pdfFacts(buf);
    if (kind === 'jpeg') { const x = exifFacts(buf); if (x) out.exif = x; }
  } catch { /* a broken file still gets its fingerprint */ }
  return out;
}

function store() { const { db } = require('../db'); db.data.fileFacts = db.data.fileFacts || []; return db.data.fileFacts; }
let index = null, indexLen = -1;
function lookup() {
  const list = store();
  if (!index || indexLen !== list.length) { index = new Map(list.map(f => [f.url, f])); indexLen = list.length; }
  return index;
}
const factsFor = url => (url ? lookup().get(url) || null : null);

function record(url, facts) {
  if (!url || !facts) return null;
  const list = store();
  const { id: _i, url: _u, at: _a, ...rest } = facts;
  const rec = { id: idFor(url), url, ...rest, at: new Date().toISOString() };
  const i = list.findIndex(f => f.id === rec.id);
  if (i >= 0) list[i] = rec; else list.push(rec);
  index = null;
  return rec;
}
function recordBuffer(url, buf, mime) { try { return record(url, analyze(buf, mime)); } catch { return null; } }
async function recordPath(url, filePath, mime) {
  try {
    const h = crypto.createHash('sha256'); let size = 0;
    await new Promise((res, rej) => fs.createReadStream(filePath).on('data', d => { h.update(d); size += d.length; }).on('end', res).on('error', rej));
    return record(url, { sha256: h.digest('hex'), size, kind: String(mime || '').split('/')[0] || 'file' });
  } catch { return null; }
}

// Older files saved before this existed: fingerprint a few per run (big media skipped).
async function backfill(limit = 25) {
  const { db } = require('../db');
  const storage = require('./storage');
  const todo = (db.data.evidence || []).filter(e => e.fileUrl && !e.purgedAt && !factsFor(e.fileUrl) && !e.factsFailed && !/^(video|audio)/.test(e.mimeType || '')).slice(0, limit);
  let done = 0;
  for (const e of todo) {
    try { const buf = await storage.readFile(e.fileUrl); if (buf.length <= 25 * 1024 * 1024) { recordBuffer(e.fileUrl, buf, e.mimeType); done++; } else e.factsFailed = 'too large'; }
    catch { e.factsFailed = 'unreadable'; }
  }
  if (todo.length) await db.write();
  return { checked: todo.length, done };
}

module.exports = { analyze, record, recordBuffer, recordPath, factsFor, backfill, sha256, pdfFacts, exifFacts };
