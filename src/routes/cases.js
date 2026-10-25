const express = require('express');
const { buildAiReport } = require('../services/ai-report');
const checklist = require('../services/checklist');
const { documentRows, recordingRows, chatRows } = require('../services/report-files');
const crypto = require('crypto');
const multer = require('multer');
const XLSX = require('xlsx');
const { db, uid } = require('../db');
const gemini = require('../services/gemini');
const wa = require('../services/whatsapp');
const storage = require('../services/storage');
const { requireAuth } = require('../middleware/auth');
const { nextCaseRef, normRef, caseFileKey } = require('../services/ids');
const plans = require('../services/plans');
const followup = require('../services/followup');
const webhooks = require('../services/webhooks');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB, for Excel bulk upload
const os = require('os');
const fs = require('fs');
const uploadVideo = multer({ storage: multer.diskStorage({ destination: os.tmpdir() }), limits: { fileSize: 1024 * 1024 * 1024 } }); // call recordings: temp file, streamed to storage

const router = express.Router();
router.use(requireAuth);
// deletes the temp upload file once the response is done (success or error)
const cleanTmp = (req, res, next) => { res.on('close', () => { if (req.file && req.file.path) fs.promises.unlink(req.file.path).catch(() => {}); }); next(); };


// Shared logic for building a new case object, used by both the single-case
// form and the bulk Excel upload.
// Link sent to the customer on WhatsApp. Full-automation cases get the AI call
// page (identified by an unguessable token); others get the classic entry page.
function baseUrlFor(req) {
  const p = process.env.PUBLIC_BASE_URL;
  if (p && !/your-deployed/i.test(p)) return p.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}
function customerLink(c, baseUrl) {
  if (c.verificationMode === 'full_automation' && c.aiCall && c.aiCall.token) {
    return `${baseUrl}/ai-call.html?t=${c.aiCall.token}`;
  }
  return `${baseUrl}/verify.html?room=room_${c.id}&case=${c.id}&k=${c.selfToken || ''}&name=Insured`;
}
const normMode = m => /^(full|auto|ai)/i.test(String(m || '').replace(/[^a-z]/gi, '')) ? 'full_automation' : 'executive';

const normPolicyType = t => /term/i.test(String(t || '')) ? 'term' : /health|medi/i.test(String(t || '')) ? 'health' : 'life';

function buildCase({ vendorId, claimNo, insuredName, vehicleNo, district, whatsappNumber, policyNo, accountId, caseType, policyValue, verificationMode, policyType, service, details }) {
  const svc = plans.serviceFor({ service, caseType, policyType });
  caseType = plans.SERVICES[svc].caseType;
  policyType = plans.SERVICES[svc].policyType || policyType;
  const HIGH_VALUE_THRESHOLD = 1000000; // ₹10,00,000 — above this, self-verification is disabled
  const parsedValue = policyValue ? Number(policyValue) : null;
  const firm = (db.data.users || []).find(u => u.id === vendorId);
  const createdAt = new Date();
  const dueAt = new Date(createdAt.getTime() + followup.settingsOf(firm).tatHours * 3600e3).toISOString();
  const newCase = {
    id: uid('case'),
    caseRef: nextCaseRef(db.data),
    selfToken: crypto.randomBytes(16).toString('hex'),
    vendorId,
    service: svc,
    whatsappAccountId: accountId || null,
    caseType,
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
    verificationMode: normMode(verificationMode),
    ...(details && Object.keys(details).length ? { details } : {}),
    dueAt,
    createdAt: createdAt.toISOString()
  };
  if (newCase.verificationMode === 'full_automation') {
    newCase.aiCall = { token: crypto.randomBytes(14).toString('hex'), status: 'not_started' };
  }
  if (newCase.caseType === 'policy_verification') {
    newCase.pivcChecklist = {
      identity: { status: 'pending', notes: '' },
      healthDisclosure: { status: 'pending', notes: '' },
      incomeOccupation: { status: 'pending', notes: '' },
      nominee: { status: 'pending', notes: '' },
      policyDetails: { status: 'pending', notes: '' }
    };
    newCase.pivcResult = 'pending_verification';
    newCase.policyType = normPolicyType(policyType);
  }
  return newCase;
}

