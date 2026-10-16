// Team workflow for a firm: who handles which case, deadlines, reminders.
const express = require('express');
const { db, uid } = require('../db');
const { requireAuth } = require('../middleware/auth');
const followup = require('../services/followup');
const plans = require('../services/plans');

const router = express.Router();
router.use(requireAuth);

const firmOf = req => plans.firmOf(db.data, req.user);
const notAgent = (req, res, next) => require('../services/roles').isTeam(req.user.role) ? res.status(403).json({ error: 'Only the company admin account can change this.' }) : next();
const who = req => req.user.email || 'agent';
const log = (c, event, req) => db.data.custody.push({ id: uid('cust'), caseId: c.id, event, actor: who(req), timestamp: new Date().toISOString() });
const myCase = (req, id) => db.data.cases.find(c => c.id === id && c.vendorId === req.user.vendorRootId);

// Follow-up settings of the firm.
router.get('/settings', async (req, res) => {
  await db.read();
  const firm = firmOf(req);
  res.json({ settings: followup.settingsOf(firm), defaults: followup.DEFAULTS, retentionDays: firm ? firm.retentionDays || null : null });
});
const audit = require('../services/audit');
// Customer data-deletion requests (DPDP). The firm erases the data or declines with a reason.
router.get('/data-requests', notAgent, async (req, res) => {
  await db.read();
  res.json((db.data.dataRequests || []).filter(r => r.vendorId === req.user.vendorRootId).slice(-100).reverse());
});
router.post('/data-requests/:id', notAgent, async (req, res) => {
  await db.read();
  const r = (db.data.dataRequests || []).find(x => x.id === req.params.id && x.vendorId === req.user.vendorRootId);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  if (r.status !== 'open') return res.status(409).json({ error: 'This request is already closed.' });
  const c = db.data.cases.find(x => x.id === r.caseId);
  const act = req.body && req.body.action;
  if (act === 'decline') {
    const note = String(req.body.note || '').trim().slice(0, 500);
    if (!note) return res.status(400).json({ error: 'Please write the reason for declining.' });
    r.status = 'declined'; r.note = note;
  } else if (act === 'erase') {
    if (!c) return res.status(404).json({ error: 'Case not found' });
    try { r.result = await require('../services/privacy').eraseCase(c, req.user.email); } catch (e) { return res.status(409).json({ error: e.message }); }
    r.status = 'erased';
  } else return res.status(400).json({ error: 'Choose erase or decline.' });
  r.closedAt = new Date().toISOString(); r.closedBy = req.user.email;
  audit.log(req.user, 'data_request_' + r.status, r.caseRef);
  await db.write();
  res.json({ ok: true, request: r });
});
router.get('/audit', notAgent, async (req, res) => {
  await db.read();
  res.json(audit.listFor(req.user.vendorRootId, { limit: Math.min(500, parseInt(req.query.limit, 10) || 100), before: req.query.before || null, action: String(req.query.action || '') }));
});
router.put('/settings', notAgent, async (req, res) => {
  await db.read();
  const firm = firmOf(req);
  if (!firm) return res.status(404).json({ error: 'Company not found' });
  firm.followUp = followup.normalize({ ...(firm.followUp || {}), ...req.body });
  audit.log(req.user, 'settings_changed', 'deadlines / review / alerts');
  await db.write();
  res.json({ ok: true, settings: followup.settingsOf(firm) });
});

