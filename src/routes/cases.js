const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { db, uid } = require('../db');
const gemini = require('../services/gemini');
const wa = require('../services/whatsapp');
const storage = require('../services/storage');
const { requireAuth } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB, for Excel bulk upload
const uploadVideo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024 } }); // 300MB, for call recordings

const router = express.Router();
router.use(requireAuth);

// Shared logic for building a new case object, used by both the single-case
// form and the bulk Excel upload.
function buildCase({ vendorId, claimNo, insuredName, vehicleNo, district, whatsappNumber, policyNo, accountId, caseType, policyValue }) {
  const HIGH_VALUE_THRESHOLD = 1000000; // ₹10,00,000 — above this, self-verification is disabled
  const parsedValue = policyValue ? Number(policyValue) : null;
  const newCase = {
    id: uid('case'),
    vendorId,
    whatsappAccountId: accountId || null,
    caseType: caseType === 'policy_verification' ? 'policy_verification' : 'claim_investigation',
    claimNo,
    insuredName: insuredName || '',
    vehicleNo: vehicleNo || '',
    district: district || '',
    policyNo: policyNo || '',
    whatsappNumber: String(whatsappNumber).replace(/\D/g, ''),
    policyValue: parsedValue,
    requiresMandatoryCall: !!(parsedValue && parsedValue >= HIGH_VALUE_THRESHOLD),
    status: 'in_progress',
    verdict: null,
    createdAt: new Date().toISOString()
  };
  if (newCase.caseType === 'policy_verification') {
    newCase.pivcChecklist = {
      identity: { status: 'pending', notes: '' },
      healthDisclosure: { status: 'pending', notes: '' },
      incomeOccupation: { status: 'pending', notes: '' },
      nominee: { status: 'pending', notes: '' },
      policyDetails: { status: 'pending', notes: '' }
    };
    newCase.pivcResult = 'pending_verification';
  }
  return newCase;
}

router.get('/', async (req, res) => {
  await db.read();
  res.json(db.data.cases.filter(c => c.vendorId === req.user.vendorRootId));
});

// Bulk-create cases from an uploaded Excel/CSV file, then automatically send
// each field contact a WhatsApp message containing their call-join link.
//
// Expected columns (case-insensitive, order doesn't matter):
//   claimNo, insuredName, whatsappNumber, vehicleNo, district, policyNo, caseType
// caseType should be "claim_investigation" or "policy_verification" (defaults
// to claim_investigation if blank/unrecognized).
router.post('/bulk-upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name must be "file")' });

  const { whatsappAccountId, templateName, publicBaseUrl } = req.body;
  await db.read();

  const vendorAccounts = db.data.whatsappAccounts.filter(a => a.vendorId === req.user.vendorRootId);
  let accountId = whatsappAccountId;
  if (!accountId && vendorAccounts.length === 1) accountId = vendorAccounts[0].id;
  const account = db.data.whatsappAccounts.find(a => a.id === accountId);

  let rows;
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  } catch (err) {
    return res.status(400).json({ error: 'Could not read the file — make sure it is a valid .xlsx or .csv' });
  }

  // Normalize column names so "WhatsApp Number", "whatsapp_number", etc. all match.
  const norm = key => key.toLowerCase().replace(/[^a-z]/g, '');
  const results = [];
  const baseUrl = publicBaseUrl || `${req.protocol}://${req.get('host')}`;

  for (const rawRow of rows) {
    const row = {};
    for (const [k, v] of Object.entries(rawRow)) row[norm(k)] = v;

    const claimNo = row.claimno || row.policyno || row.claimpolicyno;
    const whatsappNumber = row.whatsappnumber || row.mobile || row.phone;

    if (!claimNo || !whatsappNumber) {
      results.push({ row: rawRow, status: 'skipped', reason: 'Missing claimNo/policyNo or whatsappNumber' });
      continue;
    }

    const newCase = buildCase({
      vendorId: req.user.vendorRootId,
      claimNo: String(claimNo),
      insuredName: row.insuredname || '',
      vehicleNo: row.vehicleno || '',
      district: row.district || '',
      policyNo: row.policyno || '',
      whatsappNumber: String(whatsappNumber),
      accountId,
      caseType: row.casetype,
      policyValue: row.policyvalue || null
    });
    db.data.cases.push(newCase);
    db.data.custody.push({
      id: uid('cust'), caseId: newCase.id, event: 'Case opened via bulk Excel upload',
      actor: 'agent', timestamp: new Date().toISOString()
    });

    let waStatus = 'not_sent';
    if (account) {
      try {
        const roomId = 'room_' + newCase.id;
        const joinUrl = `${baseUrl}/verify.html?room=${roomId}&case=${newCase.id}&name=Insured`;
        await wa.sendTemplateMessage(
          newCase.whatsappNumber,
          templateName || 'claim_investigation_intake',
          account,
          'en',
          [{ type: 'body', parameters: [{ type: 'text', text: joinUrl }] }]
        );
        db.data.custody.push({
          id: uid('cust'), caseId: newCase.id, event: 'WhatsApp call-join link sent (bulk upload)',
          actor: 'agent', timestamp: new Date().toISOString()
        });
        waStatus = 'sent';
      } catch (err) {
        waStatus = `failed: ${err.message}`;
      }
    }

    results.push({ row: rawRow, status: 'created', caseId: newCase.id, whatsapp: waStatus });
  }

  await db.write();
  const created = results.filter(r => r.status === 'created').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  res.json({ created, skipped, results });
});

