// Billing: what a vendor firm owes Praman, by the model Super Admin chooses for that firm.
//
//   per_case      cases x price of the service (prices are firm.servicePrices, the same
//                 "price per case" Super Admin already sets on the plan screen)
//   subscription  fixed monthly fee. includedCases = how many cases the fee covers
//                 (empty = unlimited). Cases above that are billed at overagePerCase
//                 (or at the service price when no overage price is set)
//   hybrid        same as subscription but meant for "platform fee + some cases + pay per case after"
//   wallet        prepaid: each report is deducted from the firm's wallet (see wallet.js), no invoice for cases
//
// NOTHING about prices is fixed in code. Every number lives in firm.billing (set by Super Admin)
// and the seller / tax / bank details in db.data.billingSettings.
//
// A case is billed once. "Billable event" is either when it is created (default) or when it is
// completed. Super Admin can waive a case (mistake, duplicate, goodwill). When an invoice is
// issued, its cases are stamped with the invoice id so they can never be billed twice.
//
// Invoices are made monthly (for the month that just ended) as DRAFTS; Super Admin checks,
// optionally adds adjustments, and issues them. Amounts are in rupees, calculated in paise.
const { uid } = require('../db');
const plans = require('./plans');

const MODELS = ['per_case', 'subscription', 'hybrid', 'wallet'];
const MODEL_LABEL = { per_case: 'Pay per case (invoice)', subscription: 'Subscription', hybrid: 'Subscription + per case', wallet: 'Prepaid wallet' };
const IST = 5.5 * 3600e3;
const toP = x => Math.round(Number(x || 0) * 100);
const fromP = p => Math.round(p) / 100;
const pad = n => String(n).padStart(2, '0');

