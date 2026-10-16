// Public API for a vendor's / insurer's own system.   Authorization: X-API-Key: pk_live_...
//
//   POST /api/v1/cases              open a case (and send the customer's WhatsApp link)
//   GET  /api/v1/cases              list cases   ?status=open|completed  &since=ISO  &limit=50
//   GET  /api/v1/cases/:id          one case: status, AI call result, review   (:id = caseId, case no. or claim/policy no.)
//   GET  /api/v1/cases/:id/report   permanent link to the read-only verification report
//   GET  /api/v1/services           services this account may use
const express = require('express');
const { db, uid } = require('../db');
const { rateLimit } = require('../services/security');
const webhooks = require('../services/webhooks');
const plans = require('../services/plans');
const followup = require('../services/followup');
const { normRef } = require('../services/ids');

const router = express.Router();
router.use(rateLimit({ windowMs: 60_000, max: 120 }));
router.use(express.json({ limit: '1mb' }));

router.use(async (req, res, next) => {
  const h = req.get('X-API-Key') || ((req.get('Authorization') || '').startsWith('Bearer pk_') ? req.get('Authorization').slice(7) : '');
  if (!h || !/^pk_live_[a-f0-9]{48}$/.test(h)) return res.status(401).json({ error: 'Missing or invalid API key. Send it in the X-API-Key header.' });
  const hash = webhooks.sha256(h);
  const firm = (db.data.users || []).find(u => u.integration && u.integration.apiKeyHash === hash);
  if (!firm || firm.approved === false) return res.status(401).json({ error: 'Missing or invalid API key.' });
  req.firm = firm;
  req.user = { id: firm.id, email: firm.email, role: 'vendor_admin', vendorRootId: firm.id, vendorName: firm.vendorName };
  if (!firm.integration.lastUsedAt || Date.now() - new Date(firm.integration.lastUsedAt) > 3600e3) { firm.integration.lastUsedAt = new Date().toISOString(); db.write().catch(() => {}); }
  next();
});

const find = (firm, q) => {
  const k = normRef(q);
  const mine = db.data.cases.filter(c => c.vendorId === firm.id);
  return mine.find(x => x.id === q) || mine.find(x => normRef(x.caseRef) === k) || mine.find(x => normRef(x.claimNo) === k) || null;
};
const baseOf = req => {
  const p = process.env.PUBLIC_BASE_URL;
  return p && !/your-deployed/i.test(p) ? p.replace(/\/$/, '') : `${req.protocol}://${req.get('host')}`;
};
const out = (c, req) => {
  const { customerLink } = require('./cases');
  return webhooks.caseSummary(c, { customerLink: customerLink(c, baseOf(req)), externalRef: c.externalRef || null });
};

router.get('/services', (req, res) => {
  res.json(plans.publicList(plans.allowedServices(db.data, req.user), req.firm.servicePrices).map(s => ({ key: s.key, label: s.label, numberLabel: s.numberLabel })));
});

