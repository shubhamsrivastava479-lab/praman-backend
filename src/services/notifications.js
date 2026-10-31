// In-app notifications (the bell on the dashboard) plus optional e-mail.
// Stored in db.data.notifications: { id, vendorId, type, caseId, text, at, readBy: [userId] }
// E-mail is sent only when SMTP_URL is set (for example smtps://user:pass@smtp.example.com) —
// otherwise only the in-app bell is used.
const { db, uid } = require('../db');
const followup = require('./followup');

const MAX_PER_FIRM = 300;
let mailer = null;
// Brevo by its web API (BREVO_API_KEY): works on the free plan without asking Brevo to switch SMTP on.
const brevoOn = () => !!process.env.BREVO_API_KEY;
function parseFrom(v) {
  const m = String(v || '').match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  return m ? { name: (m[1] || '').trim() || undefined, email: m[2].trim() } : { email: String(v || '').trim() };
}
async function brevoSend(list, subject, text, attachments) {
  const body = { sender: parseFrom(process.env.MAIL_FROM || 'Praman <no-reply@praman.local>'), to: list.map(email => ({ email })), subject, textContent: text };
  if (attachments && attachments.length) body.attachment = attachments.map(a => ({ name: a.filename || 'file', content: Buffer.from(a.content || '').toString('base64') }));
  const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('Brevo ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 200));
}

function transport() {
  if (brevoOn()) return { brevo: true };
  if (mailer !== null) return mailer;
  mailer = false;
  if (process.env.SMTP_URL) {
    try { mailer = require('nodemailer').createTransport(process.env.SMTP_URL); } catch (e) { console.error('SMTP setup failed:', e.message); }
  }
  return mailer;
}

async function sendMail(to, subject, text, attachments) {
  const t = transport();
  const list = String(to || '').split(/[;,]/).map(x => x.trim()).filter(x => /^[^@\s]+@[^@\s]+$/.test(x));
  if (!t || !list.length) return false;
  try {
    if (t.brevo) { await brevoSend(list, subject, text, attachments); return true; }
    await t.sendMail({ from: process.env.MAIL_FROM || 'Praman <no-reply@praman.local>', to: list.join(','), subject, text, attachments });
    return true;
  } catch (e) { console.error('Email failed:', e.message); return false; }
}

// type: ai_review | handoff | overdue | second_review | data_request
function notify(vendorId, { type, caseId, text }) {
  if (!vendorId || !text) return null;
  const list = (db.data.notifications ||= []);
  const n = { id: uid('ntf'), vendorId, type: type || 'info', caseId: caseId || null, text: String(text).slice(0, 300), at: new Date().toISOString(), readBy: [] };
  list.push(n);
  const mine = list.filter(x => x.vendorId === vendorId);
  if (mine.length > MAX_PER_FIRM) {
    const drop = new Set(mine.slice(0, mine.length - MAX_PER_FIRM).map(x => x.id));
    db.data.notifications = list.filter(x => !drop.has(x.id));
  }
  // e-mail (best effort, never blocks)
  const firm = (db.data.users || []).find(u => u.id === vendorId);
  const to = followup.settingsOf(firm).notifyEmail;
  if (to) sendMail(to, 'Praman: ' + n.text.slice(0, 80), n.text).catch(() => {});
  return n;
}

function listFor(user, limit = 40) {
  const mine = (db.data.notifications || []).filter(n => n.vendorId === user.vendorRootId);
  const out = mine.slice(-limit).reverse().map(n => ({ ...n, unread: !(n.readBy || []).includes(user.id) }));
  return { items: out, unread: mine.filter(n => !(n.readBy || []).includes(user.id)).length };
}

function markRead(user, ids) {
  const set = ids && ids.length ? new Set(ids) : null;
  for (const n of db.data.notifications || []) {
    if (n.vendorId !== user.vendorRootId) continue;
    if (set && !set.has(n.id)) continue;
    if (!(n.readBy ||= []).includes(user.id)) n.readBy.push(user.id);
  }
}

module.exports = { notify, listFor, markRead, sendMail, transport };