router.get('/', async (req, res) => {
  await db.read();
  const roles = require('../services/roles');
  // The list only needs the headline of each case; the full record (answers, steps, checks, files)
  // is loaded when one case is opened. This keeps the list fast with thousands of cases.
  const slimAi = a => a && ({ status: a.status, decision: a.decision, language: a.language, startedAt: a.startedAt, completedAt: a.completedAt, summary: a.summary && String(a.summary).slice(0, 240), flags: (a.flags || []).slice(0, 6), flagCount: (a.flags || []).length, liveCallReasons: a.liveCallReasons, token: a.token });
  res.json(db.data.cases.filter(c => c.vendorId === req.user.vendorRootId && (req.user.role !== 'insurer' || roles.insurerCan(c)))
    .map(c => ({ ...c, aiCall: slimAi(c.aiCall), liveCall: c.liveCall ? { token: c.liveCall.token } : c.liveCall, pivcChecklist: undefined, service: plans.serviceOfCase(c) })));
});


// Refuses a service the firm has not bought. Returns an error message or null.
function serviceBlocked(req, svc) {
  if (req.user.role !== 'super_admin') { const b = require('../services/billing').blockReason(db.data, plans.firmOf(db.data, req.user), new Date(), svc); if (b) return b; }
  const allowed = plans.allowedServices(db.data, req.user);
  if (allowed.includes(svc)) return null;
  return `Your Praman plan does not include ${plans.SERVICES[svc].label}. Contact Praman to add it.`;
}

// One firm cannot have two cases with the same claim / policy number.
function findDuplicate(vendorId, claimNo) {
  const k = normRef(claimNo);
  return k ? db.data.cases.find(c => c.vendorId === vendorId && normRef(c.claimNo) === k) : null;
}

function resolveCase(vendorId, q) {
  const k = normRef(q);
  const mine = db.data.cases.filter(c => c.vendorId === vendorId);
  return mine.find(x => x.id === q) || mine.find(x => normRef(x.caseRef) === k) || mine.find(x => normRef(x.claimNo) === k) || null;
}

// WhatsApp items from numbers that have no case yet (kept, never dropped).
router.get('/unassigned/items', async (req, res) => {
  await db.read();
  const items = db.data.evidence.filter(e => e.unassigned && e.vendorId === req.user.vendorRootId);
  const signed = await storage.signEvidenceList(items.map(e => ({
    id: e.id, type: e.type, sender: e.sender, senderName: e.senderName, caption: e.caption, fileUrl: e.fileUrl,
    mimeType: e.mimeType, title: e.analysis && e.analysis.title, keyDetails: e.analysis && e.analysis.keyDetails, receivedAt: e.receivedAt
  })));
  res.json(signed.sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt))));
});

// Attach an item to a case, or move it from one case to another. The file is
// moved into the new case's folder and the chain of custody records both sides.
async function moveEvidence(req, res, ev, fromCase) {
  const to = resolveCase(req.user.vendorRootId, String((req.body || {}).to || '').trim());
  if (!to) return res.status(404).json({ error: 'Target case not found. Enter its case no. (PRM26-…) or claim/policy no.' });
  if (fromCase && to.id === fromCase.id) return res.status(400).json({ error: 'It is already in this case.' });
  let newUrl = ev.fileUrl;
  if (ev.fileUrl) {
    const ext = (String(ev.fileUrl).split('?')[0].match(/\.([a-z0-9]{2,5})$/i) || [, 'bin'])[1];
    try { newUrl = await storage.moveFile(ev.fileUrl, caseFileKey(to.id, ev.id, ext)); }
    catch (e) { console.warn('File move failed, keeping old location:', e.message); }
  }
  await db.read();
  const e = db.data.evidence.find(x => x.id === ev.id);
  if (!e) return res.status(404).json({ error: 'Item not found' });
  const who = req.user.email || 'agent';
  e.fileUrl = newUrl;
  e.caseId = to.id;
  e.vendorId = to.vendorId;
  e.unassigned = false;
  e.needsReview = null;
  e.movedFrom = fromCase ? fromCase.id : 'unassigned';
  e.movedAt = new Date().toISOString();
  e.movedBy = who;
  for (const t of db.data.transcripts) if (t.evidenceId === e.id) t.caseId = to.id;
  const label = `${e.analysis && e.analysis.title ? e.analysis.title : e.type} (${e.id})`;
  if (fromCase) db.data.custody.push({ id: uid('cust'), caseId: fromCase.id, event: `Item ${label} moved to case ${to.caseRef} by ${who}${req.body.reason ? ' — ' + String(req.body.reason).slice(0, 200) : ''}`, actor: who, timestamp: new Date().toISOString() });
  db.data.custody.push({ id: uid('cust'), caseId: to.id, event: `Item ${label} ${fromCase ? 'moved here from case ' + fromCase.caseRef : 'attached from unassigned WhatsApp items'} by ${who}`, actor: who, hash: e.sha256 || undefined, timestamp: new Date().toISOString() });
  await db.write();
  res.json({ ok: true, caseId: to.id, caseRef: to.caseRef });
}

