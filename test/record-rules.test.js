require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../src/db');
const ff = require('../src/services/file-facts');
const rules = require('../src/services/record-rules');
const { triggers, toDate } = require('../src/services/service-profiles');
const st = (list, label) => (list.find(x => x.label === label) || {}).state;

test('dates are read only in known formats, never guessed', () => {
  assert.equal(toDate('2026-10-02').toISOString().slice(0, 10), '2026-10-02');
  assert.equal(toDate('02/10/2026').toISOString().slice(0, 10), '2026-10-02');   // day/month/year
  assert.equal(toDate('Jan 2022').toISOString().slice(0, 10), '2022-01-01');
  assert.equal(toDate('31/02/2026'), null);                                     // no such day
  assert.equal(toDate('next monday'), null);
});

test('PIVC: premium and cover compared with income', () => {
  const t = triggers('pivc_life', { policyValue: 5000000, details: { premium: '5000', premiumFrequency: 'Monthly', annualIncome: '150000', dob: '1990-01-01' } });
  assert.equal(st(t, 'Premium compared with income'), 'check');        // 5,000 x 12 = 60,000 = 40% of income
  assert.equal(st(t, 'Cover compared with income'), 'check');          // 50 lakh = 33 times income
  const none = triggers('pivc_life', { details: { premium: '5000', annualIncome: '150000' } });
  assert.equal(st(none, 'Premium compared with income'), 'none');      // frequency not given: no guess
});

test('BGV: gap, overlap, wrong dates, age at passing', () => {
  const gap = triggers('bgv_employee', { details: { employer2From: '2019-01', employer2To: '2021-03', employer1From: '2021-11', employer1To: '2024-02', dob: '1996-04-09', passingYear: '2018' } });
  assert.equal(st(gap, 'Gap between jobs'), 'check');
  assert.equal(st(gap, 'Age at passing the qualification'), 'clear');
  const lap = triggers('bgv_employee', { details: { employer2From: '2019-01', employer2To: '2022-06', employer1From: '2021-11', employer1To: 'Mar 2021', dob: '2008-01-01', passingYear: '2018' } });
  assert.equal(st(lap, 'Two jobs at the same time'), 'check');
  assert.equal(st(lap, 'Dates of the latest job'), 'focus');
  assert.equal(st(lap, 'Age at passing the qualification'), 'check');
});

test('cross-case: same number other person, vehicle repeat, hospital, agent record', () => {
  const data = { cases: [
    { id: 'a', vendorId: 'F', service: 'motor_claim', caseRef: 'A', whatsappNumber: '911', insuredName: 'Raj', vehicleNo: 'MH 12 AB 1234', policyNo: 'P1', createdAt: '2026-10-01T00:00:00Z', details: { agentName: 'Mohit' } },
    { id: 'b', vendorId: 'F', service: 'motor_claim', caseRef: 'B', whatsappNumber: '911', insuredName: 'Sunil', vehicleNo: 'mh12ab1234', policyNo: 'P9', createdAt: '2026-06-01T00:00:00Z', details: { agentName: 'mohit' }, aiCall: { decision: 'found_discrepancy' } },
    { id: 'c', vendorId: 'OTHER', service: 'motor_claim', caseRef: 'C', whatsappNumber: '911', insuredName: 'X', vehicleNo: 'MH12AB1234', createdAt: '2026-09-01T00:00:00Z' }
  ] };
  const r = rules.crossCase(data.cases[0], data);
  assert.equal(st(r, 'Same WhatsApp number, different person'), 'focus');
  assert.equal(st(r, 'Other claims on this vehicle (12 months)'), 'check');   // only B: C is another firm
  assert.equal(st(r, 'Track record of this agent'), 'clear');                // 1 of 1 bad: below 2
});

test('exact duplicate file across cases of the same firm, and PDF facts', () => {
  db.data.cases.push({ id: 'd1', vendorId: 'F2', caseRef: 'D1', createdAt: '2026-10-01T00:00:00Z' }, { id: 'd2', vendorId: 'F2', caseRef: 'D2', createdAt: '2026-10-05T00:00:00Z' });
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Producer (Canva) /CreationDate (D:20260901100000) /ModDate (D:20261003120000)>>\n%%EOF\nmore\n%%EOF\n', 'latin1');
  ff.recordBuffer('/media/x1.pdf', pdf, 'application/pdf'); ff.recordBuffer('/media/x2.pdf', pdf, 'application/pdf');
  db.data.evidence.push({ id: 'e1', caseId: 'd1', vendorId: 'F2', fileUrl: '/media/x1.pdf', type: 'document', fileName: 'bill.pdf' },
    { id: 'e2', caseId: 'd2', vendorId: 'F2', fileUrl: '/media/x2.pdf', type: 'document', fileName: 'bill.pdf' });
  const r = rules.fileRules(db.data.cases.find(c => c.id === 'd2'), db.data, db.data.evidence.filter(e => e.caseId === 'd2'));
  assert.equal(st(r, 'Exact same file in another case'), 'focus');
  assert.equal(st(r, 'PDF made with an editing program'), 'check');
  assert.equal(st(r, 'PDF changed after it was made'), 'check');
  assert.equal(st(r, 'PDF saved more than once'), 'check');
});

