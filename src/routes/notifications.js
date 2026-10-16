const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const ntf = require('../services/notifications');
const followup = require('../services/followup');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  await db.read();
  res.json(ntf.listFor(req.user));
});

router.post('/read', async (req, res) => {
  await db.read();
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String).slice(0, 500) : null;
  ntf.markRead(req.user, ids);
  await db.write();
  res.json({ ok: true });
});

// canned remarks for the review form (set by the firm admin in settings)
router.get('/review-options', async (req, res) => {
  await db.read();
  const firm = (db.data.users || []).find(u => u.id === req.user.vendorRootId);
  const s = followup.settingsOf(firm);
  res.json({ cannedRemarks: s.cannedRemarks, secondReviewAbove: s.secondReviewAbove });
});

module.exports = router;
