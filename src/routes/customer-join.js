// "Join your call" for customers (the Praman app and /app-join.html):
//   POST /api/public/customer/otp     { mobile }        -> a 6-digit code on WhatsApp, from the firm's own number
//   POST /api/public/customer/verify  { mobile, code }  -> the video calls waiting for this number
// The answer to /otp never says whether the number has a case (nobody can probe numbers).
// Only the customer's own open calls are returned: firm name, what the call is for, and the link.
const express = require('express');
const crypto = require('crypto');
const { db, uid } = require('../db');
const { rateLimit } = require('../services/security');

const router = express.Router();
const TTL = 5 * 60_000, MAX_TRIES = 5;
const codes = new Map();   // last10 -> { hash, exp, tries, sends: [times] }
const last10 = v => String(v || '').replace(/\D/g, '').slice(-10);
const hash = (n, c) => crypto.createHash('sha256').update(n + '|' + c + '|' + (process.env.JWT_SECRET || '')).digest('hex');
const GENERIC = 'If a verification call is waiting for this number, a 6-digit code has been sent on WhatsApp.';

function openCasesOf(n) {
  return (db.data.cases || []).filter(c => c.status !== 'completed' && last10(c.whatsappNumber) === n)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function callsOf(n, base) {
  const plans = require('../services/plans');
  const { customerLink } = require('./cases');
  return openCasesOf(n).slice(0, 5).map(c => {
    const firm = db.data.users.find(u => u.id === c.vendorId) || {};
    const svc = plans.SERVICES[plans.serviceOfCase(c)] || {};
    const ai = c.verificationMode === 'full_automation' && c.aiCall && c.aiCall.token && c.aiCall.status !== 'completed';
    const live = c.liveCall && c.liveCall.token;
    const url = live && !ai ? `${base}/live-join.html?t=${c.liveCall.token}` : customerLink(c, base);
    return { firm: firm.vendorName || 'Praman', purpose: svc.label || 'Verification call', kind: ai ? 'ai' : live ? 'live' : 'self', ref: '••••' + String(c.claimNo || '').slice(-4), url };
  });
}

async function sendCode(c, to, code) {
  const wa = require('../services/whatsapp');
  const account = (db.data.whatsappAccounts || []).find(a => a.id === c.whatsappAccountId);
  if (!account) throw new Error('no WhatsApp number on the case');
  try {
    await wa.sendTextMessage(to, `Your Praman code is ${code}. It is valid for 5 minutes.\nआपका Praman कोड ${code} है। 5 मिनट तक मान्य।\nDo not share it with anyone.`, account);
  } catch (e) {
    // Outside WhatsApp's 24-hour window a free message is refused: use the firm's approved Authentication template.
    const firm = db.data.users.find(u => u.id === c.vendorId);
    const name = require('../services/followup').settingsOf(firm).otpTemplate || process.env.WHATSAPP_OTP_TEMPLATE || 'praman_login_code';
    await wa.sendTemplateMessage(to, name, account, 'en', [
      { type: 'body', parameters: [{ type: 'text', text: code }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] }
    ]);
  }
}

router.post('/otp', rateLimit({ windowMs: 10 * 60_000, max: Number(process.env.CUSTOMER_OTP_IP_MAX) || 10, name: 'customer-otp' }), async (req, res) => {
  const n = last10((req.body || {}).mobile);
  if (n.length !== 10 || !/^[6-9]/.test(n)) return res.status(400).json({ error: 'Please enter your 10-digit mobile number.' });
  const cur = codes.get(n) || { sends: [] }, now = Date.now();
  cur.sends = cur.sends.filter(t => now - t < 3600e3);
  if (cur.sends.length >= 3) return res.status(429).json({ error: 'Too many codes for this number. Please try again in an hour.' });
  if (cur.sends.length && now - cur.sends[cur.sends.length - 1] < 30_000) return res.status(429).json({ error: 'Please wait 30 seconds before asking for another code.' });
  await db.read();
  const c = openCasesOf(n)[0];
  cur.sends.push(now); codes.set(n, cur);
  if (!c) return res.json({ ok: true, message: GENERIC });
  const code = String(crypto.randomInt(100000, 1000000));
  try {
    await sendCode(c, c.whatsappNumber, code);
    Object.assign(cur, { hash: hash(n, code), exp: now + TTL, tries: 0 });
  } catch (e) {
    console.error('Customer app code not sent:', e.message);
    db.data.custody.push({ id: uid('cust'), caseId: c.id, event: 'Customer asked for an app login code, but WhatsApp did not send it: ' + String(e.message).slice(0, 160), actor: 'system', timestamp: new Date().toISOString() });
    await db.write().catch(() => {});
  }
  res.json({ ok: true, message: GENERIC });
});

router.post('/verify', rateLimit({ windowMs: 10 * 60_000, max: 20, name: 'customer-verify' }), async (req, res) => {
  const b = req.body || {}, n = last10(b.mobile), code = String(b.code || '').replace(/\D/g, '');
  const cur = codes.get(n);
  if (!cur || !cur.hash || Date.now() > cur.exp) return res.status(400).json({ error: 'The code has expired. Please ask for a new one.' });
  if (cur.tries >= MAX_TRIES) return res.status(429).json({ error: 'Too many wrong codes. Please ask for a new one.' });
  if (!(code.length === 6 && crypto.timingSafeEqual(Buffer.from(hash(n, code)), Buffer.from(cur.hash)))) { cur.tries++; return res.status(400).json({ error: 'That code is not correct.' }); }
  cur.hash = null;
  await db.read();
  const base = process.env.PUBLIC_BASE_URL && !/your-deployed/i.test(process.env.PUBLIC_BASE_URL) ? process.env.PUBLIC_BASE_URL.replace(/\/$/, '') : `${req.protocol}://${req.get('host')}`;
  const calls = callsOf(n, base);
  for (const c of openCasesOf(n).slice(0, 5)) db.data.custody.push({ id: uid('cust'), caseId: c.id, event: 'Customer confirmed their mobile number with a WhatsApp code (Praman app / join page)', actor: 'participant', timestamp: new Date().toISOString() });
  await db.write();
  res.json({ ok: true, calls });
});

module.exports = router;
module.exports._codes = codes;
