// API of the SatyaSakshi Praman consumer app (B2C). Consumers log in with their mobile number and a WhatsApp code;
// their token (role "consumer") works only here, never on the business APIs.
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { db, uid } = require('../db');
const { rateLimit } = require('../services/security');
const b2c = require('../services/b2c');

const router = express.Router();
const TTL = 5 * 60_000;
const codes = new Map();   // last10 -> { hash, exp, tries, sends }
const hash = (n, c) => crypto.createHash('sha256').update('consumer|' + n + '|' + c + '|' + (process.env.JWT_SECRET || '')).digest('hex');
const baseOf = req => process.env.PUBLIC_BASE_URL && !/your-deployed/i.test(process.env.PUBLIC_BASE_URL) ? process.env.PUBLIC_BASE_URL.replace(/\/$/, '') : `${req.protocol}://${req.get('host')}`;
const sendErr = (res, e) => res.status(e.status || 400).json({ error: e.message || 'Something went wrong.', code: e.code });

function auth(req, res, next) {
  const h = req.get('Authorization') || '';
  try {
    const u = jwt.verify(h.replace(/^Bearer /, ''), process.env.JWT_SECRET);
    if (u.role !== 'consumer') throw new Error('x');
    req.consumer = (db.data.consumers || []).find(c => c.id === u.id);
    if (!req.consumer) throw new Error('x');
    next();
  } catch { res.status(401).json({ error: 'Please log in again.' }); }
}

// ---- public ----
router.get('/packages', async (req, res) => { await db.read(); res.json({ packages: b2c.catalogue() }); });

router.post('/otp', rateLimit({ windowMs: 10 * 60_000, max: Number(process.env.CONSUMER_OTP_IP_MAX) || 10, name: 'consumer-otp' }), async (req, res) => {
  const n = b2c.last10((req.body || {}).mobile);
  if (!/^[6-9]\d{9}$/.test(n)) return res.status(400).json({ error: 'Enter your 10-digit mobile number.' });
  const cur = codes.get(n) || { sends: [] }, now = Date.now();
  cur.sends = cur.sends.filter(t => now - t < 3600e3);
  if (cur.sends.length >= 3) return res.status(429).json({ error: 'Too many codes. Please try again in an hour.' });
  if (cur.sends.length && now - cur.sends[cur.sends.length - 1] < 30_000) return res.status(429).json({ error: 'Please wait 30 seconds before asking again.' });
  await db.read();
  const code = String(crypto.randomInt(100000, 1000000));
  try { await b2c.sendLoginCode(n, code); }
  catch (e) { console.error('Consumer login code not sent:', e.message); return res.status(e.status || 502).json({ error: e.code === 'NOT_CONFIGURED' ? e.message : 'Could not send the code on WhatsApp. Please try again.' }); }
  cur.sends.push(now); Object.assign(cur, { hash: hash(n, code), exp: now + TTL, tries: 0 }); codes.set(n, cur);
  res.json({ ok: true });
});

router.post('/login', rateLimit({ windowMs: 10 * 60_000, max: 20, name: 'consumer-login' }), async (req, res) => {
  const b = req.body || {}, n = b2c.last10(b.mobile), code = String(b.code || '').replace(/\D/g, '');
  const cur = codes.get(n);
  if (!cur || !cur.hash || Date.now() > cur.exp) return res.status(400).json({ error: 'The code has expired. Please ask for a new one.' });
  if (cur.tries >= 5) return res.status(429).json({ error: 'Too many wrong codes. Please ask for a new one.' });
  if (!(code.length === 6 && crypto.timingSafeEqual(Buffer.from(hash(n, code)), Buffer.from(cur.hash)))) { cur.tries++; return res.status(400).json({ error: 'That code is not correct.' }); }
  cur.hash = null;
  await db.read();
  const list = (db.data.consumers ||= []);
  let c = list.find(x => x.mobile === n);
  if (!c) { c = { id: uid('cons'), mobile: n, name: '', email: '', createdAt: new Date().toISOString() }; list.push(c); }
  if (b.name && !c.name) c.name = String(b.name).trim().slice(0, 80);
  c.lastLoginAt = new Date().toISOString();
  await db.write();
  const token = jwt.sign({ id: c.id, role: 'consumer' }, process.env.JWT_SECRET, { expiresIn: '60d' });
  res.json({ token, consumer: { id: c.id, mobile: c.mobile, name: c.name, email: c.email } });
});

