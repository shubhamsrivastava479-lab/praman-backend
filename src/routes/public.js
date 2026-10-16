const express = require('express');
const { db } = require('../db');
const { rateLimit } = require('../services/security');
const storage = require('../services/storage');
const { buildAiReport } = require('../services/ai-report');
const { documentRows, recordingRows, chatRows } = require('../services/report-files');

const router = express.Router();
router.use(rateLimit({ windowMs: 60_000, max: 30 })); // protects against token-guessing

// No requireAuth here on purpose — this is what the shared link uses.
// Only fields safe to show an external viewer are returned: no vendor
// internals, no WhatsApp/KYC credentials, nothing beyond this one case's
// own evidence, transcript, and report.
router.get('/case/:token', async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.shareToken === req.params.token);
  if (!c) return res.status(404).json({ error: 'This link is invalid or has been revoked.' });

  const evidence = await storage.signEvidenceList(db.data.evidence
    .filter(e => e.caseId === c.id)
    .map(e => ({ type: e.type, source: e.source, caption: e.caption, fileUrl: e.fileUrl, receivedAt: e.receivedAt })));
  const transcripts = db.data.transcripts
    .filter(t => t.caseId === c.id)
    .map(t => ({ speaker: t.speaker, english: t.english, language: t.language, timestamp: t.timestamp }));
  const report = db.data.reports.filter(r => r.caseId === c.id).slice(-1)[0] || null;

  const raw = db.data.evidence.filter(e => e.caseId === c.id);
  res.json({
    documents: documentRows(c, raw),
    recordings: recordingRows(c, raw),
    chats: chatRows(c, raw),
    caseRef: c.caseRef || '',
    claimNo: c.claimNo,
    insuredName: c.insuredName,
    vehicleNo: c.vehicleNo,
    district: c.district,
    policyNo: c.policyNo,
    caseType: c.caseType,
    status: c.status,
    pivcChecklist: c.pivcChecklist,
    pivcResult: c.pivcResult,
    hasAiReport: !!(c.aiCall && ['completed', 'handoff'].includes(c.aiCall.status)),
    lastKnownLocation: c.lastKnownLocation || null,
    reportFields: c.reportFields,
    evidence,
    transcripts,
    report: report ? { html: report.html, generatedAt: report.generatedAt } : null
  });
});

// Who to write to about privacy (shown on the privacy page).
router.get('/privacy-info', async (req, res) => {
  await db.read();
  const ps = db.data.platformSettings || {};
  res.json({ contact: process.env.PRIVACY_CONTACT_EMAIL || ps.privacyContact || '' });
});

// PDF of the report for an external viewer (same shared token).
router.get('/ai-report/:token/pdf', async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.shareToken && x.shareToken === req.params.token);
  if (!c || !c.aiCall) return res.status(404).json({ error: 'This link is invalid or has been revoked.' });
  try {
    const evidence = await storage.signEvidenceList(db.data.evidence.filter(e => e.caseId === c.id));
    const custody = db.data.custody.filter(x => x.caseId === c.id);
    const vendor = db.data.users.find(u => u.id === c.vendorId);
    const R = buildAiReport(c, { evidence, custody, firm: vendor ? vendor.vendorName || '' : '', publicView: true });
    const buf = await require('../services/report-pdf').render(R, { logoDataUrl: vendor && vendor.logoDataUrl });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="Praman_Report_${String(R.case.claimNo || R.case.caseRef).replace(/[^A-Za-z0-9_-]/g, '')}.pdf"` }).send(buf);
  } catch (e) { console.error('PDF error:', e.message); res.status(500).json({ error: 'The PDF could not be made.' }); }
});

// AI-assisted verification report for an external viewer (same shared token).
router.get('/ai-report/:token', async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.shareToken && x.shareToken === req.params.token);
  if (!c || !c.aiCall) return res.status(404).json({ error: 'This link is invalid or has been revoked.' });
  const evidence = await storage.signEvidenceList(db.data.evidence.filter(e => e.caseId === c.id));
  const custody = db.data.custody.filter(x => x.caseId === c.id);
  const vendor = db.data.users.find(u => u.id === c.vendorId);
  res.json(buildAiReport(c, { evidence, custody, firm: vendor ? vendor.vendorName || '' : '', publicView: true }));
});

module.exports = router;
