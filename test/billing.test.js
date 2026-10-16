require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, server } = require('../src/server');
const { db } = require('../src/db');
const { signToken } = require('../src/services/auth');
const billing = require('../src/services/billing');

let base, SA, FA, AG;
const call = async (method, path, tok, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json().catch(() => ({})) : Buffer.from(await r.arrayBuffer()) };
};
const mk = (id, vendorId, createdAt, extra = {}) => ({ id, vendorId, caseRef: 'PR-' + id, claimNo: 'C-' + id, caseType: 'claim_investigation', service: 'motor_claim', status: 'in_progress', createdAt, ...extra });

test.before(async () => {
  await start(0); base = `http://127.0.0.1:${server.address().port}`;
  const d = db.data;
  d.users.push(
    { id: 'sa', email: 'sa@t', role: 'super_admin' },
    { id: 'b1', email: 'b1@t', vendorName: 'Alpha Claims', role: 'vendor_admin', approved: true, services: ['motor_claim', 'pivc_life'], servicePrices: { motor_claim: 400, pivc_life: 150 } },
    { id: 'b2', email: 'b2@t', vendorName: 'Beta', role: 'vendor_admin', approved: true, services: ['motor_claim'], servicePrices: { motor_claim: 500 } },
    { id: 'bg', email: 'bg@t', role: 'agent', parentVendorId: 'b1' }
  );
  const sep = '2026-09-';
  // Alpha: 3 motor + 2 life in September (India time), 1 in August, 1 in October
  for (let i = 1; i <= 3; i++) d.cases.push(mk('m' + i, 'b1', sep + '1' + i + 'T06:00:00Z'));
  for (let i = 1; i <= 2; i++) d.cases.push(mk('l' + i, 'b1', sep + '2' + i + 'T06:00:00Z', { service: 'pivc_life', caseType: 'policy_verification' }));
  d.cases.push(mk('aug', 'b1', '2026-08-31T20:00:00Z'));          // 1 Sep 01:30 IST -> September!
  d.cases.push(mk('oct', 'b1', '2026-09-30T19:00:00Z'));          // 1 Oct 00:30 IST -> October
  d.cases.push(mk('x', 'b2', sep + '05T06:00:00Z'));
  await db.write();
  SA = signToken({ id: 'sa', email: 'sa@t', role: 'super_admin' });
  FA = signToken({ id: 'b1', email: 'b1@t', role: 'vendor_admin', vendorRootId: 'b1' });
  AG = signToken({ id: 'bg', email: 'bg@t', role: 'agent', parentVendorId: 'b1', vendorRootId: 'b1' });
});
test.after(() => server.close());

const firm = id => db.data.users.find(u => u.id === id);

test('periods use India time', () => {
  assert.equal(billing.periodOf(new Date('2026-08-31T20:00:00Z')), '2026-09');
  assert.equal(billing.prevPeriod(new Date('2026-10-01T00:10:00+05:30')), '2026-09');
  assert.equal(billing.fyOf(new Date('2027-02-10T00:00:00Z')), '2026-27');
  assert.equal(billing.fyOf(new Date('2026-04-02T00:00:00Z')), '2026-27');
  assert.equal(billing.fyOf(new Date('2026-03-31T00:00:00Z')), '2025-26');
});

test('config is validated and nothing is fixed in code', () => {
  assert.ok(billing.validateConfig({ model: 'weird' }).error);
  assert.ok(billing.validateConfig({ model: 'subscription', subscription: { monthlyFee: 0 } }).error);
  assert.ok(billing.validateConfig({ model: 'per_case', gstPercent: 99 }).error);
  assert.ok(billing.validateConfig({ model: 'per_case', trialUntil: 'soon' }).error);
  assert.equal(billing.validateConfig({ model: 'per_case' }).config.model, 'per_case');
  assert.equal(billing.configOf({}).model, null);
});

test('per-case: counts by service, India month edges, GST intra vs inter state', () => {
  const f = firm('b1'); f.billing = billing.validateConfig({ model: 'per_case', gstPercent: 18 }).config;
  const c = billing.calculate(db.data, f, '2026-09');
  assert.equal(c.usage.total, 6);               // 3 motor + 2 life + the one at 01:30 IST on 1 Sep
  assert.equal(c.lines.find(l => l.service === 'motor_claim').qty, 4);
  assert.equal(c.subtotal, 4 * 400 + 2 * 150);
  assert.equal(c.gst.type, 'IGST'); assert.equal(c.gst.igst, 342); assert.equal(c.total, 2242);
  db.data.billingSettings = { state: 'Uttar Pradesh' }; f.billing.buyer.state = 'uttar pradesh';
  const c2 = billing.calculate(db.data, f, '2026-09');
  assert.equal(c2.gst.type, 'CGST_SGST'); assert.equal(c2.gst.cgst + c2.gst.sgst, 342);
  assert.equal(billing.calculate(db.data, f, '2026-10').usage.total, 1);
});