// The firm's own checklist per service: which standard questions to skip, extra questions, mandatory items.
const cfgSvc = (req, res) => {
  const allowed = plans.allowedServices(db.data, req.user);
  const key = String(req.query.service || req.body.service || allowed[0] || '');
  if (!plans.SERVICES[key] || !allowed.includes(key)) { res.status(400).json({ error: 'This service is not in your plan.' }); return null; }
  return key;
};
router.get('/checklist-config', async (req, res) => {
  await db.read();
  const key = cfgSvc(req, res); if (!key) return;
  res.json({ ...require('../services/checklist-config').catalog(key, firmOf(req)), services: plans.allowedServices(db.data, req.user).map(k => ({ key: k, label: plans.SERVICES[k].label })) });
});
// Firm logo for the PDF cover (small PNG or JPEG, sent as a data URL).
router.get('/branding', async (req, res) => { await db.read(); const f = firmOf(req); res.json({ logoDataUrl: (f && f.logoDataUrl) || '' }); });
router.put('/branding', notAgent, async (req, res) => {
  await db.read();
  const f = firmOf(req);
  if (!f) return res.status(404).json({ error: 'Company not found' });
  const v = String((req.body && req.body.logoDataUrl) || '');
  if (v && !/^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=]+$/.test(v)) return res.status(400).json({ error: 'Use a PNG or JPEG image.' });
  if (v.length > 400000) return res.status(400).json({ error: 'The logo is too large (keep it under 250 KB).' });
  f.logoDataUrl = v;
  audit.log(req.user, 'logo_changed', v ? 'new logo' : 'logo removed');
  await db.write();
  res.json({ ok: true });
});
router.put('/checklist-config', notAgent, async (req, res) => {
  await db.read();
  const key = cfgSvc(req, res); if (!key) return;
  const firm = firmOf(req);
  if (!firm) return res.status(404).json({ error: 'Company not found' });
  const cc = require('../services/checklist-config');
  const next = cc.normalize(req.body);
  // only ids that exist in this service (or the firm's own questions) can be marked mandatory
  const valid = new Set(cc.catalog(key, { checklistConfig: {} }).items.map(i => i.id).concat(next.extra.map(e => 'q_' + e.key)));
  next.mandatory = next.mandatory.filter(id => valid.has(id));
  (firm.checklistConfig ||= {})[key] = next;
  audit.log(req.user, 'checklist_config_changed', String(req.body && req.body.service || ''));
  await db.write();
  res.json({ ok: true, ...cc.catalog(key, firm) });
});

// People a case can be given to: the admin and the agents of this firm.
router.get('/team', async (req, res) => {
  await db.read();
  const root = req.user.vendorRootId;
  const firm = db.data.users.find(u => u.id === root);
  const team = [{ id: root, name: (firm && (firm.profile?.contactName || firm.vendorName)) || 'Admin', email: firm && firm.email, role: 'admin' }]
    .concat(db.data.users.filter(u => u.role === 'agent' && u.parentVendorId === root).map(a => ({ id: a.id, name: a.agentName || a.email, email: a.email, role: 'agent' })));
  res.json(team);
});

// Numbers for the dashboard strip: late, due soon, waiting for the customer, per person.
router.get('/summary', async (req, res) => {
  await db.read();
  const firm = firmOf(req);
  const s = followup.settingsOf(firm);
  const mine = db.data.cases.filter(c => c.vendorId === req.user.vendorRootId);
  const out = { open: 0, overdue: 0, dueSoon: 0, waitingCustomer: 0, escalated: 0, unassigned: 0, handoff: 0, review: 0, byPerson: {} };
  const now = new Date();
  for (const c of mine) {
    if (!followup.isOpen(c)) continue;
    out.open++;
    const t = followup.timeState(c, s, now);
    if (t === 'overdue') out.overdue++;
    if (t === 'due_soon') out.dueSoon++;
    if (followup.waitingForCustomer(c)) out.waitingCustomer++;
    if (c.escalatedAt) out.escalated++;
    if (c.aiCall && c.aiCall.status === 'handoff') out.handoff++;
    if (['awaiting_review', 'awaiting_second_review'].includes(c.reviewState)) out.review++;
    if (!c.assignedAgentId) out.unassigned++;
    else { const p = (out.byPerson[c.assignedAgentId] ||= { open: 0, overdue: 0 }); p.open++; if (t === 'overdue') p.overdue++; }
  }
  res.json(out);
});

