// What a vendor firm sees about its own bill: plan, this month so far, invoices. Company admin only.
const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const billing = require('../services/billing');
const plans = require('../services/plans');

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => (req.user.role === 'vendor_admin' ? next() : res.status(403).json({ error: 'Only the company admin account can see billing.' })));

router.get('/', async (req, res) => {
  await db.read();
  const firm = plans.firmOf(db.data, req.user);
  if (!firm) return res.status(404).json({ error: 'Firm not found' });
  const cfg = billing.configOf(firm), s = billing.settingsOf(db.data);
  const period = billing.periodOf();
  const est = cfg.model ? billing.calculate(db.data, firm, period) : null;
  const invoices = billing.invoicesOf(db.data).filter(i => i.vendorId === firm.id && i.status !== 'draft').sort((a, b) => (b.issuedAt || '').localeCompare(a.issuedAt || ''))
    .map(i => { const v = billing.view(i); return { id: i.id, number: i.number, period: i.period, status: v.displayStatus, total: i.total, paid: v.paid, outstanding: v.outstanding, issuedAt: i.issuedAt, dueAt: i.dueAt }; });
  res.json({
    plan: cfg.model ? {
      model: cfg.model, modelLabel: billing.MODEL_LABEL[cfg.model],
      subscription: cfg.model === 'per_case' ? null : cfg.subscription,
      minimumMonthly: cfg.minimumMonthly, gstPercent: cfg.gstPercent, discountPercent: cfg.discountPercent, trialUntil: cfg.trialUntil,
      prices: (firm.services || plans.ALL).filter(k => plans.SERVICES[k]).map(k => ({ key: k, label: plans.SERVICES[k].label, price: firm.servicePrices && firm.servicePrices[k] != null ? firm.servicePrices[k] : null }))
    } : null,
    thisMonth: est ? { period, label: billing.monthLabel(period), cases: est.usage.total, trialCases: est.usage.trial, lines: est.lines, subtotal: est.subtotal, gst: est.gst.total, total: est.total, note: 'Estimate so far - the invoice is made after the month ends.' } : null,
    invoices,
    outstanding: Math.round(invoices.reduce((t, i) => t + i.outstanding, 0) * 100) / 100,
    blocked: billing.blockReason(db.data, firm),
    payTo: { bank: s.bank, upi: s.upi, email: s.email }
  });
});
router.get('/invoices/:id/pdf', async (req, res) => {
  await db.read();
  const i = billing.invoicesOf(db.data).find(x => x.id === req.params.id && x.vendorId === req.user.vendorRootId && x.status !== 'draft');
  if (!i) return res.status(404).json({ error: 'Invoice not found' });
  try {
    const buf = await require('../services/invoice-pdf').render(i);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${i.number.replace(/\//g, '-')}.pdf"` }).send(buf);
  } catch (e) { res.status(500).json({ error: 'The PDF could not be made.' }); }
});
module.exports = router;