router.post('/unassigned/:evId/assign', async (req, res) => {
  await db.read();
  const ev = db.data.evidence.find(e => e.id === req.params.evId && e.unassigned && e.vendorId === req.user.vendorRootId);
  if (!ev) return res.status(404).json({ error: 'Item not found' });
  return moveEvidence(req, res, ev, null);
});

router.post('/:id/evidence/:evId/move', async (req, res) => {
  await db.read();
  const from = db.data.cases.find(c => c.id === req.params.id && c.vendorId === req.user.vendorRootId);
  const ev = from && db.data.evidence.find(e => e.id === req.params.evId && e.caseId === from.id);
  if (!ev) return res.status(404).json({ error: 'Item not found in this case' });
  return moveEvidence(req, res, ev, from);
});

// Find a case by case number (PRM26-000123), claim/policy number or internal id.
router.get('/lookup/:q', async (req, res) => {
  await db.read();
  const k = normRef(req.params.q);
  const mine = db.data.cases.filter(c => c.vendorId === req.user.vendorRootId);
  const c = mine.find(x => x.id === req.params.q) || mine.find(x => normRef(x.caseRef) === k) || mine.find(x => normRef(x.claimNo) === k);
  if (!c) return res.status(404).json({ error: 'No case with this case number or claim number.' });
  res.json({ id: c.id, caseRef: c.caseRef, claimNo: c.claimNo, insuredName: c.insuredName });
});

// Extra customer / policy / claim columns an Excel row may carry. Each entry:
// [field kept on the case, column names that fill it (lower case, letters only)].
const DETAIL_COLUMNS = [
  ['mobile', ['mobile', 'mobileno', 'mobilenumber', 'phone', 'phoneno', 'alternatemobile', 'alternatenumber']],
  ['email', ['email', 'emailid', 'emailaddress', 'mail']],
  ['dob', ['dob', 'dateofbirth', 'birthdate']],
  ['gender', ['gender', 'sex']],
  ['address', ['address', 'fulladdress', 'residentialaddress']],
  ['city', ['city', 'town']],
  ['state', ['state']],
  ['pincode', ['pincode', 'pin', 'pinno', 'zip', 'postalcode']],
  ['insurerName', ['insurer', 'insurername', 'insurancecompany', 'insurancecompanyname', 'insurancecompanyname', 'company', 'companyname']],
  ['verificationType', ['verificationtype', 'investigationtype']],
  ['productName', ['product', 'productname', 'planname', 'plan']],
  ['policyStartDate', ['policystartdate', 'riskstartdate', 'policyissuedate', 'policydate']],
  ['premium', ['premium', 'premiumamount']],
  ['nomineeName', ['nominee', 'nomineename']],
  ['claimType', ['claimtype']],
  ['claimAmount', ['claimamount', 'claimedamount', 'amountclaimed']],
  ['incidentDate', ['incidentdate', 'dateofloss', 'lossdate', 'accidentdate', 'dateofincident']],
  ['incidentPlace', ['incidentplace', 'placeofloss', 'accidentplace', 'lossplace']],
  ['hospitalName', ['hospital', 'hospitalname']],
  ['admissionDate', ['admissiondate', 'dateofadmission', 'doa']],
  ['dischargeDate', ['dischargedate', 'dateofdischarge', 'dod']],
  ['diagnosis', ['diagnosis', 'ailment', 'disease', 'illness']],
  ['vehicleMake', ['vehiclemake', 'make', 'makemodel', 'vehiclemodel', 'model', 'vehicledetails']],
  ['branch', ['branch', 'branchname']],
  ['agentName', ['agent', 'agentname', 'advisor', 'advisorname', 'salesperson']],
  ['clientName', ['client', 'clientname', 'hiringcompany', 'newemployer']],
  ['position', ['position', 'designation', 'role', 'jobtitle', 'jobrole']],
  ['employeeId', ['employeeid', 'empid', 'employeeno', 'candidateid']],
  ['remarks', ['remarks', 'notes', 'comments', 'instructions']]
];
const cellText = v => v instanceof Date && !isNaN(v) ? v.toISOString().slice(0, 10) : String(v == null ? '' : v).trim().slice(0, 300);
function detailsFromRow(row) {
  const out = {};
  for (const [field, cols] of DETAIL_COLUMNS) {
    const col = cols.find(k => cellText(row[k]));
    if (col) out[field] = cellText(row[col]);
  }
  return out;
}

