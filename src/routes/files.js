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
  if (ev && ev.purgedAt) {
    return res.status(410).type('html').send('<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;padding:40px;text-align:center;color:#444">This file was deleted after the retention period ended. The report and the record of the verification are still available.</body>');
  }
  if (!ev || !ev.fileUrl) {
    return res.status(404).type('html').send('<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;padding:40px;text-align:center;color:#444">This file link is not valid, or the report link was turned off by the investigator.</body>');
  }
  // Files saved on the server's own disk before cloud storage was connected are
  // wiped when the host restarts or redeploys — say so instead of a bare 404.
  if (String(ev.fileUrl).startsWith('/')) {
    const fs = require('fs'), path = require('path');
    const local = path.join(storage.mediaDir, path.basename(ev.fileUrl));
    if (!fs.existsSync(local)) {
      return res.status(410).type('html').send('<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;padding:40px;text-align:center;color:#444">This file is no longer available. It was saved before cloud storage was connected and was lost when the server restarted.</body>');
    }
  }
  const url = await storage.signedUrl(ev.fileUrl);
  res.set('Cache-Control', 'no-store');
  res.redirect(302, url);
});

module.exports = router;
