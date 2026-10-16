// Keeps a short list of server problems so Super Admin can see them (db.data.errorLog),
// and optionally sends a one-line alert to a chat webhook (ALERT_WEBHOOK_URL — Slack,
// Discord, Google Chat, anything that accepts {"text": "..."}).
//
// The same problem happening again and again is stored once, with a counter.
const { db, uid } = require('../db');

const MAX = 300;
const alertSeen = new Map(); // key -> last alert time (one alert per problem per hour)

const clean = s => String(s == null ? '' : s)
  .replace(/(key|token|secret|password|authorization)=([^&\s"']+)/gi, '$1=…')
  .replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza…')
  .replace(/\b\d{4}\s?\d{4}\s?\d{4}\b/g, '••••')
  .slice(0, 400);

function record(source, err, ctx = {}) {
  try {
    const message = clean((err && err.message) || err || 'Unknown error');
    const key = source + '|' + message.slice(0, 120);
    const list = (db.data.errorLog ||= []);
    const hit = list.slice(-60).find(e => e.key === key && Date.now() - new Date(e.lastAt).getTime() < 3600e3);
    const at = new Date().toISOString();
    if (hit) { hit.count += 1; hit.lastAt = at; }
    else {
      list.push({ id: uid('err'), key, source, message, stack: clean(err && err.stack ? String(err.stack).split('\n').slice(1, 4).join(' | ') : ''), path: ctx.path ? clean(ctx.path).slice(0, 120) : undefined, status: ctx.status, count: 1, firstAt: at, lastAt: at });
      if (list.length > MAX) list.splice(0, list.length - MAX);
    }
    if (!hit) alert(key, `⚠️ Praman [${source}] ${message}${ctx.path ? ' — ' + clean(ctx.path) : ''}`);
    db.write().catch(() => {});
  } catch { /* the error log must never cause an error */ }
}

function alert(key, text) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  const last = alertSeen.get(key) || 0;
  if (Date.now() - last < 3600e3) return;
  alertSeen.set(key, Date.now());
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, content: text }) }).catch(() => {});
}

// Express: logs every answer with status 500 or more.
function requestLogger(req, res, next) {
  res.on('finish', () => {
    if (res.statusCode >= 500) record('http', `${req.method} ${res.statusCode}`, { path: (req.originalUrl || '').split('?')[0].replace(/\/[0-9a-f]{20,}/gi, '/…'), status: res.statusCode });
  });
  next();
}
function errorHandler(err, req, res, next) {
  record('server', err, { path: (req.originalUrl || '').split('?')[0].replace(/\/[0-9a-f]{20,}/gi, '/…'), status: 500 });
  if (res.headersSent) return next(err);
  res.status(err.status && err.status < 600 ? err.status : 500).json({ error: err.status && err.status < 500 ? err.message : 'Something went wrong on our side. Please try again.' });
}

function installProcessHandlers() {
  process.on('unhandledRejection', e => { console.error('Unhandled rejection:', e); record('unhandledRejection', e); });
  process.on('uncaughtException', async e => {
    console.error('Uncaught exception:', e);
    record('crash', e);
    try { await db.write(); } catch {}
    process.exit(1); // Render starts a fresh copy
  });
}

const recent = (hours = 24) => (db.data.errorLog || []).filter(e => Date.now() - new Date(e.lastAt).getTime() < hours * 3600e3);

module.exports = { record, requestLogger, errorHandler, installProcessHandlers, recent, clean };