// Cases as the dashboard needs them: time state + reminder state.
router.get('/cases', async (req, res) => {
  await db.read();
  const firm = firmOf(req);
  const s = followup.settingsOf(firm);
  const now = new Date();
  const rows = db.data.cases.filter(c => c.vendorId === req.user.vendorRootId).map(c => ({
    id: c.id, dueAt: followup.dueOf(c, s), time: followup.timeState(c, s, now), assignedTo: c.assignedAgentId || null,
    reminders: (c.followUp && c.followUp.count) || 0, remindersStopped: !!(c.followUp && c.followUp.stopped),
    nextReminderAt: (c.followUp && c.followUp.nextAt) || null, skipReason: (c.followUp && c.followUp.skipReason) || null,
    escalatedAt: c.escalatedAt || null, legalHold: !!c.legalHold
  }));
  res.json(rows);
});

router.post('/cases/:id/assign', async (req, res) => {
  await db.read();
  const c = myCase(req, req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const to = req.body.agentId || null;
  let name = 'nobody';
  if (to) {
    const u = db.data.users.find(x => x.id === to && (x.id === req.user.vendorRootId || x.parentVendorId === req.user.vendorRootId));
    if (!u) return res.status(400).json({ error: 'This person is not in your team.' });
    name = u.agentName || u.email;
  }
  c.assignedAgentId = to;          // same fields the "Claim this case" button and the Performance page use
  c.assignedAgentName = to ? name : undefined;
  log(c, `Case assigned to ${name} by ${who(req)}`, req);
  await db.write();
  res.json({ ok: true, assignedTo: to });
});

router.post('/cases/:id/due', async (req, res) => {
  await db.read();
  const c = myCase(req, req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const t = new Date(req.body.dueAt);
  if (isNaN(t) || t.getFullYear() < 2020 || t.getFullYear() > 2100) return res.status(400).json({ error: 'Choose a valid date and time.' });
  c.dueAt = t.toISOString();
  if (c.escalatedAt && t > new Date()) c.escalatedAt = null; // new deadline: escalation can happen again
  log(c, `Deadline set to ${t.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} by ${who(req)}`, req);
  await db.write();
  res.json({ ok: true, dueAt: c.dueAt });
});

router.post('/cases/:id/reminders', async (req, res) => {
  await db.read();
  const c = myCase(req, req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const f = (c.followUp ||= { count: 0 });
  f.stopped = !!req.body.stop;
  if (!f.stopped) { f.failCount = 0; f.nextAt = undefined; }
  log(c, `Automatic reminders ${f.stopped ? 'stopped' : 'turned on again'} by ${who(req)}`, req);
  await db.write();
  res.json({ ok: true, stopped: f.stopped });
});

// Send the reminder now (does not use up the automatic reminders).
router.post('/cases/:id/remind', async (req, res) => {
  await db.read();
  const c = myCase(req, req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  if (!followup.isOpen(c)) return res.status(400).json({ error: 'This case is already completed.' });
  const account = db.data.whatsappAccounts.find(a => a.id === c.whatsappAccountId);
  if (!account) return res.status(400).json({ error: 'No WhatsApp number is linked to this case.' });
  const { customerLink, baseUrlFor } = require('./cases');
  const s = followup.settingsOf(firmOf(req));
  try {
    const wa = require('../services/whatsapp');
    await wa.sendTemplateMessage(c.whatsappNumber, s.reminderTemplate, account, 'en', [{ type: 'body', parameters: [{ type: 'text', text: customerLink(c, baseUrlFor(req)) }] }]);
  } catch (e) {
    return res.status(502).json({ error: 'WhatsApp could not send the message: ' + String(e.message || e).slice(0, 160) });
  }
  c.lastContactAt = new Date().toISOString();
  log(c, `WhatsApp reminder sent to the customer by ${who(req)}`, req);
  await db.write();
  res.json({ ok: true });
});

// Legal hold: files of this case are never deleted by the retention policy.
router.post('/cases/:id/legal-hold', notAgent, async (req, res) => {
  await db.read();
  const c = myCase(req, req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  c.legalHold = !!req.body.on;
  log(c, `Legal hold ${c.legalHold ? 'set (files will not be deleted)' : 'removed'} by ${who(req)}`, req);
  await db.write();
  res.json({ ok: true, legalHold: c.legalHold });
});

module.exports = router;
