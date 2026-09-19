const express = require('express');
const { db, uid } = require('../db');
const { requireAuth } = require('../middleware/auth');
const wa = require('../services/whatsapp');

const router = express.Router();
router.use(requireAuth);

// List the logged-in vendor's connected WhatsApp numbers
router.get('/', async (req, res) => {
  await db.read();
  const accounts = db.data.whatsappAccounts
    .filter(a => a.vendorId === req.user.vendorRootId)
    .map(a => ({ // never send the token/secret back to the browser
      id: a.id,
      displayPhoneNumber: a.displayPhoneNumber,
      verifiedName: a.verifiedName,
      phoneNumberId: a.phoneNumberId,
      connectedAt: a.connectedAt
    }));
  res.json(accounts);
});

// Connect a new WhatsApp Business number: vendor pastes in their own token,
// phone number ID, and app secret from their own Meta Developer App.
router.post('/', async (req, res) => {
  const { token, phoneNumberId, appSecret } = req.body;
  if (!token || !phoneNumberId) {
    return res.status(400).json({ error: 'token and phoneNumberId are required' });
  }

  // Verify the credentials actually work before saving them.
  let info;
  try {
    info = await wa.verifyCredentials({ token, phoneNumberId });
  } catch (err) {
    return res.status(400).json({ error: `Could not verify WhatsApp credentials: ${err.message}` });
  }

  await db.read();
  if (db.data.whatsappAccounts.find(a => a.phoneNumberId === phoneNumberId)) {
    return res.status(409).json({ error: 'This WhatsApp number is already connected to a vendor account' });
  }

  const account = {
    id: uid('wa'),
    vendorId: req.user.vendorRootId,
    token,
    phoneNumberId,
    appSecret: appSecret || null,
    displayPhoneNumber: info.display_phone_number,
    verifiedName: info.verified_name,
    connectedAt: new Date().toISOString()
  };
  db.data.whatsappAccounts.push(account);
  await db.write();
  res.status(201).json({
    id: account.id,
    displayPhoneNumber: account.displayPhoneNumber,
    verifiedName: account.verifiedName,
    phoneNumberId: account.phoneNumberId
  });
});

router.delete('/:id', async (req, res) => {
  await db.read();
  const idx = db.data.whatsappAccounts.findIndex(a => a.id === req.params.id && a.vendorId === req.user.vendorRootId);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.data.whatsappAccounts.splice(idx, 1);
  await db.write();
  res.json({ ok: true });
});

module.exports = router;
