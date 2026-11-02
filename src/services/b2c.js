// SatyaSakshi Praman consumer app (B2C): settings, payments (Razorpay) and fulfilment of orders.
//
// db.data.consumers   [{ id, mobile, name, email, createdAt, lastLoginAt }]
// db.data.b2cOrders   [{ id, ref, consumerId, package, status, price, base, gst, subject, input, razorpay, caseId, checks, ... }]
// Person checks become cases of SatyaSakshi's own B2C account (HOUSE_ID, service personal_check): the person gets a
// WhatsApp link and takes the AI video call, SatyaSakshi's team reviews it in the normal dashboard, and the buyer
// then sees the report in the app. Vehicle checks run straight away through the Gridlines checks.
const crypto = require('crypto');
const { db, uid } = require('../db');
const { PACKAGES } = require('./b2c-packages');

const HOUSE_ID = 'b2c_house';
const RZP = 'https://api.razorpay.com/v1';
const last10 = v => String(v || '').replace(/\D/g, '').slice(-10);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

// ---------- settings (Super Admin > Consumer app) ----------
function settings() {
  const s = ((db.data.platformSettings ||= {}).b2c ||= {});
  return {
    testMode: !!s.testMode,
    gstPercent: Number.isFinite(Number(s.gstPercent)) ? Number(s.gstPercent) : 18,
    prices: s.prices || {},
    enabled: s.enabled || {},
    whatsappAccountId: s.whatsappAccountId || null,
    otpTemplate: s.otpTemplate || process.env.WHATSAPP_OTP_TEMPLATE || 'praman_login_code',
    razorpayKeyId: s.razorpayKeyId || process.env.RAZORPAY_KEY_ID || '',
    razorpayKeySecret: s.razorpayKeySecret || process.env.RAZORPAY_KEY_SECRET || '',
    razorpayWebhookSecret: s.razorpayWebhookSecret || process.env.RAZORPAY_WEBHOOK_SECRET || ''
  };
}

// What the app shows: every package with its price, and whether it can be bought now.
function catalogue() {
  const st = settings();
  return Object.entries(PACKAGES).map(([id, p]) => {
    const price = Number(st.prices[id]) || 0;
    const on = st.enabled[id] !== false;
    return { id, name: p.name, short: p.short, icon: p.icon, kind: p.kind, self: !!p.self, who: p.who, tagline: p.tagline, checks: p.checks, inputs: p.inputs || [],
      price: price || null, available: on && (price > 0 || st.testMode) };
  });
}

// SatyaSakshi's own account that works the consumer orders (created on first use).
function house() {
  let h = db.data.users.find(u => u.id === HOUSE_ID);
  if (!h) {
    h = { id: HOUSE_ID, role: 'vendor_admin', vendorName: 'SatyaSakshi Praman (consumer app)', email: 'consumer-app@pramanservices.space',
      approved: true, status: 'approved', services: ['personal_check'], createdAt: new Date().toISOString(), signupMethod: 'system' };
    db.data.users.push(h);
  }
  return h;
}
const waAccount = () => { const id = settings().whatsappAccountId; return id ? (db.data.whatsappAccounts || []).find(a => a.id === id) || null : null; };

// ---------- consumer login code on WhatsApp ----------
async function sendLoginCode(mobile, code) {
  const acc = waAccount();
  if (!acc) throw fail('NOT_CONFIGURED', 'Login is not switched on yet. Please try again later.', 503);
  const wa = require('./whatsapp');
  const to = '91' + last10(mobile);
  try {
    await wa.sendTextMessage(to, `Your SatyaSakshi Praman code is ${code}. Valid for 5 minutes. Do not share it.\nआपका SatyaSakshi Praman कोड ${code} है।`, acc);
  } catch (e) {
    await wa.sendTemplateMessage(to, settings().otpTemplate, acc, 'en', [
      { type: 'body', parameters: [{ type: 'text', text: code }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] }]);
  }
}