test('per-case: missing price warns, minimum tops up, discount and free trial work', () => {
  const f = { id: 'b1', vendorName: 'A', servicePrices: { motor_claim: 100 }, billing: billing.validateConfig({ model: 'per_case', gstPercent: 0, minimumMonthly: 1000, discountPercent: 10 }).config };
  const c = billing.calculate(db.data, f, '2026-09');
  assert.ok(c.warnings.some(w => /Life PIVC/.test(w)));
  assert.equal(c.subtotal, 1000);                 // 400 + 0 -> topped up to the 1000 minimum
  assert.equal(c.discount, 100); assert.equal(c.total, 900);
  f.billing = billing.validateConfig({ model: 'per_case', gstPercent: 0, trialUntil: '2026-09-15' }).config;
  const t = billing.calculate(db.data, f, '2026-09');
  assert.equal(t.usage.trial, 4);                 // 3 on 11-13 + the 1 Sep 01:30 IST case, all before 15 Sep
  assert.ok(t.lines.some(l => l.kind === 'trial'));
});

test('subscription: unlimited, included cases + overage, hybrid', () => {
  const f = firm('b1');
  f.billing = billing.validateConfig({ model: 'subscription', gstPercent: 0, subscription: { monthlyFee: 10000 } }).config;
  let c = billing.calculate(db.data, f, '2026-09');
  assert.equal(c.total, 10000); assert.ok(c.lines.some(l => l.kind === 'included'));
  f.billing = billing.validateConfig({ model: 'subscription', gstPercent: 0, subscription: { monthlyFee: 10000, includedCases: 4, overagePerCase: 300 } }).config;
  c = billing.calculate(db.data, f, '2026-09');
  assert.equal(c.lines.find(l => l.kind === 'overage').qty, 2); assert.equal(c.total, 10000 + 600);
  f.billing = billing.validateConfig({ model: 'hybrid', gstPercent: 0, subscription: { monthlyFee: 2000 } }).config;
  c = billing.calculate(db.data, f, '2026-09');          // hybrid with nothing included: fee + every case at its own price
  assert.equal(c.total, 2000 + 4 * 400 + 2 * 150);
});

test('invoice flow: draft -> issue -> numbering -> payments -> void rules; cases billed once', async () => {
  const f = firm('b1'); f.billing = billing.validateConfig({ model: 'per_case', gstPercent: 18, paymentTermsDays: 10 }).config;
  db.data.billingSettings = billing.cleanSettings({ legalName: 'Praman Pvt Ltd', gstin: '09AAAAA0000A1Z5', state: 'Delhi', invoicePrefix: 'PRM' });
  firm('b2').billing = billing.validateConfig({ model: 'per_case', gstPercent: 18 }).config;
  await db.write();
  let r = await call('POST', '/api/super-admin/billing/generate', SA, { period: '2026-09' });
  assert.equal(r.status, 200); assert.equal(r.body.created, 2);
  const list = (await call('GET', '/api/super-admin/billing/invoices?vendorId=b1', SA)).body;
  assert.equal(list.length, 1); assert.equal(list[0].status, 'draft');
  const id = list[0].id;
  assert.equal((await call('POST', '/api/super-admin/billing/generate', SA, { period: '2026-09' })).body.created, 0);   // idempotent
  assert.equal((await call('GET', '/api/billing', FA)).body.invoices.length, 0);                                       // drafts are private
  let u = await call('PUT', '/api/super-admin/billing/invoices/' + id, SA, { adjustments: [{ desc: 'Goodwill credit', amount: -200 }] });
  assert.equal(u.body.subtotal, 1900 - 200);
  let iss = await call('POST', `/api/super-admin/billing/invoices/${id}/issue`, SA);
  assert.equal(iss.status, 200); assert.match(iss.body.number, /^PRM\/2026-\d{2}\/0001$/);
  assert.equal((await call('POST', `/api/super-admin/billing/invoices/${id}/issue`, SA)).status, 409);
  assert.equal(db.data.cases.filter(c => c.billing && c.billing.invoiceId === id).length, 6);
  // second invoice gets the next number
  const b2 = db.data.invoices.find(i => i.vendorId === 'b2');
  assert.match((await call('POST', `/api/super-admin/billing/invoices/${b2.id}/issue`, SA)).body.number, /\/0002$/);
  // payments
  const total = iss.body.total;
  assert.equal((await call('POST', `/api/super-admin/billing/invoices/${id}/payments`, SA, { amount: total + 1 })).status, 400);
  let p = await call('POST', `/api/super-admin/billing/invoices/${id}/payments`, SA, { amount: 1000, mode: 'upi', reference: 'UTR1' });
  assert.equal(p.body.status, 'partial'); assert.equal(p.body.outstanding, Math.round((total - 1000) * 100) / 100);
  assert.equal((await call('POST', `/api/super-admin/billing/invoices/${id}/void`, SA, { reason: 'x' })).status, 409); // has a payment
  p = await call('POST', `/api/super-admin/billing/invoices/${id}/payments`, SA, { amount: total - 1000 });
  assert.equal(p.body.status, 'paid');
  const pid = p.body.payments[1].id;
  assert.equal((await call('DELETE', `/api/super-admin/billing/invoices/${id}/payments/${pid}`, SA)).body.status, 'partial');
  // firm view + pdf
  const mine = await call('GET', '/api/billing', FA);
  assert.equal(mine.body.invoices.length, 1); assert.equal(mine.body.invoices[0].status, 'partial');
  const pdf = await call('GET', `/api/billing/invoices/${id}/pdf`, FA);
  assert.equal(pdf.status, 200); assert.equal(pdf.body.slice(0, 4).toString(), '%PDF');
  assert.equal((await call('GET', `/api/super-admin/billing/invoices/${id}/pdf`, SA)).status, 200);
  assert.equal((await call('GET', `/api/billing/invoices/${b2.id}/pdf`, FA)).status, 404);    // another firm's invoice
  assert.match((await call('GET', '/api/super-admin/billing/invoices.csv', SA)).body.toString(), /PRM\/2026/);
  // already invoiced cases never come back
  assert.equal(billing.calculate(db.data, f, '2026-09', { invoice: null }).usage.total, 0);
});