// Razorpay tells us about a payment even if the app was closed before it came back.
router.post('/razorpay/webhook', async (req, res) => {
  if (!b2c.checkWebhookSignature(req.rawBody, req.get('X-Razorpay-Signature'))) return res.status(400).json({ error: 'bad signature' });
  const ev = req.body || {}, pay = ev.payload && ev.payload.payment && ev.payload.payment.entity;
  if (ev.event === 'payment.captured' && pay && pay.order_id) {
    await db.read();
    const o = (db.data.b2cOrders || []).find(x => x.razorpay && x.razorpay.orderId === pay.order_id);
    if (o && o.status === 'created' && Math.round(o.price * 100) === Number(pay.amount)) {
      Object.assign(o.razorpay, { paymentId: pay.id, via: 'webhook' }); o.status = 'paid'; o.paidAt = new Date().toISOString();
      await b2c.fulfil(o, { baseUrl: baseOf(req) });
      await db.write();
    }
  }
  res.json({ ok: true });
});

// ---- logged in ----
router.use(auth);

router.get('/me', (req, res) => res.json({ consumer: { id: req.consumer.id, mobile: req.consumer.mobile, name: req.consumer.name, email: req.consumer.email } }));
router.put('/me', async (req, res) => {
  const b = req.body || {};
  if (b.name !== undefined) req.consumer.name = String(b.name).trim().slice(0, 80);
  if (b.email !== undefined) { const e = String(b.email).trim().toLowerCase().slice(0, 120); if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(e)) return res.status(400).json({ error: 'Enter a valid email.' }); req.consumer.email = e; }
  await db.write();
  res.json({ ok: true });
});

router.post('/orders', async (req, res) => {
  await db.read();
  try {
    const o = b2c.newOrder(req.consumer, req.body);
    if (o.price > 0) {
      const pay = await b2c.razorpayOrder(o);
      await db.write();
      return res.status(201).json({ order: b2c.view(o, { baseUrl: baseOf(req) }), pay: { ...pay, name: 'SatyaSakshi Praman', description: o.packageName + ' · ' + o.ref, prefill: { contact: '+91' + req.consumer.mobile, name: req.consumer.name || '', email: req.consumer.email || '' } } });
    }
    o.status = 'paid'; o.paidAt = new Date().toISOString(); o.testOrder = true;   // test mode, no price
    await b2c.fulfil(o, { baseUrl: baseOf(req) });
    await db.write();
    res.status(201).json({ order: b2c.view(o, { baseUrl: baseOf(req) }) });
  } catch (e) {
    const list = db.data.b2cOrders || [], last = list[list.length - 1];
    if (last && last.consumerId === req.consumer.id && last.status === 'created' && !last.razorpay) list.pop();   // payment could not start: drop the empty order
    sendErr(res, e);
  }
});

router.post('/orders/:id/pay', async (req, res) => {
  await db.read();
  const o = (db.data.b2cOrders || []).find(x => x.id === req.params.id && x.consumerId === req.consumer.id);
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  if (o.status === 'created') {
    if (!b2c.checkPaymentSignature(o, req.body || {})) return res.status(400).json({ error: 'The payment could not be confirmed. If money was taken, it will be checked and refunded.' });
    Object.assign(o.razorpay, { paymentId: req.body.razorpay_payment_id, via: 'app' }); o.status = 'paid'; o.paidAt = new Date().toISOString();
    await b2c.fulfil(o, { baseUrl: baseOf(req) });
    await db.write();
  }
  res.json({ order: b2c.view(o, { baseUrl: baseOf(req) }) });
});

router.get('/orders', async (req, res) => {
  await db.read();
  const list = (db.data.b2cOrders || []).filter(o => o.consumerId === req.consumer.id && o.status !== 'created').slice(-100).reverse();
  const out = list.map(o => b2c.view(o, { baseUrl: baseOf(req) }));
  await db.write().catch(() => {});
  res.json({ orders: out });
});

router.get('/orders/:id', async (req, res) => {
  await db.read();
  const o = (db.data.b2cOrders || []).find(x => x.id === req.params.id && x.consumerId === req.consumer.id);
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  const v = b2c.view(o, { baseUrl: baseOf(req) });
  await db.write().catch(() => {});
  res.json({ order: v });
});

module.exports = router;
module.exports._codes = codes;
