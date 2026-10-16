// Super Admin billing: choose each firm's model and prices, make / issue invoices, record payments.
// Mounted at /api/super-admin/billing (the parent router already requires Super Admin).
const express = require('express');
const { db } = require('../db');
const billing = require('../services/billing');
const plans = require('../services/plans');
const audit = require('../services/audit');
const ntf = require('../services/notifications');

const router = express.Router();
const firms = () => db.data.users.filter(u => u.role === 'vendor_admin');
const firmById = id => firms().find(u => u.id === id);
const invById = id => billing.invoicesOf(db.data).find(i => i.id === id);
const lite = i => { const v = billing.view(i); return { id: i.id, number: i.number || null, status: i.status, displayStatus: v.displayStatus, vendorId: i.vendorId, vendorName: i.vendorName, period: i.period, model: i.model, total: i.total, paid: v.paid, outstanding: v.outstanding, issuedAt: i.issuedAt || null, dueAt: i.dueAt || null, warnings: i.warnings || [] }; };

router.get('/settings', async (req, res) => { await db.read(); res.json(billing.settingsOf(db.data)); });
router.put('/settings', async (req, res) => {
  await db.read();
  db.data.billingSettings = billing.cleanSettings(req.body);
  audit.log(req.user, 'billing_settings_changed', '');
  await db.write();
  res.json(billing.settingsOf(db.data));
});

router.get('/summary', async (req, res) => { await db.read(); res.json(billing.summary(db.data)); });

// All firms with their plan and what this month looks like so far.
router.get('/firms', async (req, res) => {
  await db.read();
  const period = billing.periodOf();
  res.json(firms().map(f => {
    const cfg = billing.configOf(f);
    const est = cfg.model ? billing.calculate(db.data, f, period) : null;
    const open = billing.invoicesOf(db.data).filter(i => i.vendorId === f.id && ['issued', 'partial'].includes(i.status));
    return { id: f.id, vendorName: f.vendorName, approved: f.approved !== false, model: cfg.model, modelLabel: cfg.model ? billing.MODEL_LABEL[cfg.model] : 'Not set', servicePrices: f.servicePrices || {}, services: f.services || null,
      thisMonth: est ? { period, cases: est.usage.total, total: est.total, warnings: est.warnings } : null,
      outstanding: Math.round(open.reduce((s, i) => s + billing.dueOf(i), 0) * 100) / 100 };
  }));
});

router.get('/firms/:id', async (req, res) => {
  await db.read();
  const f = firmById(req.params.id); if (!f) return res.status(404).json({ error: 'Firm not found' });
  res.json({ id: f.id, vendorName: f.vendorName, config: billing.configOf(f), servicePrices: f.servicePrices || {}, services: f.services || plans.ALL, serviceCatalog: plans.ALL.map(k => ({ key: k, short: plans.SERVICES[k].short, label: plans.SERVICES[k].label })) });
});
router.put('/firms/:id', async (req, res) => {
  await db.read();
  const f = firmById(req.params.id); if (!f) return res.status(404).json({ error: 'Firm not found' });
  const r = billing.validateConfig(req.body);
  if (r.error) return res.status(400).json({ error: r.error });
  f.billing = r.config;
  audit.log(req.user, 'billing_plan_changed', `${f.vendorName}: ${r.config.model || 'none'}`, f.id);
  await db.write();
  res.json({ ok: true, config: billing.configOf(f) });
});

// "What would this firm pay under these prices?" - nothing is saved. Used to decide prices.
router.post('/simulate', async (req, res) => {
  await db.read();
  const f = firmById(req.body.vendorId); if (!f) return res.status(404).json({ error: 'Firm not found' });
  const period = req.body.period && billing.validPeriod(req.body.period) ? req.body.period : billing.prevPeriod();
  const r = billing.validateConfig(req.body.config || {});
  if (r.error) return res.status(400).json({ error: r.error });
  const prices = { ...(f.servicePrices || {}) };
  for (const [k, v] of Object.entries(req.body.prices || {})) if (plans.SERVICES[k] && v !== '' && v != null && isFinite(Number(v))) prices[k] = Number(v);
  const calc = billing.calculate(db.data, { ...f, servicePrices: prices }, period, { cfg: billing.configOf({ billing: r.config }) });
  res.json(calc);
});

router.get('/invoices', async (req, res) => {
  await db.read();
  let list = billing.invoicesOf(db.data);
  const { status, vendorId, period } = req.query;
  if (vendorId) list = list.filter(i => i.vendorId === vendorId);
  if (period) list = list.filter(i => i.period === period);
  if (status) list = list.filter(i => status === 'overdue' ? billing.effectiveStatus(i) === 'overdue' : i.status === status);
  res.json(list.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).map(lite));
});
router.get('/invoices.csv', async (req, res) => {
  await db.read();
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="praman-invoices.csv"' }).send(billing.invoicesCsv(db.data, billing.invoicesOf(db.data).filter(i => i.status !== 'draft')));
});
router.get('/invoices/:id', async (req, res) => {
  await db.read();
  const i = invById(req.params.id); if (!i) return res.status(404).json({ error: 'Invoice not found' });
  res.json(billing.view(i));
});