// Bulk-create cases from an uploaded Excel/CSV file, then automatically send
// each field contact a WhatsApp message containing their call-join link.
//
// Expected columns (case-insensitive, order doesn't matter):
//   claimNo, insuredName, whatsappNumber, vehicleNo, district, policyNo, caseType
// caseType should be "claim_investigation" or "policy_verification" (defaults
// to claim_investigation if blank/unrecognized).
router.post('/bulk-upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name must be "file")' });

  const { whatsappAccountId, templateName, publicBaseUrl, verificationMode: defaultMode, policyType: defaultPolicyType, service: defaultService } = req.body;
  await db.read();
  const allowed = plans.allowedServices(db.data, req.user);
  if (!allowed.length) return res.status(403).json({ error: 'Your Praman plan has no services yet. Contact Praman.' });
  if (defaultService && !allowed.includes(defaultService)) return res.status(403).json({ error: serviceBlocked(req, defaultService) || 'Service not allowed' });

  const vendorAccounts = db.data.whatsappAccounts.filter(a => a.vendorId === req.user.vendorRootId);
  let accountId = whatsappAccountId;
  if (!accountId && vendorAccounts.length === 1) accountId = vendorAccounts[0].id;
  const account = db.data.whatsappAccounts.find(a => a.id === accountId);

  let rows;
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  } catch (err) {
    return res.status(400).json({ error: 'Could not read the file — make sure it is a valid .xlsx or .csv' });
  }

  // Normalize column names so "WhatsApp Number", "whatsapp_number", etc. all match.
  const norm = key => key.toLowerCase().replace(/[^a-z]/g, '');
  const results = [];
  const baseUrl = (publicBaseUrl && !/your-deployed/i.test(publicBaseUrl)) ? publicBaseUrl.replace(/\/$/, "") : baseUrlFor(req);

  for (const rawRow of rows) {
    const row = {};
    for (const [k, v] of Object.entries(rawRow)) row[norm(k)] = v;

    const claimNo = row.claimno || row.claimnumber || row.policyno || row.policynumber || row.claimpolicyno;
    const whatsappNumber = row.whatsappnumber || row.whatsappno || row.whatsapp || row.mobile || row.mobileno || row.mobilenumber || row.phone;
    const details = detailsFromRow(row);
    if (details.mobile && String(details.mobile).replace(/\D/g, '') === String(whatsappNumber).replace(/\D/g, '')) delete details.mobile;

    if (!claimNo || !whatsappNumber) {
      results.push({ row: rawRow, status: 'skipped', reason: 'Missing claimNo/policyNo or whatsappNumber' });
      continue;
    }
    const dup = findDuplicate(req.user.vendorRootId, claimNo);
    if (dup) {
      results.push({ row: rawRow, status: 'skipped', reason: `A case with claim/policy no. ${claimNo} already exists (${dup.caseRef})`, caseId: dup.id, caseRef: dup.caseRef });
      continue;
    }
    // Service of this row: a "service" / "caseType" column, else the workspace's service.
    const rowType = row.service || row.casetype || row.verificationtype || row.investigationtype || '';
    const svc = rowType
      ? plans.serviceFor({ service: String(rowType).trim().toLowerCase(), caseType: rowType, policyType: row.policytype || row.plantype || row.producttype || defaultPolicyType })
      : (defaultService && plans.SERVICES[defaultService] ? defaultService : allowed[0]);
    if (!allowed.includes(svc)) {
      results.push({ row: rawRow, status: 'skipped', reason: `${plans.SERVICES[svc].label} is not in your plan` });
      continue;
    }
    const payBlock = require('../services/billing').blockReason(db.data, plans.firmOf(db.data, req.user), new Date(), svc);
    if (payBlock) { results.push({ row: rawRow, status: 'skipped', reason: payBlock }); continue; }

    const newCase = buildCase({
      vendorId: req.user.vendorRootId,
      claimNo: String(claimNo),
      insuredName: row.insuredname || row.name || row.customername || row.proposername || '',
      vehicleNo: row.vehicleno || row.vehiclenumber || row.registrationno || '',
      district: row.district || '',
      policyNo: row.policyno || row.policynumber || '',
      whatsappNumber: String(whatsappNumber),
      accountId,
      service: svc,
      policyValue: String(row.policyvalue || row.suminsured || row.sumassured || '').replace(/[^0-9.]/g, '') || null,
      details,
      verificationMode: row.verificationmode || row.mode || defaultMode
    });
    db.data.cases.push(newCase);
    require('../services/wallet').onCaseCreated(db.data, newCase);
    db.data.custody.push({
      id: uid('cust'), caseId: newCase.id, event: 'Case opened via bulk Excel upload',
      actor: 'agent', timestamp: new Date().toISOString()
    });
    webhooks.emit('case.created', newCase);

    let waStatus = 'not_sent';
    if (account) {
      try {
        const joinUrl = customerLink(newCase, baseUrl);
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
        newCase.lastContactAt = new Date().toISOString();
      } catch (err) {
        waStatus = `failed: ${err.message}`;
      }
    }

    results.push({ row: rawRow, status: 'created', caseId: newCase.id, caseRef: newCase.caseRef, whatsapp: waStatus });
    if (results.length % 20 === 0) await db.write(); // save as we go on big files
  }

  await db.write();
  const created = results.filter(r => r.status === 'created').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  res.json({ created, skipped, results });
});