test('photo EXIF is read exactly: software, date taken, GPS', () => {
  // minimal JPEG with an EXIF block: Software=Snapseed, DateTimeOriginal, GPS 28.5N 77.25E
  const le = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }, le4 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const ent = (tag, type, count, val) => Buffer.concat([le(tag), le(type), le4(count), Buffer.isBuffer(val) ? val : le4(val)]);
  // layout: header(8) IFD0 at 8: 3 entries -> 2+36+4=42 -> ends 50; exif IFD at 50: 1 entry -> 18 -> ends 68; gps IFD at 68: 4 entries -> 54 -> ends 122; data after
  const sw = Buffer.from('Snapseed\0'), dt = Buffer.from('2026:09:01 10:00:00\0');
  const rat = (a, b) => Buffer.concat([le4(a), le4(b)]);
  const latv = Buffer.concat([rat(28, 1), rat(30, 1), rat(0, 1)]), lngv = Buffer.concat([rat(77, 1), rat(15, 1), rat(0, 1)]);
  const D = 122, swAt = D, dtAt = swAt + sw.length, latAt = dtAt + dt.length, lngAt = latAt + 24;
  const ifd0 = Buffer.concat([le(3), ent(0x0131, 2, sw.length, swAt), ent(0x8769, 4, 1, 50), ent(0x8825, 4, 1, 68), le4(0)]);
  const exif = Buffer.concat([le(1), ent(0x9003, 2, dt.length, dtAt), le4(0)]);
  const gps = Buffer.concat([le(4), ent(1, 2, 2, Buffer.from('N\0\0\0')), ent(2, 5, 3, latAt), ent(3, 2, 2, Buffer.from('E\0\0\0')), ent(4, 5, 3, lngAt), le4(0)]);
  const tiff = Buffer.concat([Buffer.from('II'), le(42), le4(8), ifd0, exif, gps, sw, dt, latv, lngv]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([((tiff.length + 8) >> 8) & 255, (tiff.length + 8) & 255]), Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xda, 0, 2])]);
  const f = ff.analyze(jpg, 'image/jpeg');
  assert.equal(f.exif.software, 'Snapseed');
  assert.equal(f.exif.taken, '2026-09-01T10:00:00');
  assert.deepEqual(f.exif.gps, { lat: 28.5, lng: 77.25 });
});

test('fraud dashboard counts cases by worst rule result and by hospital', () => {
  const stats = require('../src/services/fraud-stats');
  const now = new Date('2026-10-24T00:00:00Z');
  const data = { evidence: [], cases: [
    { id: 'h1', vendorId: 'Z', service: 'health_claim', createdAt: '2026-10-10T00:00:00Z', details: { hospitalName: 'City Care', policyStartDate: '2026-10-01', admissionDate: '2026-10-05', dischargeDate: '2026-10-07' }, aiCall: { decision: 'found_discrepancy' } },
    { id: 'h2', vendorId: 'Z', service: 'health_claim', createdAt: '2026-10-12T00:00:00Z', details: { hospitalName: 'citycare', policyStartDate: '2024-01-01', admissionDate: '2026-10-08', dischargeDate: '2026-10-10' }, dueAt: '2026-10-13T00:00:00Z' },
    { id: 'x', vendorId: 'OTHER', service: 'health_claim', createdAt: '2026-10-12T00:00:00Z' }
  ] };
  const s = stats.build(data, 'Z', { days: 90, now });
  assert.equal(s.totals.cases, 2);
  assert.equal(s.totals.focus, 1);                 // h1: inside the 30-day waiting period
  assert.equal(s.totals.overdue, 1);               // h2 open and past its deadline
  assert.equal(s.hospitals[0].cases, 2);           // "City Care" and "citycare" are the same name
  assert.equal(s.hospitals[0].discrepancy, 1);
});