// Make drafts for a month (default: last month) for all firms, or one firm.
router.post('/generate', async (req, res) => {
  await db.read();
  const period = req.body.period || billing.prevPeriod();
  if (!billing.validPeriod(period)) return res.status(400).json({ error: 'Month must look like 2026-10.' });
  const list = req.body.vendorId ? [firmById(req.body.vendorId)].filter(Boolean) : firms().filter(f => f.approved !== false);
  if (!list.length) return res.status(404).json({ error: 'Firm not found' });
  const out = { created: 0, refreshed: 0, skipped: [] };
  for (const f of list) {
    const r = billing.generate(db.data, f, period, { by: req.user.email });
    if (r.invoice && r.created) out.created++; else if (r.invoice && !r.skipped) out.refreshed++; else out.skipped.push({ firm: f.vendorName, reason: r.skipped });
  }
  audit.log(req.user, 'invoices_generated', `${period}: ${out.created} new`);
  await db.write();
  res.json(out);
});

// Draft only: extra lines (credit / charge) and a note. Positive = charge, negative = credit.
router.put('/invoices/:id', async (req, res) => {
  await db.read();
  const i = invById(req.params.id); if (!i) return res.status(404).json({ error: 'Invoice not found' });
  if (i.status !== 'draft') return res.status(409).json({ error: 'Only a draft can be edited.' });
  const adj = [];
  for (const a of req.body.adjustments || []) {
    const amount = Math.round(Number(a.amount) * 100) / 100;
    if (!a.desc || !Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1e7) return res.status(400).json({ error: 'Each adjustment needs a description and an amount (negative for a credit).' });
    adj.push({ desc: String(a.desc).trim().slice(0, 120), amount });
  }
  i.adjustments = adj.slice(0, 20);
  if (req.body.notes !== undefined) i.notes = String(req.body.notes).slice(0, 400);
  billing.generate(db.data, firmById(i.vendorId), i.period, { by: req.user.email });
  await db.write();
  res.json(billing.view(i));
});
router.post('/invoices/:id/recalculate', async (req, res) => {
  await db.read();
  const i = invById(req.params.id); if (!i) return res.status(404).json({ error: 'Invoice not found' });
  if (i.status !== 'draft') return res.status(409).json({ error: 'Only a draft can be recalculated.' });
  billing.generate(db.data, firmById(i.vendorId), i.period, { by: req.user.email });
  await db.write();
  res.json(billing.view(i));
});