router.post('/', async (req, res) => {
  const { claimNo, insuredName, vehicleNo, district, whatsappNumber, policyNo, whatsappAccountId, caseType, policyValue, verificationMode, policyType, service } = req.body;
  if (!claimNo || !whatsappNumber) {
    return res.status(400).json({ error: 'claimNo and whatsappNumber are required' });
  }
  await db.read();
  const svc = plans.serviceFor({ service, caseType, policyType });
  const blocked = serviceBlocked(req, svc);
  if (blocked) return res.status(403).json({ error: blocked });
  const dup = findDuplicate(req.user.vendorRootId, claimNo);
  if (dup && !req.body.allowDuplicate) {
    return res.status(409).json({ error: `A case with claim/policy no. ${claimNo} already exists: ${dup.caseRef}${dup.insuredName ? ' (' + dup.insuredName + ')' : ''}. Open that case instead.`, caseId: dup.id, caseRef: dup.caseRef });
  }

  // If the vendor has more than one connected WhatsApp number, they must
  // specify which one this case's field contact will message. If they only
  // have one connected, default to it.
  const vendorAccounts = db.data.whatsappAccounts.filter(a => a.vendorId === req.user.vendorRootId);
  let accountId = whatsappAccountId;
  if (!accountId && vendorAccounts.length === 1) accountId = vendorAccounts[0].id;

  const newCase = buildCase({
    vendorId: req.user.vendorRootId, claimNo, insuredName, vehicleNo, district, whatsappNumber, policyNo, accountId, caseType, policyValue, verificationMode, policyType, service: svc
  });

  db.data.cases.push(newCase);
  require("../services/wallet").onCaseCreated(db.data, newCase);
  db.data.custody.push({
    id: uid('cust'),
    caseId: newCase.id,
    event: `Case opened — case no. ${newCase.caseRef}, ${plans.SERVICES[newCase.service].label}, claim/policy no. ${newCase.claimNo}`,
    actor: req.body.actor || 'agent',
    timestamp: new Date().toISOString()
  });
  webhooks.emit('case.created', newCase);
  await db.write();
  res.status(201).json(newCase);
});

