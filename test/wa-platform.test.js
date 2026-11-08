const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers');
const fs = require('fs'), path = require('path');
const plat = require('../src/services/wa-platform');

test('one platform WhatsApp number serves every vendor', () => {
  const data = { whatsappAccounts: [{ id: 'v1', vendorId: 'firmA', phoneNumberId: '1' }, { id: 'p1', vendorId: 'platform', phoneNumberId: '2' }], platformSettings: { whatsappAccountId: 'p1' } };
  assert.equal(plat.accountId(data), 'p1');
  assert.equal(plat.forCase({ whatsappAccountId: 'v1' }, data).id, 'p1');      // old case on a vendor number -> platform number
  assert.equal(plat.account({ whatsappAccounts: [], platformSettings: {} }), null);
  assert.equal(plat.forCase({ whatsappAccountId: 'v1' }, { whatsappAccounts: [{ id: 'v1' }] }).id, 'v1'); // nothing set yet: old number still works
});

test('vendors have no WhatsApp connect screen and the API is Super Admin only', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(!/Verify & connect|connectWhatsApp|whatsappAccountSelect/.test(html));
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/whatsapp-accounts.js'), 'utf8');
  assert.ok(/super_admin/.test(route));
});

test('phone numbers are completed with the country code before sending', () => {
  const { normalizePhone } = require('../src/services/whatsapp');
  assert.equal(normalizePhone('98765 43210'), '919876543210');
  assert.equal(normalizePhone('+91 98765-43210'), '919876543210');
  assert.equal(normalizePhone('09876543210'), '919876543210');
  assert.equal(normalizePhone('0091 9876543210'), '919876543210');
  assert.equal(normalizePhone('14155550123'), '14155550123');
});

test('a case can be sent to its main number, the alternate number, or both', async () => {
  const msg = require('../src/services/customer-message'), wa = require('../src/services/whatsapp');
  const c = { whatsappNumber: '919876543210', altNumber: '9123456789' };
  assert.deepEqual(msg.recipients(c, 'primary'), ['919876543210']);
  assert.deepEqual(msg.recipients(c, 'alt'), ['919123456789']);
  assert.deepEqual(msg.recipients(c, 'both'), ['919876543210', '919123456789']);
  assert.deepEqual(msg.recipients({ whatsappNumber: '919876543210' }, 'both'), ['919876543210']);
  const calls = [], orig = wa.sendTextMessage;
  wa.sendTextMessage = async n => { calls.push(n); if (n.endsWith('3210')) throw new Error('first number failed'); };
  try {
    const r = await msg.sendText(c, 'hi', {}, 'both');          // one number failing does not stop the other
    assert.deepEqual(r.sent, ['919123456789']); assert.deepEqual(r.failed, ['919876543210']);
    await assert.rejects(() => msg.sendText({ whatsappNumber: '919876543210' }, 'hi', {}, 'alt'), /no alternate number/);
  } finally { wa.sendTextMessage = orig; }
});