test('insurer details are asked without saying them, and compared exactly', () => {
  const engine = require('../src/services/ai-call-engine');
  const { compareValue } = require('../src/services/service-profiles');
  const c = { service: 'health_claim', caseType: 'claim_investigation', claimNo: 'H1', insuredName: 'A',
    details: { hospitalName: 'City Care Hospital', admissionDate: '2026-10-02', dischargeDate: '2026-10-06', claimAmount: '185000', city: 'Lucknow' } };
  const q = engine.buildQueue(c);
  const hosp = q.find(s => s.id === 'q_hospital');
  assert.deepEqual(hosp.match.map(m => m.field), ['hospitalName']);
  assert.deepEqual(q.find(s => s.id === 'q_admit_dates').match.map(m => m.field), ['admissionDate', 'dischargeDate']);
  const amt = q.find(s => s.id === 'q_m_claim_amount');
  assert.ok(amt && !/185000|1,85,000/.test(amt.text));                    // the value is never read out
  assert.ok(q.some(s => s.id === 'q_m_city'));
  assert.ok(!q.some(s => s.id === 'confirm_hospitalName'));                 // no yes/no confirm that gives it away
  const spec = f => ({ ...amt.match[0], ...f });
  assert.equal(compareValue(spec({}), '185000').result, 'match');
  assert.equal(compareValue(spec({}), '170000').result, 'partial');        // 8% different
  assert.equal(compareValue(spec({}), '90000').result, 'mismatch');
  assert.equal(compareValue(spec({}), '').result, 'unknown');
  const d = { label: 'Admission date', type: 'date', expected: '2026-10-02' };
  assert.equal(compareValue(d, '2026-10-02').result, 'match');
  assert.equal(compareValue(d, '2026-10-09').result, 'mismatch');
  const t = { label: 'Hospital name', type: 'text', expected: 'City Care Hospital' };
  assert.equal(compareValue(t, 'city care').result, 'match');
  assert.equal(compareValue(t, 'Sunrise Nursing Home', false).result, 'mismatch');
  assert.equal(compareValue(t, 'CCH Lucknow', true).result, 'partial');   // AI says same: only partial
});

test('a mismatch from the call becomes a check and a flag', async () => {
  const engine = require('../src/services/ai-call-engine');
  const c = { id: 'm1', service: 'health_claim', caseType: 'claim_investigation', claimNo: 'H2', insuredName: 'A', details: { claimAmount: '185000' } };
  c.aiCall = { status: 'in_progress', queue: engine.buildQueue(c), answers: [], checks: [], flags: [], captured: {}, docs: { aadhaar: {}, pan: {} } };
  c.aiCall.i = c.aiCall.queue.findIndex(s => s.id === 'q_m_claim_amount');
  db.data.cases.push(c);
  engine.apply(c, { english: 'About ninety thousand rupees' }, { judge: { intent: 'answered', value: '90000', clear: true }, values: { claimAmount: { said: '90000' } } });
  const k = c.aiCall.checks.find(x => x.id === 'rec_claimAmount');
  assert.equal(k.result, 'mismatch'); assert.equal(k.said, '90000'); assert.equal(k.expected, '185000');
  assert.ok(c.aiCall.flags.some(f => /Claim amount does not match/.test(f)));
});

test('customer message: name, reason by service, call link, app link with the reason', () => {
  const m = require('../src/services/customer-message');
  const firm = { vendorName: 'Praman Services', followUp: {} };
  const c = { service: 'health_claim', caseType: 'claim_investigation', claimNo: 'HC/26/1', insuredName: 'Ravi Kumar', details: { insurerName: 'Example General' } };
  const t = m.text(c, { firm, joinUrl: 'https://x/live-join.html?t=abc', appUrl: 'https://x/downloads/praman-call.apk', kind: 'live' });
  assert.match(t, /नमस्ते Ravi Kumar जी/); assert.match(t, /Hello Ravi Kumar/);
  assert.match(t, /हेल्थ इंश्योरेंस क्लेम की जाँच/); assert.match(t, /checking your health insurance claim \(claim no\. HC\/26\/1\)/);
  assert.match(t, /Example General/);
  assert.match(t, /live-join\.html\?t=abc/); assert.match(t, /praman-call\.apk/); assert.match(t, /Why the app/);
  const ai = m.text({ ...c, service: 'bgv_employee' }, { firm, joinUrl: 'https://x/ai-call.html?t=1', appUrl: 'https://x/a.apk', kind: 'ai' });
  assert.doesNotMatch(ai, /a\.apk/);                                     // AI call: no app needed
  assert.match(ai, /background verification/);
  // templates: 1-variable by default, 3 variables when the firm set one; variables are one line
  assert.deepEqual(m.template(c, { firm, link: 'L', fallbackName: 'old_tpl' }), { name: 'old_tpl', params: ['L'] });
  const t3 = m.template(c, { firm: { ...firm, followUp: { linkTemplate: 'praman_verification_link' } }, link: 'L', appUrl: 'A' });
  assert.equal(t3.name, 'praman_verification_link'); assert.equal(t3.params[0], 'Ravi Kumar');
  assert.ok(t3.params.every(p => !/\n/.test(p))); assert.match(t3.params[2], /L .*A/);
});
