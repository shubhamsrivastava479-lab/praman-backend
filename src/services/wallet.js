// Prepaid wallet: a firm adds money, and each report and each paid ID check (Gridlines) is deducted.
//
//   - Reports are deducted only for firms whose billing model is "wallet" (price = the firm's price per case).
//   - ID checks (DL, Aadhaar OTP, PAN) are deducted for any firm that has the wallet switched on,
//     at the rates set by Super Admin (platform default, optionally changed per firm).
//   - Every rupee movement is a line in db.data.walletTxns (the ledger). Balance = sum of the ledger.
//   - GST (the firm's GST %) is added on top of each charge and shown separately.
//   - A top-up is either added by Super Admin, or requested by the firm ("I paid, UTR ...") and approved.
//   - Nothing about prices is fixed here; all rates are settings.
const { uid } = require('../db');
const plans = require('./plans');
const billing = require('./billing');

const KYC = require('./gridlines-apis').KIND_LABELS; // every paid ID / vehicle / credit check has a price in the wallet
const r2 = x => Math.round(Number(x || 0) * 100) / 100;
const num = (v, d = null) => (v === '' || v == null || !Number.isFinite(Number(v))) ? d : Number(v);

const walletOf = (data, vendorId) => ((data.wallets ||= {})[vendorId] ||= { balance: 0 });
const txns = data => (data.walletTxns ||= []);
const firmById = (data, id) => data.users.find(u => u.id === id && u.role === 'vendor_admin');
const isOn = firm => !!(firm && billing.configOf(firm).wallet.enabled);

// ----- rates -----
function kycRatesOf(data, firm) {
  const base = (data.billingSettings && data.billingSettings.kycRates) || {};
  const mine = (firm && firm.billing && firm.billing.wallet && firm.billing.wallet.kycRates) || {};
  const out = {};
  for (const k of Object.keys(KYC)) { const v = num(mine[k], null); out[k] = v != null ? v : num(base[k], 0); }
  return out;
}
const gstOf = firm => billing.configOf(firm).gstPercent || 0;
const withGst = (price, pct) => { const g = r2(price * pct / 100); return { price: r2(price), gst: g, total: r2(price + g) }; };
const reportPrice = (firm, svc) => num(firm.servicePrices && firm.servicePrices[svc], null);

// ----- money movement -----
function post(data, vendorId, t) {
  const w = walletOf(data, vendorId);
  w.balance = r2(w.balance + (t.amount || 0));
  const row = { id: uid('wtx'), vendorId, at: new Date().toISOString(), status: 'posted', ...t, balanceAfter: w.balance };
  txns(data).push(row);
  return row;
}
function canAfford(data, firm, total) {
  const w = walletOf(data, firm.id), limit = billing.configOf(firm).wallet.creditLimit || 0;
  return w.balance - total >= -limit - 1e-9;
}
function lowCheck(data, firm, notify) {
  const cfg = billing.configOf(firm).wallet, w = walletOf(data, firm.id);
  if (cfg.lowAlert != null && w.balance <= cfg.lowAlert) {
    if (!w.lowNotified) { w.lowNotified = true; (notify || defaultNotify)(firm.id, { type: 'wallet', text: `Wallet balance is low: Rs. ${w.balance}. Please add money to keep verifications running.` }); }
  }
}
const defaultNotify = (v, n) => require('./notifications').notify(v, n);

function lowError(firm, total, balance) {
  const e = new Error(`Your wallet balance (Rs. ${balance}) is too low for this action (Rs. ${total}). Please add money and try again.`);
  e.code = 'WALLET_LOW'; return e;
}

// Deduct for one ID check. Throws WALLET_LOW if the firm cannot pay. Returns the ledger row (or null when free / wallet off).
function chargeKyc(data, vendorId, kind, { caseId = null, notify } = {}) {
  const firm = firmById(data, vendorId);
  if (!isOn(firm)) return null;
  const price = kycRatesOf(data, firm)[kind];
  if (!price) return null;
  const c = withGst(price, gstOf(firm));
  if (!canAfford(data, firm, c.total)) throw lowError(firm, c.total, walletOf(data, vendorId).balance);
  const row = post(data, vendorId, { type: 'charge', kind: 'kyc', sub: kind, caseId, desc: KYC[kind], price: c.price, gst: c.gst, amount: -c.total });
  lowCheck(data, firm, notify);
  return row;
}
function refund(data, txnId, note = 'Refund') {
  const t = txns(data).find(x => x.id === txnId);
  if (!t || t.type !== 'charge' || t.refundedBy) return null;
  const row = post(data, t.vendorId, { type: 'refund', kind: t.kind, sub: t.sub, caseId: t.caseId, refOf: t.id, desc: `${note}: ${t.desc}`, price: t.price, gst: t.gst, amount: -t.amount });
  t.refundedBy = row.id;
  const w = walletOf(data, t.vendorId); if (w.lowNotified && w.balance > 0) w.lowNotified = false;
  return row;
}