router.get('/:id', async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.id === req.params.id && x.vendorId === req.user.vendorRootId);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const evidence = await storage.signEvidenceList(db.data.evidence.filter(e => e.caseId === c.id));
  const custody = db.data.custody.filter(x => x.caseId === c.id);
  const transcripts = db.data.transcripts.filter(t => t.caseId === c.id);
  const report = db.data.reports.filter(r => r.caseId === c.id).slice(-1)[0] || null;
  const baseUrl = baseUrlFor(req);
  res.json({ ...c, evidence, custody, transcripts, report, customerLink: customerLink(c, baseUrl), aiChecklist: checklist.buildChecklist(c) });
});

// Files for the formatted report (report.html): every received document with
// its text, every call recording, each with a permanent /f/ link.
router.get('/:id/report-files', async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.id === req.params.id && x.vendorId === req.user.vendorRootId);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  if (!c.shareToken) {
    c.shareToken = uid('share') + uid('tok');
    db.data.custody.push({ id: uid('cust'), caseId: c.id, event: 'Report link created (needed for file links inside the report)', actor: 'system', timestamp: new Date().toISOString() });
    await db.write();
  }
  const raw = db.data.evidence.filter(e => e.caseId === c.id);
  res.json({ documents: documentRows(c, raw), recordings: recordingRows(c, raw), chats: chatRows(c, raw) });
});

// Data for the AI-assisted verification report page (ai-report.html).
router.get('/:id/ai-report', async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.id === req.params.id && x.vendorId === req.user.vendorRootId);
  if (!c || (req.user.role === 'insurer' && !require('../services/roles').insurerCan(c))) return res.status(404).json({ error: 'Case not found' });
  // The report carries permanent file links (/f/<shareToken>/<id>), so make
  // sure this case has a share token before building it.
  if (!c.shareToken) {
    c.shareToken = uid('share') + uid('tok');
    db.data.custody.push({ id: uid('cust'), caseId: c.id, event: 'Report link created (needed for file links inside the report)', actor: 'system', timestamp: new Date().toISOString() });
    await db.write();
  }
  const evidence = await storage.signEvidenceList(db.data.evidence.filter(e => e.caseId === c.id));
  const custody = db.data.custody.filter(x => x.caseId === c.id);
  const vendor = db.data.users.find(u => u.id === c.vendorId);
  res.json(buildAiReport(c, { evidence, custody, firm: vendor ? vendor.vendorName || '' : '' }));
});

// Reviewer sign-off on the AI report (the AI result is only a recommendation).
// A person did a checklist item themselves (for example asked the question on a live call).
router.post('/:id/checklist/:itemId', async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.id === req.params.id && x.vendorId === req.user.vendorRootId);
  if (!c || !c.aiCall) return res.status(404).json({ error: 'Case not found' });
  const item = checklist.buildChecklist(c).find(i => i.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Checklist item not found' });
  const ov = (c.checklistOverrides ||= {});
  const by = req.user.name || req.user.email || 'a team member';
  if (req.body && req.body.undo) { delete ov[item.id]; }
  else {
    const note = String((req.body || {}).note || '').trim().slice(0, 300);
    if (!note) return res.status(400).json({ error: 'Please write a short note: what you asked or checked, and the answer.' });
    ov[item.id] = { by, at: new Date().toISOString(), note };
  }
  db.data.custody.push({ id: uid('cust'), caseId: c.id, event: req.body && req.body.undo ? `Checklist item "${item.label}" set back to the AI's result by ${by}` : `Checklist item "${item.label}" marked as done by ${by}: ${ov[item.id].note}`, actor: 'agent', timestamp: new Date().toISOString() });
  await db.write();
  res.json({ ok: true, aiChecklist: checklist.buildChecklist(c) });
});

// Builds the report data for a case (same as the on-screen report).
async function reportData(c, publicView) {
  const evidence = await storage.signEvidenceList(db.data.evidence.filter(e => e.caseId === c.id));
  const custody = db.data.custody.filter(x => x.caseId === c.id);
  const vendor = db.data.users.find(u => u.id === c.vendorId);
  return { R: buildAiReport(c, { evidence, custody, firm: vendor ? vendor.vendorName || '' : '', publicView }), vendor };
}
const pdfName = R => 'Praman_Report_' + String(R.case.claimNo || R.case.caseRef).replace(/[^A-Za-z0-9_-]/g, '') + '.pdf';

