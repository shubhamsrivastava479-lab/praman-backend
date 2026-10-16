require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, server } = require('../src/server');
const { db } = require('../src/db');
const { signToken } = require('../src/services/auth');
const billing = require('../src/services/billing');
const wallet = require('../src/services/wallet');
const kyc = require('../src/services/kyc');

let base, SA, FA;
const call = async (method, path, tok, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json().catch(() => ({})) : Buffer.from(await r.arrayBuffer()).toString() };
};
const firm = id => db.data.users.find(u => u.id === id);
const noNotify = () => {};

test.before(async () => {
  await start(0); base = `http://127.0.0.1:${server.address().port}`;
  const d = db.data;
  d.users.push({ id: 'sa', email: 'sa@t', role: 'super_admin' },
    { id: 'w1', email: 'w1@t', vendorName: 'Wallet Co', role: 'vendor_admin', approved: true, services: ['motor_claim'], servicePrices: { motor_claim: 100 },
      billing: billing.validateConfig({ model: 'wallet', gstPercent: 18, wallet: { lowAlert: 50, kycRates: { pan: 10 } } }).config },
    { id: 'k1', email: 'k1@t', vendorName: 'Invoice Co', role: 'vendor_admin', approved: true, services: ['motor_claim'], servicePrices: { motor_claim: 100 },
      billing: billing.validateConfig({ model: 'per_case', gstPercent: 0, wallet: { enabled: true } }).config });
  d.billingSettings = billing.cleanSettings({ legalName: 'Praman', kycRates: { dl: 5, aadhaar_generate: 3, aadhaar_verify: 4, pan: 6 } });
  await db.write();
  SA = signToken({ id: 'sa', email: 'sa@t', role: 'super_admin' });
  FA = signToken({ id: 'w1', email: 'w1@t', role: 'vendor_admin', vendorRootId: 'w1' });
});
test.after(() => server.close());

test('config: wallet model switches the wallet on; rates come from settings with firm override', () => {
  assert.equal(billing.configOf(firm('w1')).wallet.enabled, true);
  assert.equal(billing.configOf(firm('k1')).model, 'per_case');
  assert.deepEqual(wallet.kycRatesOf(db.data, firm('w1')), { dl: 5, aadhaar_generate: 3, aadhaar_verify: 4, pan: 10 }); // pan overridden
  assert.deepEqual(wallet.kycRatesOf(db.data, firm('k1')).pan, 6);
});

test('top-up, ID check charge with GST, refund when the provider fails', async () => {
  assert.throws(() => wallet.chargeKyc(db.data, 'w1', 'pan', { notify: noNotify }), /too low/);   // empty wallet
  wallet.topup(db.data, 'w1', { amount: 200, reference: 'UTR1', by: 'sa' }, { notify: noNotify });
  const realFetch = global.fetch; let mode = 'ok';
  global.fetch = async (url, o) => /gridlines/.test(String(url)) ? (mode === 'ok' ? { ok: true, status: 200, json: async () => ({ data: { x: 1 } }) } : { ok: false, status: 500, json: async () => ({ message: 'boom' }) }) : realFetch(url, o);
  try {
    const creds = { apiKey: 'k', billTo: { vendorId: 'w1', caseId: 'c9' } };
    await kyc.verifyPan('ABCDE1234F', 'A', '01/01/1990', creds);
    assert.equal(wallet.walletOf(db.data, 'w1').balance, 200 - 11.8);             // 10 + 18% GST
    mode = 'fail';
    await assert.rejects(kyc.verifyPan('ABCDE1234F', 'A', '01/01/1990', creds));
    assert.equal(wallet.walletOf(db.data, 'w1').balance, 188.2);                   // charged then given back
    const types = db.data.walletTxns.filter(t => t.vendorId === 'w1').map(t => t.type);
    assert.deepEqual(types, ['topup', 'charge', 'charge', 'refund']);
  } finally { global.fetch = realFetch; }
});

