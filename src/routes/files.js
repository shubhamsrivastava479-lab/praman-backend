// Permanent links for files inside a shared report:  /f/<shareToken>/<evidenceId>
//
// The storage bucket is private and its signed links expire after an hour,
// so a PDF of the report could not hold them. Instead the report holds this
// short link; each click checks that the share link is still active and that
// the file belongs to that case, then sends the viewer to a fresh signed link.
// Revoking the case's share link (regenerate) disables every file link too.
const express = require('express');
const { db } = require('../db');
const storage = require('../services/storage');
const { rateLimit } = require('../services/security');

const router = express.Router();
router.use(rateLimit({ windowMs: 60_000, max: 240 }));

router.get('/:token/:evidenceId', async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.shareToken && x.shareToken === req.params.token);
  const ev = c && db.data.evidence.find(e => e.id === req.params.evidenceId && e.caseId === c.id);
  if (!ev || !ev.fileUrl) {
    return res.status(404).type('html').send('<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;padding:40px;text-align:center;color:#444">This file link is not valid, or the report link was turned off by the investigator.</body>');
  }
  const url = await storage.signedUrl(ev.fileUrl);
  res.set('Cache-Control', 'no-store');
  res.redirect(302, url);
});

module.exports = router;
