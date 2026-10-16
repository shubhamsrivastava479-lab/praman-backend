// Automatic daily backups of all data (not the files — those already live in the bucket).
//
// What is saved: every collection except platformSettings (it holds API keys and secrets, so it is
// never copied into a backup) and the backup list itself. Saved as backups/YYYY-MM-DD.json.gz in the
// same file storage (Cloudflare R2, or local disk when R2 is not set up). The last 14 are kept.
//
// "verify" opens a saved backup and checks it against what was recorded when it was made,
// without changing anything. "restore" replaces the data with the backup (after saving a
// safety copy of the current data first, so a restore can itself be undone).
const zlib = require('zlib');
const { db, uid } = require('../db');
const storage = require('./storage');

const KEEP = 14;
const SKIP = new Set(['platformSettings', 'backupLog']);
const day = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);

const counts = data => Object.fromEntries(Object.entries(data).filter(([k]) => !SKIP.has(k)).map(([k, v]) => [k, Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : 0)]));

function snapshot() {
  const data = {};
  for (const [k, v] of Object.entries(db.data)) if (!SKIP.has(k)) data[k] = v;
  const body = { app: 'praman', version: 1, at: new Date().toISOString(), counts: counts(data), data };
  return { buf: zlib.gzipSync(Buffer.from(JSON.stringify(body))), counts: body.counts };
}

async function run({ now = new Date(), label = '' } = {}) {
  const { buf, counts: cnt } = snapshot();
  const name = `backups/${day(now)}${label ? '-' + label : ''}-${now.getTime().toString(36)}.json.gz`;
  const url = await storage.saveFile(buf, name, 'application/gzip');
  const entry = { id: uid('bkp'), name, url, at: now.toISOString(), bytes: buf.length, counts: cnt, label: label || 'daily', verifiedAt: null };
  (db.data.backupLog ||= []).push(entry);
  // keep the newest KEEP automatic backups; safety copies made before a restore are kept too
  const auto = db.data.backupLog.filter(b => b.label === 'daily');
  for (const old of auto.slice(0, Math.max(0, auto.length - KEEP))) {
    try { await storage.deleteFile(old.url); } catch (e) { console.error('Old backup not deleted:', e.message); }
    db.data.backupLog = db.data.backupLog.filter(b => b.id !== old.id);
  }
  await db.write();
  return entry;
}

async function load(entry) {
  const raw = zlib.gunzipSync(await storage.readFile(entry.url));
  const body = JSON.parse(raw.toString('utf8'));
  if (!body || body.app !== 'praman' || !body.data || typeof body.data !== 'object') throw new Error('This file is not a Praman backup.');
  return body;
}

// Non-destructive check: can it be opened, and does it match what was recorded?
async function verify(entry) {
  const body = await load(entry);
  const now = counts(body.data), was = entry.counts || {};
  const diff = Object.keys(was).filter(k => was[k] !== now[k]);
  if (diff.length) throw new Error('The backup does not match what was recorded for: ' + diff.join(', '));
  entry.verifiedAt = new Date().toISOString();
  await db.write();
  return { ok: true, counts: now, at: body.at };
}

async function restore(entry) {
  const body = await load(entry);
  const safety = await run({ label: 'before-restore' });   // so this restore can be undone
  for (const [k, v] of Object.entries(body.data)) if (!SKIP.has(k)) db.data[k] = v;
  await db.write();
  return { restored: Object.keys(body.data).length, safetyBackup: safety.id, counts: counts(db.data) };
}

// Called by the scheduler once an hour: makes today's backup after 02:00 India time if there is none yet.
async function tick(now = new Date()) {
  const istHour = new Date(now.getTime() + 5.5 * 3600e3).getUTCHours();
  if (istHour < 2) return { made: false };
  const today = day(now);
  if ((db.data.backupLog || []).some(b => b.label === 'daily' && day(new Date(b.at)) === today)) return { made: false };
  const e = await run({ now });
  return { made: true, id: e.id };
}

module.exports = { run, verify, restore, tick, snapshot, counts };
