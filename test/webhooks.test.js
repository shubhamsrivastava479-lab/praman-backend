require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const wh = require('../src/services/webhooks');

test('signature verifies, and breaks if the body or secret changes', () => {
  const body = JSON.stringify({ a: 1 });
  const { header } = wh.sign('whsec_x', body);
  assert.equal(wh.verifySignature('whsec_x', body, header), true);
  assert.equal(wh.verifySignature('whsec_x', body + ' ', header), false);
  assert.equal(wh.verifySignature('whsec_y', body, header), false);
  assert.equal(wh.verifySignature('whsec_x', body, 'garbage'), false);
  const old = wh.sign('whsec_x', body, Math.floor(Date.now() / 1000) - 3600).header;
  assert.equal(wh.verifySignature('whsec_x', body, old), false); // replay of an old delivery
});

test('private and internal addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.5.5', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '0.0.0.0'])
    assert.equal(wh.isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) assert.equal(wh.isPrivateIp(ip), false, ip);
});

test('webhook address must be https and free of credentials', () => {
  const saved = process.env.ALLOW_HTTP_WEBHOOKS;
  process.env.ALLOW_HTTP_WEBHOOKS = '0';
  assert.ok(wh.checkUrlShape('http://example.com/hook'));
  assert.ok(wh.checkUrlShape('https://user:pw@example.com/hook'));
  assert.ok(wh.checkUrlShape('not a url'));
  assert.equal(wh.checkUrlShape('https://example.com/hook'), null);
  process.env.ALLOW_HTTP_WEBHOOKS = saved;
});

test('private-network addresses are refused (unless the test switch is on)', async () => {
  const saved = process.env.ALLOW_PRIVATE_WEBHOOKS;
  process.env.ALLOW_PRIVATE_WEBHOOKS = '0';
  await assert.rejects(() => wh.assertPublicUrl('https://127.0.0.1/hook'), /private/);
  await assert.rejects(() => wh.assertPublicUrl('https://169.254.169.254/latest'), /private/);
  process.env.ALLOW_PRIVATE_WEBHOOKS = saved;
});

const firm = { id: 'f1', integration: { webhookSecret: 'whsec_t' } };
const mk = () => ({ id: 'wh1', event: 'ai_call.completed', url: 'https://hooks.example.com/x', payload: '{"ok":1}', attempts: 0, status: 'pending' });

test('a delivery is signed and marked delivered on 2xx', async () => {
  const d = mk(); let seen;
  const ok = await wh.deliverOne(d, firm, async (url, opt) => { seen = opt; return { status: 200 }; });
  assert.equal(ok, true); assert.equal(d.status, 'delivered');
  assert.equal(seen.headers['X-Praman-Event'], 'ai_call.completed');
  assert.equal(wh.verifySignature('whsec_t', d.payload, seen.headers['X-Praman-Signature']), true);
});

test('a failed delivery is retried later, then given up after the last retry', async () => {
  const d = mk();
  const bad = async () => ({ status: 500 });
  await wh.deliverOne(d, firm, bad);
  assert.equal(d.status, 'pending'); assert.equal(d.attempts, 1); assert.ok(new Date(d.nextAt) > new Date());
  assert.match(d.lastError, /500/);
  for (let i = 0; i < wh.RETRY_MINUTES.length; i++) await wh.deliverOne(d, firm, bad);
  assert.equal(d.status, 'failed'); assert.equal(d.nextAt, null);
});

test('a network error is treated like a failure, not a crash', async () => {
  const d = mk();
  await wh.deliverOne(d, firm, async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(d.status, 'pending'); assert.match(d.lastError, /ECONNREFUSED/);
});

test('API keys look right and only their hash is meant to be stored', () => {
  const k = wh.newApiKey();
  assert.match(k, /^pk_live_[a-f0-9]{48}$/);
  assert.notEqual(wh.sha256(k), k);
  assert.match(wh.newSecret(), /^whsec_/);
});
