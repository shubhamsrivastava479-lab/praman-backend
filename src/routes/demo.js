// Public "Request a demo" form of the website.
//   GET  /api/demo/config   -> { otp: true|false }  (the e-mail code is used only when e-mail sending is set up)
//   POST /api/demo/otp      -> sends a 6-digit code to the official e-mail
//   POST /api/demo/request  -> saves the request (shown to the Super Admin)
const express = require('express');
const { db, uid } = require('../db');
const { rateLimit } = require('../services/security');
const notifications = require('../services/notifications');
const emailCode = require('../services/email-code');
const captcha = require('../services/captcha');

const router = express.Router();
const GST = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN = /^[A-Z]{5}\d{4}[A-Z]$/;
const clean = emailCode.clean;
const otpOn = emailCode.available;
const BAD_PIC = 'The picture code is not correct. Please try the new one.';

router.get('/config', (req, res) => res.json({ otp: otpOn() }));

// The picture code is needed to ask for an email code (so nobody can use us to spam an address),
// and to submit the form when email codes are not switched on.
router.post('/otp', rateLimit({ windowMs: 10 * 60_000, max: 12, name: 'demo-otp' }), async (req, res) => {
  if (!otpOn()) return res.status(503).json({ error: 'Email codes are not switched on yet.' });
  const b = req.body || {};
  if (!captcha.check(b.captchaId, b.captchaAnswer)) return res.status(400).json({ error: BAD_PIC, captcha: true });
  const e = emailCode.email(b.email, true);
  if (e.error) return res.status(400).json({ error: e.error });
  const r = await emailCode.issue('demo', e.email, 'Your Praman verification code',
    'Your Praman verification code is {code}.\nIt is valid for 10 minutes. If you did not ask for it, you can ignore this email.\n\nSatyaSakshi LLP · Praman');
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ ok: true });
});

router.post('/request', rateLimit({ windowMs: 60 * 60_000, max: Number(process.env.DEMO_RATE_MAX) || 8, name: 'demo-request' }), async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true }); // hidden field: only bots fill it
  const e = emailCode.email(b.email, true);
  if (e.error) return res.status(400).json({ error: e.error });
  const name = clean(b.name, 80), company = clean(b.company, 120), designation = clean(b.designation, 80),
    city = clean(b.city, 60), country = clean(b.country, 60);
  const phone = clean(b.phone, 20).replace(/[^\d+]/g, '');
  const idNo = clean(b.idNumber, 20).toUpperCase().replace(/\s/g, '');
  if (!name || !company || !designation || !city || !country) return res.status(400).json({ error: 'Please fill in every field.' });
  if (!/^\+?\d{8,15}$/.test(phone)) return res.status(400).json({ error: 'Please enter a valid phone number.' });
  const idType = GST.test(idNo) ? 'GST' : PAN.test(idNo) ? 'PAN' : null;
  if (!idType) return res.status(400).json({ error: 'Please enter a valid 15-character GST number or 10-character PAN.' });

  let verified = false;
  if (otpOn()) {
    const r = emailCode.check('demo', e.email, b.code);
    if (r.error) return res.status(r.status).json({ error: r.error });
    verified = true;
  } else if (!captcha.check(b.captchaId, b.captchaAnswer)) return res.status(400).json({ error: BAD_PIC, captcha: true });

  await db.read();
  const list = (db.data.demoRequests ||= []);
  list.push({ id: uid('demo'), createdAt: new Date().toISOString(), name, designation, company, email: e.email, emailVerified: verified, phone, idType, idNumber: idNo, city, country, status: 'new', note: '' });
  if (list.length > 3000) list.splice(0, list.length - 3000);
  await db.write();

  const to = process.env.DEMO_NOTIFY_EMAIL || process.env.CONTACT_EMAIL || process.env.PRIVACY_CONTACT_EMAIL;
  if (to) notifications.sendMail(to, 'New Praman demo request: ' + company,
    `Company: ${company}\nContact: ${name} (${designation})\nEmail: ${e.email}${verified ? ' (verified)' : ' (not verified)'}\nPhone: ${phone}\n${idType}: ${idNo}\nCity: ${city}, ${country}`).catch(() => {});
  res.status(201).json({ ok: true });
});

// Website chat box: a visitor leaves contact details. Saved with the demo requests (source: chat)
// so the Super Admin sees every website enquiry in one list. Personal email is allowed here but marked.
const TOPIC = /^[a-z_]{2,20}$/;
router.post('/chat-lead', rateLimit({ windowMs: 60 * 60_000, max: Number(process.env.CHAT_RATE_MAX) || 10, name: 'chat-lead' }), async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true });                         // hidden field: only bots fill it
  if (Number(b.ms) > 0 && Number(b.ms) < 2500) return res.json({ ok: true }); // filled faster than a person can
  const e = emailCode.email(b.email, false);
  if (e.error) return res.status(400).json({ error: e.error });
  const name = clean(b.name, 80), company = clean(b.company, 120);
  if (!name || !company) return res.status(400).json({ error: 'Please enter your name and company.' });
  const phone = clean(b.phone, 20).replace(/[^\d+]/g, '');
  if (phone && !/^\+?\d{8,15}$/.test(phone)) return res.status(400).json({ error: 'Please check the mobile number.' });
  if (b.consent !== true) return res.status(400).json({ error: 'Please tick the box so we may contact you.' });
  const free = emailCode.isFree(e.email);
  await db.read();
  const list = (db.data.demoRequests ||= []);
  const recent = list.find(x => x.source === 'chat' && x.email === e.email && Date.now() - new Date(x.createdAt).getTime() < 10 * 60_000);
  if (recent) return res.json({ ok: true });                            // same person pressed Send twice
  list.push({ id: uid('demo'), source: 'chat', createdAt: new Date().toISOString(), name, company, email: e.email, emailVerified: false, freeEmail: free, phone,
    interest: clean(b.interest, 60), message: clean(b.message, 500), page: clean(b.page, 120),
    topics: (Array.isArray(b.topics) ? b.topics : []).filter(t => TOPIC.test(String(t))).slice(0, 15),
    consentAt: new Date().toISOString(), status: 'new', note: '' });
  if (list.length > 3000) list.splice(0, list.length - 3000);
  await db.write();
  const to = process.env.DEMO_NOTIFY_EMAIL || process.env.CONTACT_EMAIL || process.env.PRIVACY_CONTACT_EMAIL;
  const last = list[list.length - 1];
  if (to) notifications.sendMail(to, 'New website chat enquiry: ' + company,
    `Name: ${name}\nCompany: ${company}\nEmail: ${e.email}${free ? ' (personal email)' : ''}\nPhone: ${phone || '-'}\nInterest: ${last.interest || '-'}\nMessage: ${last.message || '-'}\nPage: ${last.page || '-'}\nAsked about: ${last.topics.join(', ') || '-'}`).catch(() => {});
  res.status(201).json({ ok: true });
});

module.exports = router;