test('void releases cases; waive removes a case from billing', async () => {
  const b2 = db.data.invoices.find(i => i.vendorId === 'b2');
  assert.equal((await call('POST', `/api/super-admin/billing/invoices/${b2.id}/void`, SA, { reason: 'wrong price' })).body.status, 'void');
  const f2 = firm('b2'); f2.billing = billing.validateConfig({ model: 'per_case', gstPercent: 0 }).config;
  assert.equal(billing.calculate(db.data, f2, '2026-09').usage.total, 1);
  assert.equal((await call('POST', '/api/super-admin/billing/cases/x/waive', SA, { reason: 'test case' })).body.waived, true);
  assert.equal(billing.calculate(db.data, f2, '2026-09').usage.total, 0);
  assert.equal((await call('POST', '/api/super-admin/billing/cases/m1/waive', SA, {})).status, 409);   // already invoiced
});

test('simulate, access rules, and overdue blocking', async () => {
  const sim = await call('POST', '/api/super-admin/billing/simulate', SA, { vendorId: 'b1', period: '2026-09', config: { model: 'subscription', gstPercent: 0, subscription: { monthlyFee: 5000 } } });
  assert.equal(sim.status, 200);
  assert.equal((await call('GET', '/api/super-admin/billing/firms', FA)).status, 403);
  assert.equal((await call('GET', '/api/billing', AG)).status, 403);
  // blocking
  await db.read();
  firm('b1').billing.blockAfterDays = 5; await db.write();
  const setDue = async ms => { await db.read(); db.data.invoices.find(i => i.vendorId === 'b1' && i.number).dueAt = new Date(Date.now() + ms).toISOString(); await db.write(); };
  await setDue(-10 * 86400e3);
  assert.match(billing.blockReason(db.data, firm('b1')), /overdue/);
  const mk2 = await call('POST', '/api/cases', FA, { claimNo: 'ZZ1', whatsappNumber: '9999999999', service: 'motor_claim' });
  assert.equal(mk2.status, 403); assert.match(mk2.body.error, /overdue/);
  await setDue(86400e3);
  assert.equal(billing.blockReason(db.data, firm('b1')), null);
});

test('monthly job drafts last month once and reminds about overdue invoices', async () => {
  await db.read(); const f = firm('b1'); f.billing = billing.validateConfig({ model: 'per_case', gstPercent: 0 }).config;
  const seen = [];
  const r1 = await billing.tick({ now: new Date('2026-11-02T10:00:00+05:30'), notify: (v, n) => seen.push([v, n.text]), write: async () => {} });
  assert.ok(r1.drafted >= 1);                       // October draft for Alpha (1 case)
  assert.equal(r1.reminded, 1);                     // the part-paid September invoice is overdue by now
  assert.equal((await billing.tick({ now: new Date('2026-11-02T11:00:00+05:30'), notify: () => {}, write: async () => {} })).drafted, 0);
  const again = await billing.tick({ now: new Date('2026-11-05T10:00:00+05:30'), notify: () => {}, write: async () => {} });
  assert.equal(again.reminded, 0);                  // at most once a week
  const r2 = await billing.tick({ now: new Date('2026-11-10T10:00:00+05:30'), notify: (v, n) => seen.push([v, n.text]), write: async () => {} });
  assert.equal(r2.reminded, 1); assert.ok(seen.some(s => /overdue/.test(s[1])));
});
