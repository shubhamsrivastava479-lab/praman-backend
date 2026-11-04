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