// PDF made on the server (cover page, logo, page numbers).
router.get('/:id/ai-report.pdf', async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.id === req.params.id && x.vendorId === req.user.vendorRootId);
  if (!c || !c.aiCall || (req.user.role === 'insurer' && !require('../services/roles').insurerCan(c))) return res.status(404).json({ error: 'Case not found' });
  try {
    const { R, vendor } = await reportData(c, false);
    const buf = await require('../services/report-pdf').render(R, { logoDataUrl: vendor && vendor.logoDataUrl });
    require('../services/audit').log(req.user, 'report_pdf_downloaded', c.caseRef);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${pdfName(R)}"` }).send(buf);
  } catch (e) { console.error('PDF error:', e.message); res.status(500).json({ error: 'The PDF could not be made. Please try again.' }); }
});

// Send the PDF to the insurer (or any address) by e-mail. Needs the mail server (SMTP_URL) to be set up.
router.post('/:id/email-report', async (req, res) => {
  if (req.user.role === 'viewer' || req.user.role === 'insurer') return res.status(403).json({ error: 'Not allowed.' });
  await db.read();
  const c = db.data.cases.find(x => x.id === req.params.id && x.vendorId === req.user.vendorRootId);
  if (!c || !c.aiCall) return res.status(404).json({ error: 'Case not found' });
  const ntf = require('../services/notifications');
  if (!ntf.transport()) return res.status(503).json({ error: 'E-mail is not set up on this server yet (SMTP_URL). Download the PDF and send it yourself.' });
  const firmRow = (db.data.users || []).find(u => u.id === c.vendorId);
  const to = String((req.body && req.body.to) || require('../services/followup').settingsOf(firmRow).insurerEmail || '').trim();
  if (!to) return res.status(400).json({ error: 'Enter an e-mail address, or save the insurer e-mail in Settings.' });
  try {
    const { R, vendor } = await reportData(c, false);
    const buf = await require('../services/report-pdf').render(R, { logoDataUrl: vendor && vendor.logoDataUrl });
    const ok = await ntf.sendMail(to, `Verification report ${R.meta.reportNo}`, `Please find the verification report for ${R.case.caseRef} (${R.case.claimNo}) attached.\n\nSent from Praman on behalf of ${R.meta.firm}.`, [{ filename: pdfName(R), content: buf }]);
    if (!ok) return res.status(502).json({ error: 'The e-mail could not be sent. Check the address and the mail server settings.' });
    require('../services/audit').log(req.user, 'report_emailed', `${c.caseRef} to ${to}`);
    db.data.custody.push({ id: uid('cust'), caseId: c.id, event: `Report PDF e-mailed to ${to}`, actor: req.user.email || 'agent', timestamp: new Date().toISOString() });
    await db.write();
    res.json({ ok: true });
  } catch (e) { console.error('Email report error:', e.message); res.status(500).json({ error: 'The e-mail could not be sent.' }); }
});

