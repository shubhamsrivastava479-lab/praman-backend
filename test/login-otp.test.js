const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers');
process.env.DEMO_RATE_MAX = '100';
const http = require('http');
const notifications = require('../src/services/notifications');
const captcha = require('../src/services/captcha');
const { hashPassword } = require('../src/services/auth');
const { db, uid } = require('../src/db');
const plans = require('../src/services/plans');
const pic = () => { const c = captcha.create(); return { captchaId: c.id, captchaAnswer: c.answer }; };

test('login needs an email code; forgot password; register with an official email', async () => {
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
  const mails = [];
  const lastCode = () => mails.at(-1).text.match(/\b(\d{6})\b/)[1];

  const vendor = { id: uid('user'), email: 'owner@acmeinsure.in', vendorName: 'Acme', role: 'vendor_admin', approved: true, passwordHash: await hashPassword('Secret123'), createdAt: new Date().toISOString() };
  const agent = { id: uid('user'), email: 'agent@acmeinsure.in', vendorName: 'Acme', role: 'agent', parentVendorId: vendor.id, agentName: 'A', passwordHash: await hashPassword('Secret123'), createdAt: new Date().toISOString() };
  db.data.users.push(vendor, agent);

  // no email service: login works as before, nobody is locked out
  let r = await call('POST', '/api/auth/login', { email: vendor.email, password: 'Secret123' });
  assert.equal(r.s, 200); assert.ok(r.j.token);

  notifications.transport = () => ({});
  notifications.sendMail = async (to, subject, text) => { mails.push({ to, subject, text }); return true; };

  // password step ok -> email code step
  r = await call('POST', '/api/auth/login', { email: vendor.email, password: 'wrong' });
  assert.equal(r.s, 401);
  r = await call('POST', '/api/auth/login', { email: vendor.email, password: 'Secret123' });
  assert.equal(r.s, 200); assert.equal(r.j.otpRequired, true); assert.ok(!r.j.token);
  assert.equal(mails.at(-1).to, vendor.email);
  const ch = r.j.challenge;
  assert.equal((await call('POST', '/api/auth/login-otp/verify', { challenge: ch, code: '000000' === lastCode() ? '111111' : '000000' })).s, 400);
  r = await call('POST', '/api/auth/login-otp/verify', { challenge: ch, code: lastCode() });
  assert.equal(r.s, 200); assert.ok(r.j.token); assert.equal(r.j.user.role, 'vendor_admin');
  assert.equal((await call('POST', '/api/auth/login-otp/verify', { challenge: ch, code: lastCode() })).s, 400);   // works once

  // agents (insurer, viewer) get the same step
  r = await call('POST', '/api/auth/login', { email: agent.email, password: 'Secret123' });
  assert.equal(r.j.otpRequired, true);

  // switched off by the server setting
  process.env.LOGIN_OTP = 'off';
  r = await call('POST', '/api/auth/login', { email: vendor.email, password: 'Secret123' });
  assert.ok(r.j.token); delete process.env.LOGIN_OTP;

  // forgot password: same answer for unknown addresses, no mail sent for them
  const before = mails.length;
  assert.equal((await call('POST', '/api/auth/forgot', { email: vendor.email })).s, 400);                        // no picture code
  assert.equal((await call('POST', '/api/auth/forgot', { email: 'nobody@acmeinsure.in', ...pic() })).j.ok, true);
  assert.equal(mails.length, before);
  assert.equal((await call('POST', '/api/auth/forgot', { email: vendor.email, ...pic() })).j.ok, true);
  assert.equal(mails.length, before + 1);
  assert.equal((await call('POST', '/api/auth/reset', { email: vendor.email, code: '000000' === lastCode() ? '111111' : '000000', password: 'NewPass123' })).s, 400);
  assert.equal((await call('POST', '/api/auth/reset', { email: vendor.email, code: lastCode(), password: 'short' })).s, 400);   // weak password
  assert.equal((await call('POST', '/api/auth/reset', { email: vendor.email, code: lastCode(), password: 'NewPass123' })).j.ok, true);
  assert.equal((await call('POST', '/api/auth/login', { email: vendor.email, password: 'Secret123' })).s, 401);
  assert.equal((await call('POST', '/api/auth/login', { email: vendor.email, password: 'NewPass123' })).j.otpRequired, true);

  // register a firm with an official email
  assert.equal((await call('POST', '/api/auth/register-email/code', { email: 'boss@gmail.com', ...pic() })).s, 400);   // not official
  assert.equal((await call('POST', '/api/auth/register-email/code', { email: vendor.email, ...pic() })).s, 409);       // already registered
  assert.equal((await call('POST', '/api/auth/register-email/code', { email: 'boss@newfirm.in', ...pic() })).s, 200);
  const v = await call('POST', '/api/auth/register-email/verify', { email: 'boss@newfirm.in', code: lastCode() });
  assert.equal(v.s, 200); assert.ok(v.j.onboardToken);
  const form = { onboardToken: v.j.onboardToken, firmName: 'New Firm', contactName: 'Boss', contactEmail: 'boss@newfirm.in', mobile: '9876543210', pan: 'ABCDE1234F', address: '12 Main Road, Pune', city: 'Pune', state: 'Maharashtra', pincode: '411001', services: [plans.ALL[0]] };
  assert.equal((await call('POST', '/api/auth/vendor-register', form)).s, 400);                                         // password needed
  assert.equal((await call('POST', '/api/auth/vendor-register', { ...form, password: 'Firm12345' })).s, 201);
  const u = db.data.users.find(x => x.email === 'boss@newfirm.in');
  assert.equal(u.signupMethod, 'email'); assert.equal(u.approved, false);
  assert.equal((await call('POST', '/api/auth/login', { email: 'boss@newfirm.in', password: 'Firm12345' })).s, 403); // waits for approval
});

test('email through Brevo web API', async () => {
  const n = require('../src/services/notifications');
  delete require.cache[require.resolve('../src/services/notifications')];
  const fresh = require('../src/services/notifications');
  process.env.BREVO_API_KEY = 'k'; process.env.MAIL_FROM = 'Praman <no-reply@pramanservices.space>';
  const real = global.fetch; let seen;
  global.fetch = async (url, o) => { seen = { url, o }; return { ok: true, text: async () => '' }; };
  try {
    assert.ok(fresh.transport());
    assert.equal(await fresh.sendMail('a@b.in', 'Hi', 'Code 123456'), true);
    assert.equal(seen.url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(seen.o.headers['api-key'], 'k');
    const b = JSON.parse(seen.o.body);
    assert.deepEqual(b.sender, { name: 'Praman', email: 'no-reply@pramanservices.space' });
    assert.deepEqual(b.to, [{ email: 'a@b.in' }]); assert.equal(b.textContent, 'Code 123456');
    global.fetch = async () => ({ ok: false, status: 401, text: async () => 'bad key' });
    assert.equal(await fresh.sendMail('a@b.in', 'Hi', 'x'), false);       // failure is reported, not thrown
  } finally { global.fetch = real; delete process.env.BREVO_API_KEY; }
});