// ---------- orders ----------
function nextRef() {
  const n = (db.data.b2cOrders || []).length + 1;
  return 'SP' + String(n).padStart(6, '0');
}
const money = n => Math.round(n * 100) / 100;

function newOrder(consumer, body) {
  const b = body || {}, pkg = PACKAGES[b.package];
  if (!pkg) throw fail('INVALID', 'Choose a package.');
  const item = catalogue().find(x => x.id === b.package);
  if (!item.available) throw fail('UNAVAILABLE', 'This check is not available yet.');
  if (b.confirm !== true) throw fail('INVALID', pkg.self ? 'Please confirm that the details are yours.' : 'Please confirm that the person knows about this check and you have a genuine reason.');
  const today = (db.data.b2cOrders || []).filter(o => o.consumerId === consumer.id && Date.now() - new Date(o.createdAt).getTime() < 86400e3);
  if (today.length >= 10) throw fail('LIMIT', 'You can place up to 10 orders a day.', 429);
  const o = { id: uid('ord'), ref: nextRef(), consumerId: consumer.id, package: b.package, packageName: pkg.name, kind: pkg.kind, createdAt: new Date().toISOString(), status: 'created' };
  if (pkg.kind === 'person') {
    const name = String((pkg.self ? (b.subject && b.subject.name) || consumer.name : b.subject && b.subject.name) || '').trim().slice(0, 80);
    const mobile = last10(pkg.self ? consumer.mobile : b.subject && b.subject.mobile);
    if (!name) throw fail('INVALID', pkg.self ? 'Please enter your full name.' : 'Enter the name of the person to check.');
    if (!/^[6-9]\d{9}$/.test(mobile)) throw fail('INVALID', 'Enter a valid 10-digit WhatsApp number of the person.');
    if (!pkg.self && mobile === last10(consumer.mobile)) throw fail('INVALID', 'To check yourself, choose the "Praman Verified certificate".');
    const asked = (db.data.b2cOrders || []).filter(x => x.subject && x.subject.mobile === mobile && x.status !== 'created' && Date.now() - new Date(x.createdAt).getTime() < 86400e3);
    if (asked.length >= 3) throw fail('LIMIT', 'This person has already been asked several times today. Please try tomorrow.', 429);
    o.subject = { name, mobile };
  } else {
    const v = String((b.input && b.input.vehicleNumber) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!/^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$|^\d{2}BH\d{4}[A-Z]{1,2}$/.test(v)) throw fail('INVALID', 'Enter a valid vehicle number, like UP16AB1234.');
    o.input = { vehicleNumber: v };
  }
  const st = settings(), price = Number(st.prices[b.package]) || 0;
  o.price = price;                                                   // what the buyer pays, GST included
  o.base = money(price / (1 + st.gstPercent / 100));
  o.gst = money(price - o.base);
  o.gstPercent = st.gstPercent;
  (db.data.b2cOrders ||= []).push(o);
  return o;
}

