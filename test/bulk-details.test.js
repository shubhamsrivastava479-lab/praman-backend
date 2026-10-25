require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, server } = require('../src/server');
const { db } = require('../src/db');
const { signToken } = require('../src/services/auth');
const billing = require('../src/services/billing');
const { buildAiReport } = require('../src/services/ai-report');
const pdf = require('../src/services/report-pdf');

let base, FA;
test.before(async () => {
  await start(0); base = `http://127.0.0.1:${server.address().port}`;
  db.data.users.push({ id: 'bd1', email: 'bd1@t', vendorName: 'Detail Co', role: 'vendor_admin', approved: true, services: ['pivc_life', 'pivc_term', 'motor_claim'],
    billing: billing.validateConfig({ model: 'per_case', gstPercent: 0 }).config });
  await db.write();
  FA = signToken({ id: 'bd1', email: 'bd1@t', role: 'vendor_admin', vendorRootId: 'bd1' });
});
test.after(() => server.close());

test('bulk upload keeps the extra customer, insurer and claim columns; verification type picks the service', async () => {
  const XLSX = require('xlsx');
  const ws = XLSX.utils.aoa_to_sheet([
    ['Policy Number', 'Name', 'WhatsApp Number', 'Mobile No', 'Email ID', 'City', 'State', 'Insurance Company Name', 'Verification Type', 'Sum Insured', 'Date of Birth'],
    ['DP-1', 'Asha Verma', '919900000011', '919900000099', 'asha@example.com', 'Kanpur', 'Uttar Pradesh', 'Example Life', 'PIVC Term', '25,00,000', new Date(Date.UTC(1990, 4, 17))],
    ['DC-1', 'Raj Mehta', '919900000012', '919900000012', '', 'Pune', 'Maharashtra', 'Example General', 'Motor claim', '', '']
  ]);
  ws.L1 = { t: 's', v: 'Claim Amount' }; ws.L3 = { t: 's', v: '85000' }; ws['!ref'] = 'A1:L3';
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S');
  const fd = new FormData(); fd.append('file', new Blob([XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true })]), 'cases.xlsx');
  const r = await fetch(base + '/api/cases/bulk-upload', { method: 'POST', headers: { Authorization: 'Bearer ' + FA }, body: fd });
  const body = await r.json();
  assert.equal(body.created, 2, JSON.stringify(body.results));
  await db.read();
  const p = db.data.cases.find(c => c.claimNo === 'DP-1'), m = db.data.cases.find(c => c.claimNo === 'DC-1');
  assert.equal(p.service, 'pivc_term'); assert.equal(m.service, 'motor_claim');
  assert.equal(p.insuredName, 'Asha Verma'); assert.equal(p.policyValue, 2500000);
  assert.deepEqual(p.details, { mobile: '919900000099', email: 'asha@example.com', dob: '1990-05-17', city: 'Kanpur', state: 'Uttar Pradesh', insurerName: 'Example Life', verificationType: 'PIVC Term' });
  assert.equal(m.details.mobile, undefined);            // same as WhatsApp: not kept twice
  assert.equal(m.details.claimAmount, '85000');
});

test('first page groups checks into areas and marks where to focus', async () => {
  const c = { id: 'x', caseRef: 'PR-1', claimNo: 'C1', insuredName: 'A B', whatsappNumber: '919900000011', caseType: 'claim_investigation', details: { city: 'Agra' },
    aiCall: { status: 'completed', startedAt: '2026-10-01T00:00:00Z', completedAt: '2026-10-01T00:10:00Z', checks: [
      { id: 'name_spoken', label: 'Name', result: 'match' }, { id: 'blink', label: 'Blink', result: 'fail', detail: 'Eyes never closed' }, { id: 'id_tamper_pan', label: 'PAN edited', result: 'partial' }] } };
  const R = buildAiReport(c, { firm: 'F' });
  const g = pdf.glance(R, null);
  const st = k => g.tiles.find(t => t.key === k).state;
  assert.equal(st('identity'), 'clear'); assert.equal(st('face'), 'focus'); assert.equal(st('documents'), 'check'); assert.equal(st('chats'), 'none');
  assert.match(g.tiles.find(t => t.key === 'face').note, /Eyes never closed/);
  const buf = await pdf.render(R, {});
  assert.equal(buf.slice(0, 4).toString(), '%PDF');
});
