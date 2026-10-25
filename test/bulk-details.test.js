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
  db.data.users.push({ id: 'bd1', email: 'bd1@t', vendorName: 'Detail Co', role: 'vendor_admin', approved: true, services: ['pivc_life', 'pivc_term', 'motor_claim', 'bgv_employee'],
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
  assert.equal(st('identity'), 'clear'); assert.equal(st('face'), 'focus'); assert.equal(st('docs'), 'check'); assert.equal(st('police'), 'none');
  assert.match(g.tiles.find(t => t.key === 'face').note, /Eyes never closed/);
  const buf = await pdf.render(R, {});
  assert.equal(buf.slice(0, 4).toString(), '%PDF');
});

test('new services: own questions, BGV has no WhatsApp search, names map to the right service', () => {
  const engine = require('../src/services/ai-call-engine');
  const plans = require('../src/services/plans');
  const q = svc => engine.buildQueue({ service: svc, caseType: plans.SERVICES[svc].caseType, policyType: plans.SERVICES[svc].policyType, claimNo: 'X1', insuredName: 'A' }).map(s => s.id);
  assert.ok(q('health_claim').includes('q_admit_dates') && q('health_claim').includes('chats'));
  assert.ok(q('pivc_health').includes('q_waiting') && q('pivc_health').includes('body_stand'));
  assert.ok(q('bgv_employee').includes('q_qualification') && !q('bgv_employee').includes('chats') && !q('bgv_employee').includes('body_stand'));
  assert.ok(q('motor_claim').includes('q_licence'));
  assert.equal(plans.serviceFor({ caseType: 'Health claim' }), 'health_claim');
  assert.equal(plans.serviceFor({ caseType: 'PIVC Health' }), 'pivc_health');
  assert.equal(plans.serviceFor({ caseType: 'Employee BGV' }), 'bgv_employee');
  assert.equal(plans.serviceFor({ caseType: 'PIVC Term' }), 'pivc_term');
  assert.equal(plans.serviceFor({ caseType: 'Motor claim' }), 'motor_claim');
});

test('health claim triggers: early claim, same-day stay, possible pre-existing illness', () => {
  const { triggers } = require('../src/services/service-profiles');
  const t = triggers('health_claim', { details: { policyStartDate: '2026-09-01', admissionDate: '2026-09-20', dischargeDate: '20/09/2026', diagnosis: 'Hernia repair', claimAmount: '1,20,000' } });
  const by = l => t.find(x => x.label === l);
  assert.equal(by('Policy timing').state, 'focus');
  assert.equal(by('Length of hospital stay').state, 'check');
  assert.equal(by('Possible pre-existing illness').state, 'check');
  assert.equal(by('Claim amount').state, 'check');
  const life = triggers('pivc_life', { details: { dob: '1950-01-01' }, policyValue: 2000000 });
  assert.equal(life.find(x => x.label === 'Senior citizen proposer').state, 'check');
});

test('bulk upload reads numbered columns (employer1 / employer2) separately', async () => {
  const XLSX = require('xlsx');
  const ws = XLSX.utils.aoa_to_sheet([
    ['claimNo', 'insuredName', 'whatsappNumber', 'verificationType', 'Employer 1 From', 'employer1To', 'employer2From', 'Employer 2 To', 'passingYear'],
    ['BG-9', 'Arjun', '919900000077', 'Employee BGV', '2022-01', '2024-02', '2018-07', '2021-08', '2018']
  ]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S');
  const fd = new FormData(); fd.append('file', new Blob([XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })]), 'b.xlsx');
  const body = await (await fetch(base + '/api/cases/bulk-upload', { method: 'POST', headers: { Authorization: 'Bearer ' + FA }, body: fd })).json();
  assert.equal(body.created, 1, JSON.stringify(body.results));
  const c = db.data.cases.find(x => x.claimNo === 'BG-9');
  assert.equal(c.service, 'bgv_employee');
  assert.deepEqual([c.details.employer1From, c.details.employer1To, c.details.employer2From, c.details.employer2To, c.details.passingYear], ['2022-01', '2024-02', '2018-07', '2021-08', '2018']);
});