async function razorpayOrder(o) {
  const st = settings();
  if (!st.razorpayKeyId || !st.razorpayKeySecret) throw fail('NOT_CONFIGURED', 'Online payment is not switched on yet. Please try again later.', 503);
  const r = await fetch(RZP + '/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(st.razorpayKeyId + ':' + st.razorpayKeySecret).toString('base64') },
    body: JSON.stringify({ amount: Math.round(o.price * 100), currency: 'INR', receipt: o.ref, notes: { order: o.id, package: o.package } })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw fail('PAYMENT_DOWN', 'Could not start the payment. Please try again.', 502);
  o.razorpay = { orderId: j.id };
  return { key: st.razorpayKeyId, orderId: j.id, amount: Math.round(o.price * 100), currency: 'INR' };
}

const safeEq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function checkPaymentSignature(o, p) {
  const st = settings();
  if (!o.razorpay || p.razorpay_order_id !== o.razorpay.orderId) return false;
  const want = crypto.createHmac('sha256', st.razorpayKeySecret).update(o.razorpay.orderId + '|' + p.razorpay_payment_id).digest('hex');
  return safeEq(want, p.razorpay_signature);
}
function checkWebhookSignature(raw, sig) {
  const sec = settings().razorpayWebhookSecret;
  if (!sec || !raw) return false;
  return safeEq(crypto.createHmac('sha256', sec).update(raw).digest('hex'), sig);
}

// ---------- fulfilment (after payment) ----------
async function fulfil(o, { baseUrl }) {
  if (o.status !== 'paid') return o;
  o.status = 'in_progress';
  const pkg = PACKAGES[o.package];
  if (pkg.kind === 'vehicle') {
    const gl = require('./gridlines');
    o.checks = [];
    for (const api of pkg.apis) {
      try {
        const { txn, result } = await gl.call({ api, input: { rcNumber: o.input.vehicleNumber, vehicleNumber: o.input.vehicleNumber }, user: { email: 'consumer-app' }, vendorId: HOUSE_ID });
        o.checks.push({ api, label: txn.label, status: 'done', resultId: result.id });
      } catch (e) {
        o.checks.push({ api, label: gl.APIS[api] ? gl.APIS[api].label : api, status: 'failed', reason: gl.vendorReason(e.code) });
      }
    }
    const ok = o.checks.filter(c => c.status === 'done').length;
    o.status = ok ? 'completed' : 'needs_team';
    o.completedAt = ok ? new Date().toISOString() : undefined;
    return o;
  }
  // a person check: a case for SatyaSakshi's team, and the link for the person
  const h = house(), consumer = db.data.consumers.find(x => x.id === o.consumerId) || {};
  const { buildCase, customerLink } = require('../routes/cases');
  const acc = waAccount();
  const c = buildCase({ vendorId: h.id, claimNo: o.ref, insuredName: o.subject.name, whatsappNumber: '91' + o.subject.mobile, accountId: acc ? acc.id : null,
    verificationMode: 'full_automation', service: 'personal_check',
    details: { b2cPackage: o.package, b2cPackageName: pkg.name, orderId: o.ref, orderedBy: pkg.self ? 'Self' : (consumer.name || 'App user'), ...(pkg.self ? {} : { clientName: consumer.name || '' }) } });
  db.data.cases.push(c);
  db.data.custody.push({ id: uid('cust'), caseId: c.id, event: `Case opened from the SatyaSakshi Praman app — order ${o.ref}, ${pkg.name}${pkg.self ? ' (self check)' : ''}, paid ₹${o.price}`, actor: 'consumer_app', timestamp: new Date().toISOString() });
  o.caseId = c.id;
  o.subjectLink = customerLink(c, baseUrl);
  o.status = 'waiting_for_person';
  if (!pkg.self && acc) {
    const msg = require('./customer-message');
    try {
      const wa = require('./whatsapp');
      try { await wa.sendTextMessage(c.whatsappNumber, msg.text(c, { firm: h, joinUrl: o.subjectLink, kind: 'ai' }), acc); }
      catch { await msg.sendTemplate(c, acc, { firm: h, link: o.subjectLink }); }
      o.linkSentAt = new Date().toISOString();
      db.data.custody.push({ id: uid('cust'), caseId: c.id, event: 'Video call link sent to the person on WhatsApp', actor: 'system', timestamp: o.linkSentAt });
    } catch (e) {
      o.linkError = 'Could not send on WhatsApp. Share the link yourself.';
      db.data.custody.push({ id: uid('cust'), caseId: c.id, event: 'WhatsApp link not sent: ' + String(e.message).slice(0, 150), actor: 'system', timestamp: new Date().toISOString() });
    }
  } else if (!pkg.self) o.linkError = 'Share the link with the person on WhatsApp yourself.';
  require('./notifications').notify(h.id, { type: 'b2c_order', caseId: c.id, text: `New consumer-app order ${o.ref}: ${pkg.name} for ${o.subject.name}` });
  return o;
}

// Where an order stands, in the buyer's words, and links to the report / certificate when ready.
function view(o, { baseUrl } = {}) {
  const pkg = PACKAGES[o.package] || {};
  const out = { id: o.id, ref: o.ref, package: o.package, packageName: o.packageName, kind: o.kind, self: !!pkg.self, createdAt: o.createdAt, price: o.price, base: o.base, gst: o.gst, gstPercent: o.gstPercent,
    status: o.status, subject: o.subject ? { name: o.subject.name, mobile: '••••••' + o.subject.mobile.slice(-4) } : null, input: o.input || null };
  if (o.kind === 'vehicle') {
    out.checks = (o.checks || []).map(ch => {
      const r = ch.resultId && (db.data.apiResults || []).find(x => x.id === ch.resultId);
      return { label: ch.label, status: ch.status, reason: ch.reason || '', facts: r && r.data ? facts(r.data) : [] };
    });
    return out;
  }
  const c = o.caseId && db.data.cases.find(x => x.id === o.caseId);
  if (!c) return out;
  const a = c.aiCall || {};
  const reviewed = c.reviewState === 'reviewed' || c.reviewState === 'not_required' || (c.status === 'completed' && c.aiReview);
  out.status = reviewed ? 'report_ready' : a.status === 'completed' || a.status === 'handoff' ? 'under_review' : a.status === 'in_progress' ? 'call_in_progress' : 'waiting_for_person';
  if (out.status !== o.status && o.status !== 'created') o.status = out.status;
  out.linkError = o.linkError || '';
  if (pkg.self || !o.linkSentAt) out.subjectLink = o.subjectLink;   // self check: start the call; not sent: buyer shares it
  if (reviewed) {
    if (!c.shareToken) c.shareToken = uid('share') + uid('tok');
    out.verdict = (c.aiReview && c.aiReview.finalVerdict) || a.decision || '';
    out.reportUrl = `${baseUrl || ''}/ai-report.html?token=${encodeURIComponent(c.shareToken)}`;
    if (pkg.self && out.verdict === 'verified') {
      if (!o.certToken) { o.certToken = crypto.randomBytes(12).toString('hex'); o.certIssuedAt = new Date().toISOString(); }
      out.certUrl = `${baseUrl || ''}/c/cert.html?t=${o.certToken}`;
    }
  }
  return out;
}

// A vehicle record as short "label: value" lines (no long nested blobs).
function facts(data, prefix = '', out = []) {
  if (out.length >= 40 || data == null) return out;
  if (Array.isArray(data)) { data.slice(0, 5).forEach((x, i) => facts(x, prefix ? `${prefix} ${i + 1}` : String(i + 1), out)); return out; }
  if (typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      if (/^(request_id|code|status_code|raw|_)/i.test(k)) continue;
      facts(v, (prefix ? prefix + ' · ' : '') + k.replace(/_/g, ' '), out);
      if (out.length >= 40) break;
    }
    return out;
  }
  const s = String(data).trim();
  if (s) out.push([prefix || 'value', s.slice(0, 120)]);
  return out;
}

// The public certificate (self check): only what the person agreed to show.
function certificate(token) {
  const o = (db.data.b2cOrders || []).find(x => x.certToken && x.certToken === token);
  if (!o) return null;
  const c = db.data.cases.find(x => x.id === o.caseId);
  const valid = new Date(new Date(o.certIssuedAt).getTime() + 182 * 86400e3);
  return { name: o.subject.name, mobile: '••••••' + o.subject.mobile.slice(-4), ref: o.ref, verifiedOn: o.certIssuedAt, validUntil: valid.toISOString(), expired: Date.now() > valid.getTime(),
    checks: ['Identity documents seen on a live video call', 'Face match and liveness', 'Live location and address', 'Reviewed by a SatyaSakshi verifier'],
    verdict: c && c.aiReview ? c.aiReview.finalVerdict : 'verified' };
}

module.exports = { HOUSE_ID, settings, catalogue, house, sendLoginCode, newOrder, razorpayOrder, checkPaymentSignature, checkWebhookSignature, fulfil, view, certificate, last10 };