async function attachAndMail(i, firm) {
  if (!ntf.transport()) return false;
  const to = (i.buyer && i.buyer.email) || require('../services/followup').settingsOf(firm).notifyEmail || firm.email;
  if (!to) return false;
  const buf = await require('../services/invoice-pdf').render(i);
  return ntf.sendMail(to, `Invoice ${i.number} from ${(i.seller && i.seller.legalName) || 'Praman'}`, `Please find invoice ${i.number} for ${billing.monthLabel(i.period)} attached.\nAmount due: Rs. ${i.total}\nDue date: ${new Date(i.dueAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}`, [{ filename: `${i.number.replace(/\//g, '-')}.pdf`, content: buf }]);
}
router.post('/invoices/:id/issue', async (req, res) => {
  await db.read();
  const i = invById(req.params.id); if (!i) return res.status(404).json({ error: 'Invoice not found' });
  const s = billing.settingsOf(db.data);
  if (!s.legalName) return res.status(400).json({ error: 'Fill in your company details (billing settings) before issuing invoices.' });
  try { billing.issue(db.data, i, { by: req.user.email }); } catch (e) { return res.status(409).json({ error: e.message }); }
  const firm = firmById(i.vendorId);
  ntf.notify(i.vendorId, { type: 'invoice', text: `Invoice ${i.number} for ${billing.monthLabel(i.period)} is ready - Rs. ${i.total}` });
  audit.log(req.user, 'invoice_issued', `${i.number} ${i.vendorName} Rs.${i.total}`, i.vendorId);
  await db.write();
  attachAndMail(i, firm).catch(() => {});
  res.json(billing.view(i));
});
router.post('/invoices/:id/void', async (req, res) => {
  await db.read();
  const i = invById(req.params.id); if (!i) return res.status(404).json({ error: 'Invoice not found' });
  try {
    if (i.status === 'draft') { db.data.invoices = db.data.invoices.filter(x => x.id !== i.id); audit.log(req.user, 'invoice_draft_deleted', `${i.vendorName} ${i.period}`, i.vendorId); await db.write(); return res.json({ ok: true, deleted: true }); }
    billing.voidInvoice(db.data, i, req.body.reason, req.user.email);
  } catch (e) { return res.status(409).json({ error: e.message }); }
  audit.log(req.user, 'invoice_void', `${i.number}: ${i.voidReason}`, i.vendorId);
  await db.write();
  res.json(billing.view(i));
});
router.post('/invoices/:id/payments', async (req, res) => {
  await db.read();
  const i = invById(req.params.id); if (!i) return res.status(404).json({ error: 'Invoice not found' });
  try { billing.addPayment(i, req.body, req.user.email); } catch (e) { return res.status(400).json({ error: e.message }); }
  audit.log(req.user, 'payment_recorded', `${i.number} Rs.${req.body.amount}`, i.vendorId);
  if (i.status === 'paid') ntf.notify(i.vendorId, { type: 'invoice', text: `Payment received for invoice ${i.number}. Thank you.` });
  await db.write();
  res.json(billing.view(i));
});
router.delete('/invoices/:id/payments/:pid', async (req, res) => {
  await db.read();
  const i = invById(req.params.id); if (!i) return res.status(404).json({ error: 'Invoice not found' });
  try { billing.removePayment(i, req.params.pid); } catch (e) { return res.status(404).json({ error: e.message }); }
  audit.log(req.user, 'payment_removed', i.number, i.vendorId);
  await db.write();
  res.json(billing.view(i));
});
router.get('/invoices/:id/pdf', async (req, res) => {
  await db.read();
  const i = invById(req.params.id); if (!i) return res.status(404).json({ error: 'Invoice not found' });
  try {
    const buf = await require('../services/invoice-pdf').render(i);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${(i.number || 'draft-' + i.period).replace(/\//g, '-')}.pdf"` }).send(buf);
  } catch (e) { console.error('Invoice PDF error:', e.message); res.status(500).json({ error: 'The PDF could not be made.' }); }
});

// Cases that should not be charged (duplicate, test, goodwill). Only before they are on an invoice.
router.post('/cases/:id/waive', async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.id === req.params.id || x.caseRef === req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const waive = req.body.waived !== false;
  if (c.billing && c.billing.invoiceId) return res.status(409).json({ error: 'This case is already on an invoice. Add a credit adjustment on the next invoice instead.' });
  (c.billing ||= {}).waived = waive;
  c.billing.reason = waive ? String(req.body.reason || '').slice(0, 120) : undefined;
  audit.log(req.user, waive ? 'case_waived' : 'case_unwaived', c.caseRef, c.vendorId);
  await db.write();
  res.json({ ok: true, waived: waive });
});


// ---------- wallets ----------
const wallet = require('../services/wallet');
router.get('/wallets', async (req, res) => {
  await db.read();
  res.json({
    firms: firms().filter(f => wallet.isOn(f)).map(f => ({ id: f.id, vendorName: f.vendorName, ...wallet.overview(db.data, f.id), pending: wallet.pendingCount(db.data, f.id), month: wallet.usageSummary(db.data, f.id, billing.periodOf()) })),
    requests: (db.data.walletTxns || []).filter(t => t.type === 'topup_request' && t.status === 'pending').map(t => ({ ...t, vendorName: (firmById(t.vendorId) || {}).vendorName })),
    mismatch: wallet.reconcile(db.data),
    totalHeld: Math.round(Object.values(db.data.wallets || {}).reduce((s, w) => s + Math.max(0, w.balance), 0) * 100) / 100
  });
});
router.get('/wallets/:id', async (req, res) => {
  await db.read();
  if (!firmById(req.params.id)) return res.status(404).json({ error: 'Firm not found' });
  res.json({ ...wallet.overview(db.data, req.params.id), ledger: wallet.ledger(db.data, req.params.id, { limit: 150 }) });
});
const walletDo = (fn, audited) => async (req, res) => {
  await db.read();
  const f = firmById(req.params.id); if (!f) return res.status(404).json({ error: 'Firm not found' });
  try { fn(f, req); } catch (e) { return res.status(400).json({ error: e.message }); }
  wallet.sweep(db.data);   // waiting cases get paid as soon as money arrives
  audit.log(req.user, audited, `${f.vendorName} Rs.${req.body.amount}`, f.id);
  await db.write();
  res.json({ ok: true, ...wallet.overview(db.data, f.id) });
};
router.post('/wallets/:id/topup', walletDo((f, req) => wallet.topup(db.data, f.id, { ...req.body, by: req.user.email }), 'wallet_topup'));
router.post('/wallets/:id/adjust', walletDo((f, req) => wallet.adjust(db.data, f.id, { ...req.body, by: req.user.email }), 'wallet_adjust'));
router.post('/wallet-charges/:txn/refund', async (req, res) => {
  await db.read();
  const r = wallet.refund(db.data, req.params.txn, 'Refund');
  if (!r) return res.status(409).json({ error: 'This charge cannot be refunded (already refunded, or not a charge).' });
  audit.log(req.user, 'wallet_refund', req.params.txn, r.vendorId);
  await db.write(); res.json({ ok: true });
});
router.post('/wallet-requests/:id/:decision', async (req, res) => {
  await db.read();
  if (!['approve', 'reject'].includes(req.params.decision)) return res.status(404).json({ error: 'Unknown action' });
  try { wallet.decideRequest(db.data, req.params.id, req.params.decision === 'approve', { by: req.user.email, note: req.body.note }); } catch (e) { return res.status(409).json({ error: e.message }); }
  wallet.sweep(db.data);
  audit.log(req.user, 'wallet_request_' + req.params.decision, req.params.id);
  await db.write(); res.json({ ok: true });
});

module.exports = router;