// Charge for the report (case) of a wallet-model firm. Idempotent through c.billing.walletTxnId.
function chargeCase(data, c, { notify } = {}) {
  const firm = firmById(data, c.vendorId);
  const cfg = firm && billing.configOf(firm);
  if (!firm || cfg.model !== 'wallet') return { skipped: 'not a wallet firm' };
  if (c.billing && (c.billing.walletTxnId || c.billing.waived || c.billing.invoiceId)) return { skipped: 'already handled' };
  const at = billing.billableAtOf(c, cfg.billableEvent); if (!at) return { skipped: 'not due yet' };
  const t = Date.parse(at);
  if (cfg.startDate && t < Date.parse(cfg.startDate + 'T00:00:00+05:30')) return { skipped: 'before start' };
  const svc = plans.serviceOfCase(c);
  if (cfg.trialUntil && t < Date.parse(cfg.trialUntil + 'T23:59:59+05:30')) { (c.billing ||= {}).walletTxnId = 'free'; return { free: true }; }
  const price = reportPrice(firm, svc);
  if (!price) return { skipped: `no price set for ${plans.SERVICES[svc].short}` };
  const p = withGst(price, cfg.gstPercent);
  if (!canAfford(data, firm, p.total)) return { skipped: 'low balance' };
  const row = post(data, firm.id, { type: 'charge', kind: 'report', sub: svc, caseId: c.id, desc: `${plans.SERVICES[svc].label} - ${c.caseRef}`, price: p.price, gst: p.gst, amount: -p.total });
  (c.billing ||= {}).walletTxnId = row.id;
  lowCheck(data, firm, notify);
  return { charged: row };
}
// Called right after a case is opened: pays for it at once when the firm charges on "created".
function onCaseCreated(data, c) { try { return chargeCase(data, c); } catch (e) { return { skipped: e.message }; } }
// Balance must equal the sum of the ledger. Returns the firms where it does not.
function reconcile(data) {
  const sums = {};
  for (const t of txns(data)) if (['topup', 'charge', 'refund', 'adjust'].includes(t.type)) sums[t.vendorId] = r2((sums[t.vendorId] || 0) + t.amount);
  return Object.keys({ ...sums, ...(data.wallets || {}) }).filter(id => Math.abs((sums[id] || 0) - ((data.wallets || {})[id] || { balance: 0 }).balance) > 0.005)
    .map(id => ({ vendorId: id, ledger: sums[id] || 0, balance: ((data.wallets || {})[id] || { balance: 0 }).balance }));
}
// Charges every case that is due. Run every minute and after top-ups.
function sweep(data, { notify } = {}) {
  let charged = 0, waiting = 0;
  const walletFirms = new Set(data.users.filter(u => u.role === 'vendor_admin' && billing.configOf(u).model === 'wallet').map(u => u.id));
  if (!walletFirms.size) return { charged, waiting };
  for (const c of data.cases) {
    if (!walletFirms.has(c.vendorId)) continue;
    const r = chargeCase(data, c, { notify });
    if (r.charged) charged++; else if (r.skipped === 'low balance') waiting++;
  }
  return { charged, waiting };
}
function pendingCount(data, vendorId) {
  let n = 0;
  for (const c of data.cases) if (c.vendorId === vendorId && !(c.billing && (c.billing.walletTxnId || c.billing.waived || c.billing.invoiceId))) {
    const firm = firmById(data, vendorId), cfg = billing.configOf(firm);
    const at = billing.billableAtOf(c, cfg.billableEvent); if (at && (!cfg.startDate || Date.parse(at) >= Date.parse(cfg.startDate + 'T00:00:00+05:30'))) n++;
  }
  return n;
}
// Why a wallet firm may not open a new case right now (or null).
function blockReason(data, firm, svc) {
  if (!firm) return null;
  const cfg = billing.configOf(firm);
  if (!cfg.wallet.enabled) return null;
  const w = walletOf(data, firm.id);
  if (cfg.model === 'wallet') {
    const price = svc ? reportPrice(firm, svc) : 0;
    const need = price ? withGst(price, cfg.gstPercent).total : 0;
    const trial = cfg.trialUntil && Date.now() < Date.parse(cfg.trialUntil + 'T23:59:59+05:30');
    if (!trial && (!canAfford(data, firm, need) || (w.balance < 0 && pendingCount(data, firm.id)))) return `Your wallet balance (Rs. ${w.balance}) is too low to open a new case. Please add money first.`;
  }
  return null;
}

