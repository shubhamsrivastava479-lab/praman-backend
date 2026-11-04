// The ONE WhatsApp Business number every message is sent from: "Praman by SatyaSakshi".
// Vendors never connect their own number. Super Admin adds it once (Super Admin → WhatsApp number).
const { db } = require('../db');

const PLATFORM_VENDOR = 'platform';

function account(data = db.data) {
  const list = data.whatsappAccounts || [];
  const ps = data.platformSettings || {};
  const id = ps.whatsappAccountId || (ps.b2c && ps.b2c.whatsappAccountId);
  return (id && list.find(a => a.id === id)) || list.find(a => a.vendorId === PLATFORM_VENDOR) || null;
}
const accountId = (data = db.data) => (account(data) || {}).id || null;

// The account to send a case's messages from: always the platform number when it is set,
// otherwise whatever the (older) case already points to.
function forCase(c, data = db.data) {
  return account(data) || (data.whatsappAccounts || []).find(a => a.id === c.whatsappAccountId) || null;
}

module.exports = { account, accountId, forCase, PLATFORM_VENDOR };