test('firms without a wallet are never charged for ID checks; zero-rate checks are free', () => {
  const before = db.data.walletTxns.length;
  db.data.users.push({ id: 'n1', role: 'vendor_admin', vendorName: 'No wallet', billing: { model: 'per_case' } });
  assert.equal(wallet.chargeKyc(db.data, 'n1', 'pan'), null);
  db.data.billingSettings.kycRates.dl = 0; db.data.users.find(u => u.id === 'w1').billing.wallet.kycRates = {};
  assert.equal(wallet.chargeKyc(db.data, 'w1', 'dl'), null);
  assert.equal(db.data.walletTxns.length, before);
  db.data.billingSettings.kycRates.dl = 5;
});

test('reports are charged once per case, with GST; low balance waits; top-up pays the waiting cases', () => {
  const d = db.data, f = firm('w1');
  d.cases.push({ id: 'r1', vendorId: 'w1', caseRef: 'PR-1', service: 'motor_claim', createdAt: new Date().toISOString() },
               { id: 'r2', vendorId: 'w1', caseRef: 'PR-2', service: 'motor_claim', createdAt: new Date().toISOString() });
  const before = wallet.walletOf(d, 'w1').balance;                                   // 188.2
  let r = wallet.sweep(d, { notify: noNotify });
  assert.equal(r.charged, 1); assert.equal(r.waiting, 1);                            // 118 each: second one can't be afforded
  assert.equal(wallet.walletOf(d, 'w1').balance, +(before - 118).toFixed(2));
  assert.equal(wallet.sweep(d, { notify: noNotify }).charged, 0);                    // never twice
  assert.match(wallet.blockReason(d, f, 'motor_claim'), /too low/);
  wallet.topup(d, 'w1', { amount: 500 }, { notify: noNotify });
  assert.equal(wallet.sweep(d, { notify: noNotify }).charged, 1);
  assert.equal(wallet.blockReason(d, f, 'motor_claim'), null);
  const t = d.walletTxns.filter(x => x.kind === 'report');
  assert.equal(t.length, 2); assert.equal(t[0].gst, 18); assert.equal(t[0].price, 100);
});

test('credit limit, completed-event billing, free trial, waived cases', () => {
  const d = db.data, f = firm('w1');
  f.billing.wallet.creditLimit = 300;
  wallet.adjust(d, 'w1', { amount: -(wallet.walletOf(d, 'w1').balance), note: 'zero it', by: 'sa' });
  assert.equal(wallet.canAfford(d, f, 118), true); assert.equal(wallet.canAfford(d, f, 400), false);
  f.billing.billableEvent = 'completed';
  d.cases.push({ id: 'r3', vendorId: 'w1', caseRef: 'PR-3', service: 'motor_claim', createdAt: new Date().toISOString() });
  assert.equal(wallet.sweep(d, { notify: noNotify }).charged, 0);                    // not completed yet
  d.cases.find(c => c.id === 'r3').completedAt = new Date().toISOString();
  assert.equal(wallet.sweep(d, { notify: noNotify }).charged, 1);
  assert.ok(wallet.walletOf(d, 'w1').balance < 0);                                   // inside the credit limit
  d.cases.push({ id: 'r4', vendorId: 'w1', caseRef: 'PR-4', service: 'motor_claim', createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), billing: { waived: true } });
  assert.equal(wallet.sweep(d, { notify: noNotify }).charged, 0);
  f.billing.trialUntil = '2099-01-01';
  d.cases.push({ id: 'r5', vendorId: 'w1', caseRef: 'PR-5', service: 'motor_claim', createdAt: new Date().toISOString(), completedAt: new Date().toISOString() });
  wallet.sweep(d, { notify: noNotify });
  assert.equal(d.cases.find(c => c.id === 'r5').billing.walletTxnId, 'free');
});