router.post('/:id/ai-review', async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.id === req.params.id && x.vendorId === req.user.vendorRootId);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
  const VERDICTS = ['verified', 'partially_verified', 'found_discrepancy', 'unverified', 'pending_verification'];
  const b = req.body || {};
  if (c.aiReview) (c.aiReviewHistory ||= []).push(c.aiReview); // earlier sign-offs are kept, never overwritten
  c.aiReview = {
    finalVerdict: VERDICTS.includes(b.finalVerdict) ? b.finalVerdict : 'pending_verification',
    remarks: clip(b.remarks, 4000),
    reviewerName: clip(b.reviewerName, 120),
    reviewerDesignation: clip(b.reviewerDesignation, 120),
    reviewedAt: new Date().toISOString(),
    reviewedByLogin: clip(req.user.email, 120) // who was logged in (the name above is typed by hand)
  };
  if (c.caseType === 'policy_verification' && c.aiReview.finalVerdict !== 'pending_verification') c.pivcResult = c.aiReview.finalVerdict;
  if (c.aiReview.finalVerdict !== 'pending_verification') {   // a person has decided
    const firm = (db.data.users || []).find(u => u.id === c.vendorId);
    const fs_ = require('../services/followup').settingsOf(firm);
    const value = require('../services/call-signals').parseAmount(c.policyValue) || 0;
    const needsTwo = fs_.secondReviewAbove > 0 && value > fs_.secondReviewAbove;
    const prev = (c.aiReviewHistory || []).filter(h => h.finalVerdict !== 'pending_verification').pop();
    const firstBy = c.reviewState === 'awaiting_second_review' && prev ? prev.reviewedByLogin : null;
    if (needsTwo && c.reviewState !== 'awaiting_second_review') {
      c.reviewState = 'awaiting_second_review';   // a different person must confirm
      require('../services/notifications').notify(c.vendorId, { type: 'second_review', caseId: c.id, text: `Case ${c.caseRef} needs a second reviewer (value above the firm's limit)` });
    } else if (needsTwo && firstBy && firstBy === c.aiReview.reviewedByLogin) {
      c.aiReview = c.aiReviewHistory.pop();   // same person cannot confirm their own sign-off — undo this save
      return res.status(409).json({ error: 'This case needs a second reviewer. Please ask a different person to sign off.' });
    } else {
      c.reviewState = 'reviewed';
      if (c.status !== 'completed') { c.status = 'completed'; c.completedAt = new Date().toISOString(); }
    }
  }
  db.data.custody.push({ id: uid('cust'), caseId: c.id, event: `Report reviewed by ${c.aiReview.reviewerName || 'reviewer'} — final verdict: ${c.aiReview.finalVerdict}`, actor: 'agent', timestamp: new Date().toISOString() });
  webhooks.emit('case.reviewed', c);
  require('../services/audit').log(req.user, 'review_signed', `${c.caseRef} → ${c.aiReview.finalVerdict}`);
  await db.write();
  res.json({ ok: true, review: c.aiReview, reviewState: c.reviewState });
});

router.patch('/:id', async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.id === req.params.id && x.vendorId === req.user.vendorRootId);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  // Never let a client overwrite identity / security fields.
  const BLOCKED = ['id', 'service', 'caseType', 'policyType', 'caseRef', 'selfToken', 'liveCall', 'vendorId', 'aiCall', 'aiReview', 'createdAt', 'shareToken', 'verificationMode', 'whatsappNumber', 'whatsappAccountId'];
  const patch = { ...req.body };
  for (const k of BLOCKED) delete patch[k];
  if (patch.claimNo !== undefined) {
    const d = findDuplicate(c.vendorId, patch.claimNo);
    if (!String(patch.claimNo).trim()) return res.status(400).json({ error: 'Claim/policy no. cannot be empty.' });
    if (d && d.id !== c.id) return res.status(409).json({ error: `Claim/policy no. ${patch.claimNo} is already used by case ${d.caseRef}.` });
  }
  Object.assign(c, patch);
  db.data.custody.push({
    id: uid('cust'),
    caseId: c.id,
    event: `Case updated: ${Object.keys(patch).join(', ')}`,
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
      caseInfo: { claimNo: c.claimNo, insuredName: c.insuredName, vehicleNo: c.vehicleNo,
        aiVerification: c.aiCall && c.aiCall.status === 'completed' ? { decision: c.aiCall.decision, summary: c.aiCall.summary, checks: c.aiCall.checks, flags: c.aiCall.flags } : undefined },
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
router.post('/:id/recording', cleanTmp, uploadVideo.single('recording'), async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.id === req.params.id && x.vendorId === req.user.vendorRootId);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  if (!req.file) return res.status(400).json({ error: 'No recording file received' });

  try {
    const mime = /mp4/.test(req.file.mimetype || '') ? 'video/mp4' : 'video/webm';
    const evidenceId = uid('ev');
    const fileUrl = await storage.saveFileFromPath(req.file.path, caseFileKey(c.id, evidenceId, mime === 'video/mp4' ? 'mp4' : 'webm'), mime);
    fs.promises.unlink(req.file.path).catch(() => {});

    db.data.evidence.push({
      id: evidenceId,
      caseId: c.id,
      vendorId: c.vendorId,
      size: req.file.size,
      source: 'live_call',
      type: 'call_recording',
      caption: `${req.body.kind === 'live_video' ? 'Live video call recording (executive + customer)' : 'Call recording'} — ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
      fileUrl,
      mimeType: mime,
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
module.exports.customerLink = customerLink;
module.exports.baseUrlFor = baseUrlFor;
module.exports.buildCase = buildCase;
module.exports.findDuplicate = findDuplicate;