router.post('/cases', async (req, res) => {
  const cases = require('./cases');
  const b = req.body || {};
  const claimNo = String(b.claimNo || b.policyNo || '').trim();
  const phone = String(b.whatsappNumber || b.mobile || '').replace(/\D/g, '');
  if (!claimNo) return res.status(400).json({ error: 'claimNo (or policyNo) is required.' });
  if (phone.length < 10 || phone.length > 15) return res.status(400).json({ error: 'whatsappNumber must be the customer\'s number with country code, for example 919876543210.' });
  const svc = plans.serviceFor({ service: b.service, caseType: b.caseType, policyType: b.policyType });
  const allowed = plans.allowedServices(db.data, req.user);
  if (!allowed.includes(svc)) return res.status(403).json({ error: `Your Praman plan does not include ${plans.SERVICES[svc].label}.` });
  { const blocked = require('../services/billing').blockReason(db.data, req.firm, new Date(), svc); if (blocked) return res.status(402).json({ error: blocked }); }
  const externalRef = b.externalRef ? String(b.externalRef).slice(0, 80) : null;

  const dup = cases.findDuplicate(req.firm.id, claimNo);
  if (dup) {
    if (externalRef && dup.externalRef === externalRef) return res.status(200).json({ duplicate: true, ...out(dup, req) }); // same request sent again
    return res.status(409).json({ error: `A case with this number already exists (${dup.caseRef}).`, caseId: dup.id, caseRef: dup.caseRef });
  }

  const accounts = db.data.whatsappAccounts.filter(a => a.vendorId === req.firm.id);
  const accountId = b.whatsappAccountId && accounts.find(a => a.id === b.whatsappAccountId) ? b.whatsappAccountId : (accounts.length === 1 ? accounts[0].id : null);
  const c = cases.buildCase({
    vendorId: req.firm.id, claimNo, insuredName: String(b.insuredName || '').slice(0, 120), vehicleNo: b.vehicleNo, district: b.district,
    whatsappNumber: phone, policyNo: b.policyNo, accountId, caseType: b.caseType, policyValue: b.policyValue,
    verificationMode: b.verificationMode || 'full_automation', policyType: b.policyType, service: svc
  });
  if (externalRef) c.externalRef = externalRef;
  db.data.cases.push(c);
  require('../services/wallet').onCaseCreated(db.data, c);
  db.data.custody.push({ id: uid('cust'), caseId: c.id, event: `Case opened through the API — case no. ${c.caseRef}, ${plans.SERVICES[c.service].label}`, actor: 'api', timestamp: new Date().toISOString() });

  let whatsapp = 'not_sent';
  const account = db.data.whatsappAccounts.find(a => a.id === accountId);
  if (b.sendLink !== false && account) {
    try {
      const wa = require('../services/whatsapp');
      await wa.sendTemplateMessage(c.whatsappNumber, String(b.templateName || followup.settingsOf(req.firm).reminderTemplate), account, 'en',
        [{ type: 'body', parameters: [{ type: 'text', text: cases.customerLink(c, baseOf(req)) }] }]);
      whatsapp = 'sent'; c.lastContactAt = new Date().toISOString();
      db.data.custody.push({ id: uid('cust'), caseId: c.id, event: 'WhatsApp link sent to the customer (API)', actor: 'api', timestamp: new Date().toISOString() });
    } catch (e) { whatsapp = 'failed: ' + String(e.message || e).slice(0, 120); }
  } else if (b.sendLink !== false) whatsapp = 'no_whatsapp_number_connected';
  webhooks.emit('case.created', c);
  await db.write();
  res.status(201).json({ whatsapp, ...out(c, req) });
});

router.get('/cases', async (req, res) => {
  let list = db.data.cases.filter(c => c.vendorId === req.firm.id);
  const st = String(req.query.status || '');
  if (st === 'open') list = list.filter(c => c.status !== 'completed');
  else if (st === 'completed') list = list.filter(c => c.status === 'completed');
  if (req.query.since) { const t = new Date(req.query.since); if (!isNaN(t)) list = list.filter(c => new Date(c.createdAt) >= t); }
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  list = list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit);
  res.json({ count: list.length, cases: list.map(c => out(c, req)) });
});

router.get('/cases/:id', async (req, res) => {
  const c = find(req.firm, req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found.' });
  res.json(out(c, req));
});

router.get('/cases/:id/report', async (req, res) => {
  const c = find(req.firm, req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found.' });
  if (!c.aiCall || !['completed', 'handoff'].includes(c.aiCall.status)) return res.status(409).json({ error: 'The verification report is not ready yet.' });
  if (!c.shareToken) {
    c.shareToken = uid('share') + uid('tok');
    db.data.custody.push({ id: uid('cust'), caseId: c.id, event: 'Report link created (API)', actor: 'api', timestamp: new Date().toISOString() });
    await db.write();
  }
  res.json({ caseId: c.id, caseRef: c.caseRef, reportUrl: `${baseOf(req)}/ai-report.html?token=${c.shareToken}` });
});

module.exports = router;
