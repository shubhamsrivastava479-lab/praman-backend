const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers');
process.env.DEMO_RATE_MAX = '100';
const http = require('http');
const notifications = require('../src/services/notifications');
const { db } = require('../src/db');
const captcha = require('../src/services/captcha');
const pic = () => { const c = captcha.create(); return { captchaId: c.id, captchaAnswer: c.answer }; };

const valid = { email: 'ravi@acmeinsure.in', name: 'Ravi Kumar', designation: 'Head of Claims', company: 'Acme Insurance', phone: '+91 98765 43210', idNumber: '27AAPFU0939F1ZV', city: 'Pune', country: 'India' };

test('demo request form: validation, email code, saved for the Super Admin', async () => {
  const { app } = require('../src/server');
  await db.read();
  const server = http.createServer(app); await new Promise(r => server.listen(0, r));
  test.after(() => server.close());
  const port = server.address().port;
  const call = (method, path, body) => new Promise(r => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ port, path, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => r({ s: res.statusCode, j: b ? JSON.parse(b) : {} })); });
    req.end(data);
  });

  // no e-mail sending set up: form still works, e-mail marked not verified
  assert.equal((await call('GET', '/api/demo/config')).j.otp, false);
  assert.equal((await call('POST', '/api/demo/request', { ...valid, email: 'ravi@gmail.com' })).s, 400);          // free mail
  assert.equal((await call('POST', '/api/demo/request', { ...valid, idNumber: '12345' })).s, 400);                // bad GST / PAN
  assert.equal((await call('POST', '/api/demo/request', { ...valid, phone: '12' })).s, 400);
  assert.equal((await call('POST', '/api/demo/request', { ...valid, company: '' })).s, 400);
  assert.equal((await call('POST', '/api/demo/request', { ...valid, ...pic(), website: 'bot' })).s, 200);                   // honeypot: nothing saved
  assert.equal((db.data.demoRequests || []).length, 0);
  assert.equal((await call('POST', '/api/demo/request', valid)).s, 400);                                           // no picture code
  assert.equal((await call('POST', '/api/demo/request', { ...valid, captchaId: pic().captchaId, captchaAnswer: 'WRONG' })).s, 400);
  const reuse = pic();
  assert.equal((await call('POST', '/api/demo/request', { ...valid, ...reuse })).s, 201);
  assert.equal((await call('POST', '/api/demo/request', { ...valid, email: 'z@acmeinsure.in', ...reuse })).s, 400); // one try per picture
  assert.equal(db.data.demoRequests[0].emailVerified, false);
  assert.equal(db.data.demoRequests[0].idType, 'GST');
  assert.equal((await call('POST', '/api/demo/request', { ...valid, ...pic(), email: 'a@acmeinsure.in', idNumber: 'abcde1234f' })).s, 201); // PAN, lower case
  assert.equal(db.data.demoRequests[1].idType, 'PAN');

  // with e-mail sending: a code is needed
  let mailed = null;
  notifications.transport = () => ({});
  notifications.sendMail = async (to, subject, text) => { if (/verification code/.test(subject)) mailed = { to, text }; return true; };
  assert.equal((await call('GET', '/api/demo/config')).j.otp, true);
  assert.equal((await call('POST', '/api/demo/request', { ...valid, email: 'b@acmeinsure.in' })).s, 400);          // no code yet
  assert.equal((await call('POST', '/api/demo/otp', { email: 'b@acmeinsure.in' })).s, 400);                        // needs picture code
  assert.equal((await call('POST', '/api/demo/otp', { email: 'b@acmeinsure.in', ...pic() })).s, 200);
  const code = mailed.text.match(/\b(\d{6})\b/)[1];
  assert.equal(mailed.to, 'b@acmeinsure.in');
  assert.equal((await call('POST', '/api/demo/otp', { email: 'b@acmeinsure.in', ...pic() })).s, 429);                        // 30 s wait
  assert.equal((await call('POST', '/api/demo/request', { ...valid, email: 'b@acmeinsure.in', code: code === '000000' ? '111111' : '000000' })).s, 400);
  assert.equal((await call('POST', '/api/demo/request', { ...valid, email: 'c@acmeinsure.in', code })).s, 400);    // code of another e-mail
  assert.equal((await call('POST', '/api/demo/request', { ...valid, email: 'b@acmeinsure.in', code })).s, 201);
  assert.equal(db.data.demoRequests.at(-1).emailVerified, true);
  assert.equal((await call('POST', '/api/demo/request', { ...valid, email: 'b@acmeinsure.in', code })).s, 400);    // code works once

  // only the Super Admin can read them
  assert.equal((await call('GET', '/api/super-admin/demo-requests')).s, 401);
});
