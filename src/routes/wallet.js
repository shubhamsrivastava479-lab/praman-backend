// A firm's own wallet: balance, what each thing costs, ledger, and "I have paid" top-up requests. Company admin only.
const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const wallet = require('../services/wallet');
const billing = require('../services/billing');
const plans = require('../services/plans');
const audit = require('../services/audit');

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => (req.user.role === 'vendor_admin' ? next() : res.status(403).json({ error: 'Only the company admin account can see the wallet.' })));

router.get('/', async (req, res) => {
  await db.read();
  const firm = plans.firmOf(db.data, req.user);
  const o = wallet.overview(db.data, firm.id);
  if (!o.enabled) return res.json({ enabled: false });
  const gst = o.gstPercent, s = billing.settingsOf(db.data);
  const kyc = wallet.kycRatesOf(db.data, firm);
  const period = billing.periodOf();
  res.json({
    ...o,
    rates: {
      reports: o.model === 'wallet' ? (firm.services || plans.ALL).filter(k => plans.SERVICES[k]).map(k => ({ key: k, label: plans.SERVICES[k].label, price: wallet.reportPrice(firm, k), gst: wallet.reportPrice(firm, k) != null ? wallet.withGst(wallet.reportPrice(firm, k), gst).gst : null })) : [],
      checks: Object.entries(wallet.KYC).map(([k, label]) => ({ key: k, label, price: kyc[k], gst: wallet.withGst(kyc[k], gst).gst })).filter(x => x.price > 0)
    },
    thisMonth: { period, label: billing.monthLabel(period), ...wallet.usageSummary(db.data, firm.id, period) },
    pending: wallet.pendingCount(db.data, firm.id),
    ledger: wallet.ledger(db.data, firm.id, { limit: Math.min(Number(req.query.limit) || 60, 300), before: req.query.before || null }),
    payTo: { bank: s.bank, upi: s.upi }
  });
});
router.post('/topup-request', async (req, res) => {
  await db.read();
  const firm = plans.firmOf(db.data, req.user);
  if (!wallet.isOn(firm)) return res.status(400).json({ error: 'The wallet is not switched on for your account.' });
  try { wallet.requestTopup(db.data, firm.id, { ...req.body, by: req.user.email }); } catch (e) { return res.status(400).json({ error: e.message }); }
  audit.log(req.user, 'wallet_topup_requested', `Rs.${req.body.amount} ref ${req.body.reference}`);
  await db.write();
  res.json({ ok: true });
});
router.get('/ledger.csv', async (req, res) => {
  await db.read();
  const firm = plans.firmOf(db.data, req.user);
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="wallet-ledger.csv"' }).send(wallet.csv(db.data, firm.id));
});
module.exports = router;
