const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers');
const http = require('http');
const { db } = require('../src/db');

test('customer joins with mobile number + WhatsApp code and sees only their own open calls', async () => {
  const { app } = require('../src/server');
  const join = require('../src/routes/customer-join');
  await db.read();
  db.data.users.push({ id: 'fj', role: 'vendor_admin', vendorName: 'Acme Verify', email: 'a@acme.in' });
  (db.data.whatsappAccounts ||= []).push({ id: 'wa1', token: 'T', phoneNumberId: 'P' });
  db.data.cases.push(
    { id: 'cj1', vendorId: 'fj', claimNo: 'POL98765', whatsappNumber: '919876501234', whatsappAccountId: 'wa1', status: 'in_progress', caseType: 'policy_verification', policyType: 'life', verificationMode: 'full_automation', aiCall: { token: 'tok1', status: 'not_started' }, createdAt: new Date().toISOString() },
    { id: 'cj2', vendorId: 'fj', claimNo: 'POL11111', whatsappNumber: '919876501234', whatsappAccountId: 'wa1', status: 'completed', caseType: 'policy_verification', createdAt: new Date().toISOString() });
  await db.write();
  const server = http.createServer(app); await new Promise(r => server.listen(0, r));
  test.after(() => server.close());
  const post = (p, body) => new Promise(r => {
    const data = JSON.stringify(body);
    const req = http.request({ port: server.address().port, path: '/api/public/customer/' + p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => r({ s: res.statusCode, j: b ? JSON.parse(b) : {} })); });
    req.end(data);
  });
  let sent = null;
  const real = global.fetch;
  global.fetch = async (url, o) => { sent = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    assert.equal((await post('otp', { mobile: '12345' })).s, 400);
    const unknown = await post('otp', { mobile: '9000000000' });           // no case: same answer, nothing sent
    assert.equal(unknown.s, 200); assert.equal(sent, null);
    const r = await post('otp', { mobile: '+91 98765 01234' });
    assert.equal(r.j.message, unknown.j.message);
    const code = sent.text.body.match(/\d{6}/)[0];
    assert.equal(sent.to, '919876501234');
    assert.equal((await post('verify', { mobile: '9876501234', code: code === '111111' ? '222222' : '111111' })).s, 400);
    const ok = await post('verify', { mobile: '9876501234', code });
    assert.equal(ok.s, 200);
    assert.equal(ok.j.calls.length, 1);                                    // the completed case is not listed
    assert.match(ok.j.calls[0].url, /ai-call\.html\?t=tok1/);
    assert.equal(ok.j.calls[0].firm, 'Acme Verify');
    assert.equal(ok.j.calls[0].ref, '••••8765');
    assert.equal((await post('verify', { mobile: '9876501234', code })).s, 400); // a code works once
  } finally { global.fetch = real; join._codes.clear(); }
});