// ----- top-ups -----
function topup(data, vendorId, { amount, mode, reference, note, by }, { notify } = {}) {
  const a = r2(amount);
  if (!Number.isFinite(a) || a <= 0 || a > 1e7) throw new Error('Enter a valid amount.');
  const row = post(data, vendorId, { type: 'topup', desc: 'Money added', amount: a, mode: String(mode || 'bank_transfer').slice(0, 20), reference: String(reference || '').slice(0, 60), note: String(note || '').slice(0, 120), by });
  const w = walletOf(data, vendorId); if (w.balance > 0) w.lowNotified = false;
  (notify || defaultNotify)(vendorId, { type: 'wallet', text: `Rs. ${a} added to your wallet. Balance: Rs. ${w.balance}.` });
  return row;
}
function adjust(data, vendorId, { amount, note, by }) {
  const a = r2(amount);
  if (!Number.isFinite(a) || a === 0 || Math.abs(a) > 1e7) throw new Error('Enter an amount (negative to take money out).');
  if (!String(note || '').trim()) throw new Error('Write a reason for the adjustment.');
  return post(data, vendorId, { type: 'adjust', desc: 'Adjustment', amount: a, note: String(note).slice(0, 120), by });
}
function requestTopup(data, vendorId, { amount, mode, reference, note, by }) {
  const a = r2(amount);
  if (!Number.isFinite(a) || a < 1 || a > 1e7) throw new Error('Enter the amount you paid.');
  if (!String(reference || '').trim()) throw new Error('Enter the UTR / transaction reference of your payment.');
  if (txns(data).filter(t => t.type === 'topup_request' && t.status === 'pending' && t.vendorId === vendorId).length >= 20) throw new Error('Too many requests are waiting. Please wait for Praman to confirm them.');
  const dup = txns(data).find(t => t.type === 'topup_request' && t.status === 'pending' && t.vendorId === vendorId && t.reference === String(reference).trim());
  if (dup) throw new Error('You have already sent a request with this reference.');
  const row = { id: uid('wtx'), vendorId, at: new Date().toISOString(), type: 'topup_request', status: 'pending', amount: a, mode: String(mode || 'bank_transfer').slice(0, 20), reference: String(reference).trim().slice(0, 60), note: String(note || '').slice(0, 120), by, desc: 'Top-up request' };
  txns(data).push(row);
  return row;
}
function decideRequest(data, id, approve, { by, note } = {}, opts = {}) {
  const t = txns(data).find(x => x.id === id && x.type === 'topup_request');
  if (!t) throw new Error('Request not found.');
  if (t.status !== 'pending') throw new Error('This request is already decided.');
  t.status = approve ? 'approved' : 'rejected'; t.decidedAt = new Date().toISOString(); t.decidedBy = by; t.decisionNote = String(note || '').slice(0, 120);
  if (approve) topup(data, t.vendorId, { amount: t.amount, mode: t.mode, reference: t.reference, note: 'Approved request', by }, opts);
  else (opts.notify || defaultNotify)(t.vendorId, { type: 'wallet', text: `Your top-up request of Rs. ${t.amount} was not accepted${note ? ': ' + note : ''}. Please contact Praman.` });
  return t;
}

// ----- views -----
function ledger(data, vendorId, { limit = 100, before = null } = {}) {
  let l = txns(data).filter(t => t.vendorId === vendorId && t.type !== 'topup_request' || (t.vendorId === vendorId && t.type === 'topup_request' && t.status === 'pending'));
  l = l.slice().sort((a, b) => b.at.localeCompare(a.at));
  if (before) l = l.filter(t => t.at < before);
  return l.slice(0, limit);
}
function usageSummary(data, vendorId, period) {
  const [s, e] = billing.range(period); const out = { reports: 0, kyc: 0, spent: 0 };
  for (const t of txns(data)) if (t.vendorId === vendorId && (t.type === 'charge' || t.type === 'refund')) {
    const at = Date.parse(t.at); if (!(at >= s && at < e)) continue;
    const sign = t.type === 'charge' ? 1 : -1;
    out.spent = r2(out.spent - t.amount); if (t.kind === 'report') out.reports += sign; else out.kyc += sign;
  }
  return out;
}
function csv(data, vendorId) {
  const rows = [['Date (IST)', 'Type', 'What', 'Case', 'Price', 'GST', 'Amount', 'Balance', 'Reference']];
  for (const t of txns(data).filter(x => x.vendorId === vendorId && x.type !== 'topup_request').sort((a, b) => a.at.localeCompare(b.at)))
    rows.push([new Date(new Date(t.at).getTime() + 5.5 * 3600e3).toISOString().replace('T', ' ').slice(0, 16), t.type, t.desc, t.caseId || '', t.price ?? '', t.gst ?? '', t.amount, t.balanceAfter, t.reference || t.note || '']);
  return billing.csvOf(rows);
}
function overview(data, vendorId) {
  const firm = firmById(data, vendorId), cfg = billing.configOf(firm), w = walletOf(data, vendorId);
  return { enabled: cfg.wallet.enabled, balance: w.balance, creditLimit: cfg.wallet.creditLimit, lowAlert: cfg.wallet.lowAlert, gstPercent: cfg.gstPercent, model: cfg.model };
}

module.exports = { KYC, walletOf, isOn, kycRatesOf, withGst, reportPrice, chargeKyc, refund, chargeCase, onCaseCreated, reconcile, sweep, blockReason, topup, adjust, requestTopup, decideRequest, ledger, usageSummary, csv, overview, canAfford, pendingCount };