router.post('/', async (req, res) => {
  const { claimNo, insuredName, vehicleNo, district, whatsappNumber, policyNo, whatsappAccountId, caseType, policyValue } = req.body;
  if (!claimNo || !whatsappNumber) {
    return res.status(400).json({ error: 'claimNo and whatsappNumber are required' });
  }
  await db.read();

  // If the vendor has more than one connected WhatsApp number, they must
  // specify which one this case's field contact will message. If they only
  // have one connected, default to it.
  const vendorAccounts = db.data.whatsappAccounts.filter(a => a.vendorId === req.user.vendorRootId);
  let accountId = whatsappAccountId;
  if (!accountId && vendorAccounts.length === 1) accountId = vendorAccounts[0].id;

  const newCase = buildCase({
    vendorId: req.user.vendorRootId, claimNo, insuredName, vehicleNo, district, whatsappNumber, policyNo, accountId, caseType, policyValue
  });

  db.data.cases.push(newCase);
  db.data.custody.push({
    id: uid('cust'),
    caseId: newCase.id,
    event: 'Case opened',
    actor: req.body.actor || 'agent',
    timestamp: new Date().toISOString()
  });
  await db.write();
  res.status(201).json(newCase);
});

router.get('/:id', async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.id === req.params.id && x.vendorId === req.user.vendorRootId);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const evidence = db.data.evidence.filter(e => e.caseId === c.id);
  const custody = db.data.custody.filter(x => x.caseId === c.id);
  const transcripts = db.data.transcripts.filter(t => t.caseId === c.id);
  const report = db.data.reports.filter(r => r.caseId === c.id).slice(-1)[0] || null;
  res.json({ ...c, evidence, custody, transcripts, report });
});

router.patch('/:id', async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.id === req.params.id && x.vendorId === req.user.vendorRootId);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  Object.assign(c, req.body);
  db.data.custody.push({
    id: uid('cust'),
    caseId: c.id,
    event: `Case updated: ${Object.keys(req.body).join(', ')}`,
    actor: req.body.actor || 'agent',
    timestamp: new Date().toISOString()
  });
  await db.write();
  res.json(c);
});

router.post('/:id/generate-report', async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.id === req.params.id && x.vendorId === req.user.vendorRootId);
  if (!c) return res.status(404).json({ error: 'Case not found' });

  const evidence = db.data.evidence.filter(e => e.caseId === c.id);
  const transcripts = db.data.transcripts.filter(t => t.caseId === c.id);

  const evidenceSummaries = evidence.map(e => ({
    type: e.type,
    summary: e.analysis?.visibleText
      ? `${e.analysis.documentType}: ${e.analysis.visibleText}. ${e.analysis.notableDetails || ''}`
      : e.caption || e.filename || 'evidence item'
  }));

  const transcriptText = transcripts.map(t => `${t.speaker}: ${t.english || t.original}`).join('\n');

  try {
    const html = await gemini.draftReport({
      caseInfo: { claimNo: c.claimNo, insuredName: c.insuredName, vehicleNo: c.vehicleNo },
      evidenceSummaries,
      transcriptText
    });
    const report = {
      id: uid('report'),
      caseId: c.id,
      html,
      generatedBy: 'ai_assistant',
      generatedAt: new Date().toISOString()
    };
    db.data.reports.push(report);
    db.data.custody.push({
      id: uid('cust'),
      caseId: c.id,
      event: 'AI report draft generated',
      actor: 'ai_assistant',
      timestamp: new Date().toISOString()
    });
    await db.write();
    res.json(report);
  } catch (err) {
    console.error('Report generation error:', err.message);
    res.status(500).json({ error: 'Could not generate the report right now. Please try again.' });
  }
});

// Save a recorded call (uploaded from the agent's browser once the call
// ends) into this case's evidence vault, same as any other evidence item —
// so it shows up in the report with a clickable link automatically.
router.post('/:id/recording', uploadVideo.single('recording'), async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.id === req.params.id && x.vendorId === req.user.vendorRootId);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  if (!req.file) return res.status(400).json({ error: 'No recording file received' });

  try {
    const filename = `${uid('rec')}.webm`;
    const fileUrl = await storage.saveFile(req.file.buffer, filename, 'video/webm');

    const evidenceId = uid('ev');
    db.data.evidence.push({
      id: evidenceId,
      caseId: c.id,
      source: 'live_call',
      type: 'call_recording',
      caption: `Call recording — ${new Date().toLocaleString()}`,
      fileUrl,
      mimeType: 'video/webm',
      receivedAt: new Date().toISOString()
    });
    db.data.custody.push({
      id: uid('cust'),
      caseId: c.id,
      event: 'Call recording saved to evidence vault',
      actor: req.user.role === 'agent' ? req.user.email : 'agent',
      timestamp: new Date().toISOString()
    });
    await db.write();
    res.json({ ok: true, fileUrl });
  } catch (err) {
    console.error('Recording upload error:', err.message);
    res.status(500).json({ error: 'Could not save the recording. Please try again.' });
  }
});

// Generates (or returns the existing) shareable link for this case's report
// — a long random token, not a login. Anyone with the link can view the
// report and evidence/recording links read-only; nothing else in the
// system is reachable from it. Regenerate to invalidate an old link.
router.post('/:id/share-link', async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.id === req.params.id && x.vendorId === req.user.vendorRootId);
  if (!c) return res.status(404).json({ error: 'Case not found' });

  if (!c.shareToken || req.body.regenerate) {
    c.shareToken = uid('share') + uid('tok'); // extra length — unguessable
    db.data.custody.push({
      id: uid('cust'), caseId: c.id,
      event: req.body.regenerate ? 'Shareable report link regenerated (old link invalidated)' : 'Shareable report link created',
      actor: req.user.email, timestamp: new Date().toISOString()
    });
    await db.write();
  }
  res.json({ token: c.shareToken });
});

module.exports = router;