// ---------- periods (India time) ----------
function periodOf(date = new Date()) { return new Date(new Date(date).getTime() + IST).toISOString().slice(0, 7); }
function prevPeriod(date = new Date()) {
  const x = new Date(new Date(date).getTime() + IST); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() - 1);
  return x.toISOString().slice(0, 7);
}
function range(period) {
  const [y, m] = period.split('-').map(Number);
  return [Date.UTC(y, m - 1, 1) - IST, Date.UTC(y, m, 1) - IST];
}
const validPeriod = p => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(p || ''));
function monthLabel(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function fyOf(date) {
  const x = new Date(new Date(date).getTime() + IST); const y = x.getUTCFullYear(), m = x.getUTCMonth() + 1;
  const a = m >= 4 ? y : y - 1;
  return `${a}-${pad((a + 1) % 100)}`;
}
const dayEnd = ymd => { const [y, m, d] = String(ymd).split('-').map(Number); return Date.UTC(y, m - 1, d + 1) - IST; }; // end of that India day

// ---------- settings ----------
function settingsOf(data) {
  const s = data.billingSettings || {};
  return {
    legalName: s.legalName || '', address: s.address || '', gstin: s.gstin || '', pan: s.pan || '', state: s.state || '',
    email: s.email || '', phone: s.phone || '',
    invoicePrefix: (s.invoicePrefix || 'PRM').replace(/[^A-Za-z0-9-]/g, '').slice(0, 10) || 'PRM',
    bank: { name: (s.bank && s.bank.name) || '', account: (s.bank && s.bank.account) || '', ifsc: (s.bank && s.bank.ifsc) || '', branch: (s.bank && s.bank.branch) || '' },
    upi: s.upi || '', terms: s.terms || '',
    defaultPaymentTermsDays: Number.isFinite(Number(s.defaultPaymentTermsDays)) ? Number(s.defaultPaymentTermsDays) : 15,
    autoIssue: s.autoIssue === true,
    kycRates: Object.fromEntries(require('./gridlines-apis').KINDS.map(k => [k, Number(s.kycRates && s.kycRates[k]) || 0]))
  };
}
function cleanSettings(b = {}) {
  const t = (v, n = 300) => String(v == null ? '' : v).trim().slice(0, n);
  const days = Number(b.defaultPaymentTermsDays);
  return {
    legalName: t(b.legalName, 120), address: t(b.address, 400), gstin: t(b.gstin, 20).toUpperCase(), pan: t(b.pan, 12).toUpperCase(), state: t(b.state, 60),
    email: t(b.email, 120), phone: t(b.phone, 30), invoicePrefix: t(b.invoicePrefix, 10) || 'PRM',
    bank: { name: t(b.bank && b.bank.name, 80), account: t(b.bank && b.bank.account, 30), ifsc: t(b.bank && b.bank.ifsc, 15).toUpperCase(), branch: t(b.bank && b.bank.branch, 80) },
    upi: t(b.upi, 60), terms: t(b.terms, 800),
    defaultPaymentTermsDays: Number.isFinite(days) && days >= 0 && days <= 120 ? Math.round(days) : 15,
    autoIssue: b.autoIssue === true,
    kycRates: Object.fromEntries(require('./gridlines-apis').KINDS.map(k => { const n = Number(b.kycRates && b.kycRates[k]); return [k, Number.isFinite(n) && n >= 0 && n <= 10000 ? Math.round(n * 100) / 100 : 0]; }))
  };
}

// ---------- per-firm plan ----------
const num = (v, d = null) => (v === '' || v == null || !Number.isFinite(Number(v))) ? d : Number(v);
function configOf(firm) {
  const b = (firm && firm.billing) || {}, sub = b.subscription || {}, by = b.buyer || {};
  return {
    model: MODELS.includes(b.model) ? b.model : null,
    startDate: b.startDate || null,
    trialUntil: b.trialUntil || null,
    gstPercent: num(b.gstPercent, 18),
    discountPercent: num(b.discountPercent, 0),
    subscription: { name: sub.name || 'Praman subscription', monthlyFee: num(sub.monthlyFee, 0), includedCases: num(sub.includedCases, null), overagePerCase: num(sub.overagePerCase, null) },
    minimumMonthly: num(b.minimumMonthly, 0),
    billableEvent: b.billableEvent === 'completed' ? 'completed' : 'created',
    paymentTermsDays: num(b.paymentTermsDays, null),
    blockAfterDays: num(b.blockAfterDays, null),
    buyer: { legalName: by.legalName || '', gstin: by.gstin || '', state: by.state || '', address: by.address || '', email: by.email || '' },
    notes: b.notes || '',
    wallet: (() => { const w = b.wallet || {}; return { enabled: b.model === 'wallet' || w.enabled === true, creditLimit: num(w.creditLimit, 0), lowAlert: num(w.lowAlert, null), kycRates: w.kycRates || {} }; })()
  };
}
// Checks what Super Admin typed. Returns { error } or { config } (ready to store).
function validateConfig(input = {}) {
  const out = {};
  const bad = m => ({ error: m });
  if (input.model === '' || input.model == null) out.model = null;
  else if (!MODELS.includes(input.model)) return bad('Billing model must be per_case, subscription or hybrid.');
  else out.model = input.model;
  const money = (v, label, max = 1e7) => {
    if (v === '' || v == null) return null;
    const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${label} is not valid.`);
    return Math.round(n * 100) / 100;
  };
  try {
    const s = input.subscription || {};
    out.subscription = { name: String(s.name || '').trim().slice(0, 60), monthlyFee: money(s.monthlyFee, 'Monthly fee') || 0, includedCases: money(s.includedCases, 'Included cases', 1e6), overagePerCase: money(s.overagePerCase, 'Price per extra case') };
    out.minimumMonthly = money(input.minimumMonthly, 'Minimum monthly charge') || 0;
    out.discountPercent = money(input.discountPercent, 'Discount', 100) || 0;
    const g = input.gstPercent === '' || input.gstPercent == null ? 18 : Number(input.gstPercent);
    if (!Number.isFinite(g) || g < 0 || g > 40) throw new Error('GST % is not valid.');
    out.gstPercent = g;
    const terms = money(input.paymentTermsDays, 'Payment terms', 120); out.paymentTermsDays = terms == null ? null : Math.round(terms);
    const block = money(input.blockAfterDays, 'Block-after days', 365); out.blockAfterDays = block == null ? null : Math.round(block);
  } catch (e) { return bad(e.message); }
  for (const k of ['startDate', 'trialUntil']) {
    const v = String(input[k] || '').trim();
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return bad(`${k === 'startDate' ? 'Start date' : 'Free-trial end date'} must look like 2026-11-01.`);
    out[k] = v || null;
  }
  out.billableEvent = input.billableEvent === 'completed' ? 'completed' : 'created';
  const by = input.buyer || {};
  out.buyer = { legalName: String(by.legalName || '').trim().slice(0, 120), gstin: String(by.gstin || '').trim().toUpperCase().slice(0, 20), state: String(by.state || '').trim().slice(0, 60), address: String(by.address || '').trim().slice(0, 400), email: String(by.email || '').trim().slice(0, 120) };
  out.notes = String(input.notes || '').trim().slice(0, 500);
  try {
    const w = input.wallet || {}, kr = {};
    for (const k of require('./gridlines-apis').KINDS) { const v = money((w.kycRates || {})[k], 'ID check price'); if (v != null) kr[k] = v; }
    out.wallet = { enabled: out.model === 'wallet' || w.enabled === true, creditLimit: money(w.creditLimit, 'Credit limit') || 0, lowAlert: money(w.lowAlert, 'Low-balance alert'), kycRates: kr };
  } catch (e) { return bad(e.message); }
  if (out.model && out.model !== 'per_case' && out.model !== 'wallet' && !(out.subscription.monthlyFee > 0)) return bad('A subscription needs a monthly fee. (Use the per-case model if there is no fixed fee.)');
  return { config: out };
}

// ---------- metering ----------
function billableAt(c, event) {
  if (event === 'completed') return c.completedAt || (c.aiCall && c.aiCall.completedAt) || null;
  return c.createdAt || null;
}
function meter(data, vendorId, period, cfg, invoiceId) {
  const [s, e] = range(period);
  const start = cfg.startDate ? dayEnd(cfg.startDate) - 86400e3 : 0;
  const trialEnd = cfg.trialUntil ? dayEnd(cfg.trialUntil) : 0;
  const by = {}, trial = {}; let waived = 0, total = 0, trialN = 0;
  for (const c of data.cases || []) {
    if (c.vendorId !== vendorId) continue;
    const at = billableAt(c, cfg.billableEvent); if (!at) continue;
    const t = Date.parse(at); if (!(t >= s && t < e) || t < start) continue;
    if (c.billing && c.billing.walletTxnId) continue;                                       // paid from the wallet
    if (c.billing && c.billing.invoiceId && c.billing.invoiceId !== invoiceId) continue; // already on another invoice
    if (c.billing && c.billing.waived) { waived++; continue; }
    const svc = plans.serviceOfCase(c);
    if (t < trialEnd) { trial[svc] = (trial[svc] || 0) + 1; trialN++; continue; }
    by[svc] = (by[svc] || 0) + 1; total++;
  }
  return { byService: by, trialByService: trial, total, trial: trialN, waived };
}

// ---------- the price calculation ----------
// cfg can be replaced to try "what if" prices. invoice (optional) carries manual adjustments.
function calculate(data, firm, period, { cfg = configOf(firm), invoice = null, settings = settingsOf(data) } = {}) {
  const warnings = [];
  const u = meter(data, firm.id, period, cfg, invoice && invoice.id);
  const lines = [];
  const rate = svc => { const r = firm.servicePrices && firm.servicePrices[svc]; if (r == null) { warnings.push(`Price per case for ${plans.SERVICES[svc].short} is not set`); return 0; } return Number(r); };
  const label = svc => plans.SERVICES[svc].label;
  const push = (kind, desc, qty, r, extra = {}) => lines.push({ kind, desc, qty, rate: r, amount: fromP(Math.round(qty * toP(r))), ...extra });

  if (!cfg.model) warnings.push('No billing model chosen for this firm');
  if (cfg.model === 'per_case') {
    for (const svc of plans.ALL) if (u.byService[svc]) push('case', label(svc), u.byService[svc], rate(svc), { service: svc });
  } else if (cfg.model === 'subscription' || cfg.model === 'hybrid') {
    const sub = cfg.subscription;
    push('subscription', `${sub.name} - ${monthLabel(period)}`, 1, sub.monthlyFee);
    let remaining = sub.includedCases == null ? (cfg.model === 'subscription' ? Infinity : 0) : sub.includedCases;
    let included = 0;
    for (const svc of plans.ALL) {
      const n = u.byService[svc] || 0; if (!n) continue;
      const free = Math.min(n, remaining); remaining -= free; included += free;
      const over = n - free;
      if (over > 0) push('overage', `${label(svc)} - cases above the plan`, over, sub.overagePerCase != null ? sub.overagePerCase : rate(svc), { service: svc });
    }
    if (included) lines.push({ kind: 'included', desc: `${included} case${included > 1 ? 's' : ''} covered by the subscription`, qty: included, rate: 0, amount: 0 });
  }
  if (u.trial) lines.push({ kind: 'trial', desc: `${u.trial} free trial case${u.trial > 1 ? 's' : ''}`, qty: u.trial, rate: 0, amount: 0 });
  if (cfg.model === 'per_case' && cfg.minimumMonthly > 0) {
    const have = lines.reduce((s, l) => s + toP(l.amount), 0);
    if (have < toP(cfg.minimumMonthly) && (u.total || have)) push('minimum', 'Minimum monthly charge (balance)', 1, fromP(toP(cfg.minimumMonthly) - have));
  }
  for (const a of (invoice && invoice.adjustments) || []) lines.push({ kind: 'adjustment', desc: a.desc, qty: 1, rate: a.amount, amount: a.amount });

  const subtotalP = lines.reduce((s, l) => s + toP(l.amount), 0);
  const discountP = cfg.discountPercent > 0 ? Math.round(subtotalP * cfg.discountPercent / 100) : 0;
  const taxableP = subtotalP - discountP;
  let gst = { percent: cfg.gstPercent, type: 'NONE', cgst: 0, sgst: 0, igst: 0, total: 0 };
  if (cfg.gstPercent > 0 && taxableP > 0) {
    const taxP = Math.round(taxableP * cfg.gstPercent / 100);
    const norm = s => String(s || '').trim().toLowerCase();
    const intra = norm(settings.state) && norm(cfg.buyer.state) && norm(settings.state) === norm(cfg.buyer.state);
    if (intra) { const half = Math.round(taxP / 2); gst = { percent: cfg.gstPercent, type: 'CGST_SGST', cgst: fromP(half), sgst: fromP(taxP - half), igst: 0, total: fromP(taxP) }; }
    else gst = { percent: cfg.gstPercent, type: 'IGST', cgst: 0, sgst: 0, igst: fromP(taxP), total: fromP(taxP) };
  }
  return {
    period, model: cfg.model, lines, usage: u, subtotal: fromP(subtotalP), discountPercent: cfg.discountPercent, discount: fromP(discountP),
    taxable: fromP(taxableP), gst, total: fromP(taxableP + toP(gst.total)), warnings
  };
}

// ---------- invoices ----------
const invoicesOf = data => (data.invoices ||= []);
const paidOf = inv => fromP((inv.payments || []).reduce((s, p) => s + toP(p.amount), 0));
const dueOf = inv => fromP(Math.max(0, toP(inv.total) - toP(paidOf(inv))));
function effectiveStatus(inv, now = new Date()) {
  if (inv.status === 'void' || inv.status === 'draft' || inv.status === 'paid') return inv.status;
  return inv.dueAt && new Date(inv.dueAt) < now ? 'overdue' : inv.status;
}
function view(inv, now = new Date()) {
  return { ...inv, paid: paidOf(inv), outstanding: inv.status === 'draft' || inv.status === 'void' ? 0 : dueOf(inv), displayStatus: effectiveStatus(inv, now) };
}
const liveFor = (data, vendorId, period) => invoicesOf(data).find(i => i.vendorId === vendorId && i.period === period && i.status !== 'void');

// Makes (or refreshes) the draft for one firm and month. Never touches an issued invoice.
function generate(data, firm, period, { by = 'system', now = new Date() } = {}) {
  const cfg = configOf(firm);
  if (!cfg.model) return { skipped: 'no billing model' };
  const existing = liveFor(data, firm.id, period);
  if (existing && existing.status !== 'draft') return { skipped: 'already invoiced', invoice: existing };
  const calc = calculate(data, firm, period, { cfg, invoice: existing });
  if (!existing && calc.total === 0 && !calc.lines.some(l => l.kind !== 'trial' && l.kind !== 'included')) return { skipped: 'nothing to bill' };
  const inv = existing || { id: uid('inv'), vendorId: firm.id, vendorName: firm.vendorName, period, status: 'draft', createdAt: now.toISOString(), createdBy: by, adjustments: [], payments: [], notes: '' };
  Object.assign(inv, { model: calc.model, lines: calc.lines, usage: calc.usage, subtotal: calc.subtotal, discountPercent: calc.discountPercent, discount: calc.discount, taxable: calc.taxable, gst: calc.gst, total: calc.total, warnings: calc.warnings, recalculatedAt: now.toISOString() });
  if (!existing) invoicesOf(data).push(inv);
  return { invoice: inv, created: !existing };
}

function nextNumber(data, settings, at) {
  const fy = fyOf(at), pre = `${settings.invoicePrefix}/${fy}/`;
  let max = 0;
  for (const i of invoicesOf(data)) if (i.number && i.number.startsWith(pre)) max = Math.max(max, Number(i.number.slice(pre.length)) || 0);
  return pre + String(max + 1).padStart(4, '0');
}

function issue(data, inv, { by = 'system', now = new Date() } = {}) {
  if (inv.status !== 'draft') throw new Error('Only a draft can be issued.');
  const firm = data.users.find(u => u.id === inv.vendorId);
  if (!firm) throw new Error('Firm not found.');
  const cfg = configOf(firm), settings = settingsOf(data);
  const fresh = calculate(data, firm, inv.period, { cfg, invoice: inv, settings });   // final recalculation
  Object.assign(inv, { lines: fresh.lines, usage: fresh.usage, subtotal: fresh.subtotal, discount: fresh.discount, taxable: fresh.taxable, gst: fresh.gst, total: fresh.total });
  if (inv.total <= 0 && !inv.lines.length) throw new Error('Nothing to bill in this invoice.');
  inv.number = nextNumber(data, settings, now);
  inv.status = 'issued';
  inv.issuedAt = now.toISOString(); inv.issuedBy = by;
  const days = cfg.paymentTermsDays != null ? cfg.paymentTermsDays : settings.defaultPaymentTermsDays;
  inv.dueAt = new Date(now.getTime() + days * 86400e3).toISOString();
  inv.seller = { legalName: settings.legalName, address: settings.address, gstin: settings.gstin, pan: settings.pan, state: settings.state, email: settings.email, phone: settings.phone, bank: settings.bank, upi: settings.upi, terms: settings.terms };
  inv.buyer = { ...cfg.buyer, legalName: cfg.buyer.legalName || firm.vendorName };
  // stamp the cases so they are never billed again
  const [s, e] = range(inv.period);
  for (const c of data.cases) {
    if (c.vendorId !== inv.vendorId || (c.billing && (c.billing.waived || c.billing.invoiceId))) continue;
    const at = billableAt(c, cfg.billableEvent); if (!at) continue;
    const t = Date.parse(at); if (!(t >= s && t < e)) continue;
    if (cfg.startDate && t < dayEnd(cfg.startDate) - 86400e3) continue;
    (c.billing ||= {}).invoiceId = inv.id;
  }
  return inv;
}

function voidInvoice(data, inv, reason, by) {
  if (inv.status === 'void') throw new Error('Already cancelled.');
  if ((inv.payments || []).length) throw new Error('This invoice has payments recorded. Remove them first or issue an adjustment on the next invoice.');
  inv.status = 'void'; inv.voidReason = String(reason || '').slice(0, 200); inv.voidedAt = new Date().toISOString(); inv.voidedBy = by;
  for (const c of data.cases) if (c.billing && c.billing.invoiceId === inv.id) delete c.billing.invoiceId; // billable again
  return inv;
}

function addPayment(inv, { amount, mode, reference, date, note }, by) {
  if (inv.status === 'draft' || inv.status === 'void') throw new Error('Payments can be recorded only on an issued invoice.');
  const a = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(a) || a <= 0) throw new Error('Enter the amount received.');
  if (toP(a) > toP(dueOf(inv))) throw new Error(`The amount is more than what is due (${dueOf(inv)}).`);
  const d = date && !isNaN(new Date(date)) ? new Date(date).toISOString() : new Date().toISOString();
  (inv.payments ||= []).push({ id: uid('pay'), amount: a, mode: String(mode || 'bank_transfer').slice(0, 20), reference: String(reference || '').slice(0, 60), date: d, note: String(note || '').slice(0, 120), recordedBy: by, recordedAt: new Date().toISOString() });
  inv.status = dueOf(inv) <= 0 ? 'paid' : 'partial';
  if (inv.status === 'paid') inv.paidAt = d;
  return inv;
}
function removePayment(inv, paymentId) {
  const before = (inv.payments || []).length;
  inv.payments = (inv.payments || []).filter(p => p.id !== paymentId);
  if (inv.payments.length === before) throw new Error('Payment not found.');
  inv.status = inv.payments.length ? (dueOf(inv) <= 0 ? 'paid' : 'partial') : 'issued';
  if (inv.status !== 'paid') delete inv.paidAt;
  return inv;
}

// ---------- stopping new cases when a firm does not pay ----------
// Only if Super Admin set "block after N days overdue" for that firm.
function blockReason(data, firm, now = new Date(), svc = null) {
  if (!firm) return null;
  const wr = require('./wallet').blockReason(data, firm, svc); if (wr) return wr;
  const cfg = configOf(firm);
  if (cfg.blockAfterDays == null) return null;
  const late = invoicesOf(data).find(i => i.vendorId === firm.id && ['issued', 'partial'].includes(i.status) && i.dueAt && now - new Date(i.dueAt) > cfg.blockAfterDays * 86400e3);
  return late ? `New cases are paused because invoice ${late.number} is overdue. Please pay it or contact Praman.` : null;
}

// ---------- the daily job ----------
async function tick({ now = new Date(), data, write, notify, mail } = {}) {
  const { db } = require('../db');
  data = data || db.data; write = write || (() => db.write());
  notify = notify || ((v, n) => require('./notifications').notify(v, n));
  const out = { drafted: 0, issued: 0, reminded: 0 };
  const period = prevPeriod(now), settings = settingsOf(data);
  for (const firm of data.users.filter(u => u.role === 'vendor_admin' && u.approved !== false)) {
    if (!configOf(firm).model) continue;
    if (liveFor(data, firm.id, period)) continue;
    const r = generate(data, firm, period, { by: 'system', now });
    if (r.invoice && r.created) {
      out.drafted++;
      if (settings.autoIssue) { try { issue(data, r.invoice, { by: 'system', now }); out.issued++; notify(firm.id, { type: 'invoice', text: `Invoice ${r.invoice.number} for ${monthLabel(period)} is ready - Rs. ${r.invoice.total}` }); } catch { /* stays a draft */ } }
    }
  }
  for (const inv of invoicesOf(data)) {
    if (!['issued', 'partial'].includes(inv.status) || !inv.dueAt || new Date(inv.dueAt) >= now) continue;
    if (inv.lastReminderAt && now - new Date(inv.lastReminderAt) < 7 * 86400e3) continue;
    inv.lastReminderAt = now.toISOString();
    notify(inv.vendorId, { type: 'invoice', text: `Invoice ${inv.number} (Rs. ${dueOf(inv)} due) is overdue` });
    out.reminded++;
  }
  if (out.drafted || out.issued || out.reminded) await write();
  return out;
}

// ---------- summaries ----------
function csv(rows) {
  const cell = v => { let s = String(v == null ? '' : v); if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // stops spreadsheet formulas in names
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return rows.map(r => r.map(cell).join(',')).join('\r\n');
}
function invoicesCsv(data, list) {
  const rows = [['Invoice no', 'Status', 'Firm', 'Period', 'Issued', 'Due', 'Model', 'Subtotal', 'Discount', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total', 'Paid', 'Outstanding', 'Buyer GSTIN']];
  for (const i of list) {
    const v = view(i);
    rows.push([i.number || '(draft)', v.displayStatus, i.vendorName, i.period, i.issuedAt ? i.issuedAt.slice(0, 10) : '', i.dueAt ? i.dueAt.slice(0, 10) : '', i.model, i.subtotal, i.discount, i.taxable, i.gst.cgst, i.gst.sgst, i.gst.igst, i.total, v.paid, v.outstanding, (i.buyer && i.buyer.gstin) || '']);
  }
  return csv(rows);
}
function summary(data, now = new Date()) {
  const live = invoicesOf(data).filter(i => i.status !== 'draft' && i.status !== 'void');
  const billed = live.reduce((s, i) => s + toP(i.total), 0), paid = live.reduce((s, i) => s + toP(paidOf(i)), 0);
  const overdue = live.filter(i => effectiveStatus(i, now) === 'overdue');
  return {
    billed: fromP(billed), collected: fromP(paid), outstanding: fromP(billed - paid),
    overdueCount: overdue.length, overdueAmount: fromP(overdue.reduce((s, i) => s + toP(dueOf(i)), 0)),
    drafts: invoicesOf(data).filter(i => i.status === 'draft').length
  };
}

module.exports = {
  MODELS, MODEL_LABEL, periodOf, prevPeriod, range, validPeriod, monthLabel, fyOf,
  settingsOf, cleanSettings, configOf, validateConfig, meter, calculate,
  generate, issue, voidInvoice, addPayment, removePayment, view, effectiveStatus, paidOf, dueOf, liveFor, invoicesOf,
  blockReason, tick, invoicesCsv, summary, billableAtOf: billableAt, csvOf: csv
};
