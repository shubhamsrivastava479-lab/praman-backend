require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../src/services/call-signals');
const engine = require('../src/services/ai-call-engine');

test('amounts are read from the way people say them', () => {
  assert.equal(s.parseAmount('5 lakh'), 500000);
  assert.equal(s.parseAmount('about 5,00,000 rupees'), 500000);
  assert.equal(s.parseAmount('1.2 crore'), 12000000);
  assert.equal(s.parseAmount('50k'), 50000);
  assert.equal(s.parseAmount('₹ 7.5 lakhs per year'), 750000);
  assert.equal(s.parseAmount('no idea'), null);
});

test('stated address is compared with the Aadhaar address', () => {
  assert.ok(s.addressOverlap('flat 12 shivaji nagar pune maharashtra', 'S/O Ram, Flat 12, Shivaji Nagar, Pune, Maharashtra 411005') >= 0.5);
  assert.ok(s.addressOverlap('plot 7 sector 21 noida uttar pradesh', 'House 5, Kothrud, Pune, Maharashtra 411038') < 0.3);
  assert.equal(s.addressOverlap('pune', 'Pune'), null); // too short to judge
});

const mk = (id, extra = {}) => ({ id, vendorId: 'f1', caseRef: 'PR-' + id, caseType: 'policy_verification', policyType: 'term', claimNo: id, whatsappNumber: '9198' + id, insuredName: 'N' + id, policyValue: 20000000,
  aiCall: { status: 'completed', flags: [], checks: [], answers: [], photos: {}, docs: { aadhaar: { last4: '1234', dob: '12/05/1990' }, pan: {} }, ...extra } });

test('answers that look like mis-selling, and cover that does not fit the income, are raised', () => {
  const c = mk('1'); const a = c.aiCall;
  a.answers = [{ key: 'applied_self', english: 'No, my agent filled it' }, { key: 'promises', english: 'Yes, he said guaranteed returns' }, { key: 'income', english: 'about 4 lakh a year' }, { key: 'sum_assured', english: '1 crore' }, { key: 'address', english: 'flat 12 shivaji nagar pune' }];
  a.docs.aadhaar.address = 'Flat 12, Shivaji Nagar, Pune 411005';
  const flags = [], checks = {};
  s.answerChecks(c, (id, l, r, d) => { checks[id] = [r, d]; }, f => flags.push(f));
  assert.ok(flags.some(f => /did not apply/.test(f)) && flags.some(f => /guaranteed returns/.test(f)));
  assert.equal(checks.income_vs_cover[0], 'partial');
  assert.equal(checks.cover_spoken_record[0], 'partial');
  assert.equal(checks.address_spoken_aadhaar[0], 'match');
});

test('the same Aadhaar details or phone on another case of the SAME firm are noticed; other firms are never compared', () => {
  const a = mk('1'), b = mk('2'), other = { ...mk('3'), vendorId: 'f2' };
  a.aiCall.deviceSig = b.aiCall.deviceSig = 'dev1';
  const hits = s.crossCase(a, [b, other]);
  assert.ok(hits.some(h => h.type === 'aadhaar' && h.ref === 'PR-2'));
  assert.ok(hits.some(h => h.type === 'device'));
  assert.ok(!hits.some(h => h.ref === 'PR-3'));
});

test('poor audio is detected and finishing the call recommends a live call', () => {
  assert.equal(s.audioQuality({ noisy: 1, sttErrors: 0, answers: [] }).poor, false);
  assert.equal(s.audioQuality({ noisy: 5, sttErrors: 0, answers: [] }).poor, true);
  const c = mk('9'); c.caseType = 'claim_investigation'; c.aiCall.status = 'in_progress'; c.aiCall.noisy = 6; c.aiCall.queue = [{ id: 'closing', type: 'close' }]; c.aiCall.i = 0;
  engine.applyFinish(c, { summary: 'x', sections: {}, concerns: [] }, { otherCases: [] });
  assert.equal(c.needsExecutive, true);
  assert.ok(c.aiCall.flags.some(f => /Poor audio/.test(f)));
  assert.ok(c.aiCall.liveCallReasons.length >= 1);
});
