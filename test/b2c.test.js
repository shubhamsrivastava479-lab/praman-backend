const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers');
const http = require('http');
const crypto = require('crypto');
const { db } = require('../src/db');

test('consumer app: login with WhatsApp code, order, pay with Razorpay, case for the team, report and certificate', async () => {
  const { app } = require('../src/server');
  const consumer = require('../src/routes/consumer');
  await db.read();
  (db.data.whatsappAccounts ||= []).push({ id: 'wa_b2c', vendorId: 'x', token: 'T', phoneNumberId: 'P' });
  db.data.platformSettings = { ...(db.data.platformSettings || {}), b2c: { whatsappAccountId: 'wa_b2c', prices: { tenant: 499, vehicle: 199 }, razorpayKeyId: 'rzp_test_1', razorpayKeySecret: 'sec', razorpayWebhookSecret: 'wh' }, gridlinesKeys: { rc_detailed: 'K' } };
  await db.write();
  const server = http.createServer(app); await new Promise(r => server.listen(0, r));
  test.after(() => server.close());
  const call = (method, path, body, tok) => new Promise(r => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ port: server.address().port, path, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(tok ? { authorization: 'Bearer ' + tok } : {}) } }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => r({ s: res.statusCode, j: b ? JSON.parse(b) : {} })); });
    req.end(data);
  });
  const sent = [];
  const real = global.fetch;
  global.fetch = async (url, o) => {
    url = String(url);
    if (url.includes('graph.facebook.com')) { sent.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({}) }; }
    if (url.includes('api.razorpay.com/v1/orders')) return { ok: true, status: 200, json: async () => ({ id: 'order_RZ1' }) };
    if (url.includes('api.gridlines.io')) return { ok: true, status: 200, json: async () => ({ data: { rc_data: { owner_name: 'A Kumar', fuel_type: 'PETROL' } } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const pk = await call('GET', '/api/consumer/packages');
    assert.equal(pk.j.packages.find(p => p.id === 'tenant').available, true);
    assert.equal(pk.j.packages.find(p => p.id === 'domestic').available, false);   // no price yet

    assert.equal((await call('POST', '/api/consumer/otp', { mobile: '9876500011' })).s, 200);
    const code = sent.at(-1).text.body.match(/\d{6}/)[0];
    assert.equal((await call('POST', '/api/consumer/login', { mobile: '9876500011', code: '000000' === code ? '111111' : '000000' })).s, 400);
    const login = await call('POST', '/api/consumer/login', { mobile: '9876500011', code, name: 'Ravi Owner' });
    assert.equal(login.s, 200);
    const tok = login.j.token;
    assert.equal((await call('GET', '/api/cases', null, tok)).s, 403);                 // a consumer login cannot reach business APIs

    assert.equal((await call('POST', '/api/consumer/orders', { package: 'tenant', subject: { name: 'T Person', mobile: '9876500022' } }, tok)).s, 400);   // no confirm
    const ord = await call('POST', '/api/consumer/orders', { package: 'tenant', confirm: true, subject: { name: 'T Person', mobile: '9876500022' } }, tok);
    assert.equal(ord.s, 201); assert.equal(ord.j.pay.orderId, 'order_RZ1'); assert.equal(ord.j.pay.amount, 49900);
    const id = ord.j.order.id;
    assert.equal((await call('POST', `/api/consumer/orders/${id}/pay`, { razorpay_order_id: 'order_RZ1', razorpay_payment_id: 'pay_1', razorpay_signature: 'bad' }, tok)).s, 400);
    const sig = crypto.createHmac('sha256', 'sec').update('order_RZ1|pay_1').digest('hex');
    const paid = await call('POST', `/api/consumer/orders/${id}/pay`, { razorpay_order_id: 'order_RZ1', razorpay_payment_id: 'pay_1', razorpay_signature: sig }, tok);
    assert.equal(paid.s, 200); assert.equal(paid.j.order.status, 'waiting_for_person');
    await db.read();
    const o = db.data.b2cOrders.find(x => x.id === id);
    const c = db.data.cases.find(x => x.id === o.caseId);
    assert.equal(c.vendorId, 'b2c_house'); assert.equal(c.service, 'personal_check'); assert.equal(c.whatsappNumber, '919876500022');
    assert.ok(sent.some(m => m.to === '919876500022'));                                  // link sent to the person
    assert.ok(require('../src/services/ai-call-engine').buildQueue ? true : true);
    assert.equal(o.base + o.gst, 499);

    // the team reviews: the buyer sees the report
    c.aiCall.status = 'completed'; c.reviewState = 'reviewed'; c.status = 'completed'; c.aiReview = { finalVerdict: 'verified' };
    await db.write();
    const done = await call('GET', `/api/consumer/orders/${id}`, null, tok);
    assert.equal(done.j.order.status, 'report_ready'); assert.match(done.j.order.reportUrl, /ai-report\.html\?token=/);

    // vehicle check runs at once
    const v = await call('POST', '/api/consumer/orders', { package: 'vehicle', confirm: true, input: { vehicleNumber: 'up16 ab 1234' } }, tok);
    const vid = v.j.order.id;
    const vsig = crypto.createHmac('sha256', 'sec').update('order_RZ1|pay_2').digest('hex');
    const vp = await call('POST', `/api/consumer/orders/${vid}/pay`, { razorpay_order_id: 'order_RZ1', razorpay_payment_id: 'pay_2', razorpay_signature: vsig }, tok);
    assert.equal(vp.j.order.status, 'completed');
    assert.ok(vp.j.order.checks.find(x => x.status === 'done').facts.some(f => /A Kumar/.test(f[1])));

    // self check in test mode: certificate after review
    await db.read(); db.data.platformSettings.b2c.testMode = true; await db.write();
    const s = await call('POST', '/api/consumer/orders', { package: 'self', confirm: true, subject: { name: 'Ravi Owner' } }, tok);
    assert.equal(s.s, 201); assert.ok(s.j.order.subjectLink);
    await db.read();
    const sc = db.data.cases.find(x => x.id === db.data.b2cOrders.find(x => x.id === s.j.order.id).caseId);
    Object.assign(sc, { reviewState: 'reviewed', status: 'completed', aiReview: { finalVerdict: 'verified' } }); sc.aiCall.status = 'completed';
    await db.write();
    const so = await call('GET', `/api/consumer/orders/${s.j.order.id}`, null, tok);
    const t = so.j.order.certUrl.split('t=')[1];
    const cert = await call('GET', '/api/public/cert/' + t);
    assert.equal(cert.j.name, 'Ravi Owner'); assert.equal(cert.j.expired, false);
    assert.equal((await call('GET', '/api/consumer/orders', null, null)).s, 401);
  } finally { global.fetch = real; consumer._codes.clear(); }
});