test('top-up requests: firm asks, Super Admin approves or rejects; routes and access', async () => {
  await db.write();
  assert.equal((await call('GET', '/api/wallet', SA)).status, 403);
  const w = await call('GET', '/api/wallet', FA);
  assert.equal(w.status, 200); assert.equal(w.body.enabled, true); assert.ok(w.body.rates.reports.length);
  assert.equal((await call('POST', '/api/wallet/topup-request', FA, { amount: 1000 })).status, 400);                // needs a UTR
  assert.equal((await call('POST', '/api/wallet/topup-request', FA, { amount: 1000, reference: 'UTR77', mode: 'upi' })).status, 200);
  assert.equal((await call('POST', '/api/wallet/topup-request', FA, { amount: 1000, reference: 'UTR77' })).status, 400); // duplicate
  const all = (await call('GET', '/api/super-admin/billing/wallets', SA)).body;
  assert.equal(all.requests.length, 1); const rid = all.requests[0].id;
  const before = (await call('GET', '/api/wallet', FA)).body.balance;
  assert.equal((await call('POST', `/api/super-admin/billing/wallet-requests/${rid}/approve`, SA, {})).status, 200);
  assert.equal((await call('GET', '/api/wallet', FA)).body.balance > before + 900, true);
  assert.equal((await call('POST', `/api/super-admin/billing/wallet-requests/${rid}/approve`, SA, {})).status, 409);   // only once
  assert.equal((await call('POST', '/api/super-admin/billing/wallets/w1/topup', SA, { amount: -5 })).status, 400);
  assert.equal((await call('POST', '/api/super-admin/billing/wallets/w1/adjust', SA, { amount: -10 })).status, 400);   // needs a reason
  const csv = await call('GET', '/api/wallet/ledger.csv', FA);
  assert.match(csv.body, /Money added/); assert.match(csv.body, /Medium|Motor|PAN check|Refund/);
  // refund a charge from the admin side, but only once
  const ch = db.data.walletTxns.find(t => t.type === 'charge' && !t.refundedBy);
  assert.equal((await call('POST', `/api/super-admin/billing/wallet-charges/${ch.id}/refund`, SA, {})).status, 200);
  assert.equal((await call('POST', `/api/super-admin/billing/wallet-charges/${ch.id}/refund`, SA, {})).status, 409);
});

test('opening a case through the API is refused when the wallet is empty', async () => {
  await db.read();
  const f = firm('w1'); f.billing.billableEvent = 'created'; f.billing.trialUntil = null; f.billing.wallet.creditLimit = 0;
  wallet.adjust(db.data, 'w1', { amount: -wallet.walletOf(db.data, 'w1').balance, note: 'empty', by: 'sa' });
  await db.write();
  const r = await call('POST', '/api/cases', FA, { claimNo: 'W-1', whatsappNumber: '9999999999', service: 'motor_claim' });
  assert.equal(r.status, 403); assert.match(r.body.error, /wallet/i);
});

test('bulk upload and API respect the wallet; created-event charges happen at once; csv is safe; ledger reconciles', async () => {
  await db.read();
  const f = firm('w1'); f.billing.billableEvent = 'created'; f.billing.trialUntil = null; f.billing.wallet.creditLimit = 0;
  wallet.adjust(db.data, 'w1', { amount: -wallet.walletOf(db.data, 'w1').balance + 130, note: 'set 130', by: 'sa' });   // enough for one case (118)
  await db.write();
  const XLSX = require('xlsx');
  const ws = XLSX.utils.aoa_to_sheet([['claimNo', 'whatsappNumber'], ['B1', '9999900001'], ['B2', '9999900002']]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S');
  const fd = new FormData(); fd.append('file', new Blob([XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })]), 'cases.xlsx'); fd.append('service', 'motor_claim');
  const r = await fetch(base + '/api/cases/bulk-upload', { method: 'POST', headers: { Authorization: 'Bearer ' + FA }, body: fd });
  const body = await r.json();
  const created = (body.results || []).filter(x => x.status === 'created').length, skipped = (body.results || []).filter(x => x.status === 'skipped' && /wallet/i.test(x.reason)).length;
  assert.equal(created, 1); assert.equal(skipped, 1);                      // second row refused: balance used up by the first
  await db.read();
  assert.equal(wallet.walletOf(db.data, 'w1').balance, 12);               // charged immediately: 130 - 118
  assert.deepEqual(wallet.reconcile(db.data), []);
  db.data.wallets.w1.balance += 5;                                          // someone edited the number by hand
  assert.equal(wallet.reconcile(db.data).length, 1);
  db.data.wallets.w1.balance -= 5;
  assert.match(billing.csvOf([['=HYPERLINK("x")', 'ok', -5]]), /^"'=HYPERLINK/);
  assert.match(billing.csvOf([['a', -5]]), /,-5$/);                        // real numbers stay numbers
});
