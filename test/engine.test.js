require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/services/ai-call-engine');
const plans = require('../src/services/plans');
const { normRef } = require('../src/services/ids');
const { maskId, redactIdsInText } = require('../src/services/security');

test('names are compared the way Indian names are written', () => {
  assert.equal(engine.nameMatch('Rajesh Kumar Sharma', 'rajesh sharma'), 'partial');
  assert.equal(engine.nameMatch('Mr. Rajesh Kumar', 'RAJESH KUMAR'), 'match');
  assert.equal(engine.nameMatch('Rajesh K Sharma', 'Rajesh Kumar Sharma'), 'match');
  assert.equal(engine.nameMatch('Sunita Devi', 'Anil Verma'), 'mismatch');
  assert.equal(engine.nameMatch('', 'Anil'), 'unknown');
});

test('dates of birth: same day, or at least the same year', () => {
  assert.equal(engine.dobMatch('12/03/1985', '12-03-1985'), 'match');
  assert.equal(engine.dobMatch('12/03/1985', '13/03/1985'), 'mismatch');
  assert.equal(engine.dobMatch('1985', '12/03/1985'), 'match');
  assert.equal(engine.dobMatch('12/03/1985', '12/03/1986'), 'mismatch');
  assert.equal(engine.dobMatch('', '12/03/1985'), 'unknown');
});

test('when the AI is down, yes / no and names are still understood', () => {
  const confirm = { type: 'confirm' };
  assert.equal(engine.roughJudge(confirm, 'haan ji bilkul').intent, 'yes');
  assert.equal(engine.roughJudge(confirm, 'nahi, galat hai').intent, 'no');
  assert.equal(engine.roughJudge(confirm, 'hmm').intent, 'unclear');
  assert.equal(engine.roughJudge({ type: 'ask', kind: 'name' }, 'my name is Rajesh Kumar').value, 'Rajesh Kumar');
  assert.equal(engine.roughJudge({ type: 'ask', kind: 'name' }, 'mera naam Anil Verma hai').value, 'Anil Verma');
  assert.equal(engine.roughJudge({ type: 'ask', kind: 'name' }, '').clear, false);
});

test('services: what a firm may use, and how a case is classified', () => {
  const data = { users: [{ id: 'f1', role: 'vendor_admin', services: ['pivc_life'] }, { id: 'f2', role: 'vendor_admin' }, { id: 'a1', role: 'agent', parentVendorId: 'f1' }], cases: [] };
  assert.deepEqual(plans.allowedServices(data, { id: 'f1', role: 'vendor_admin', vendorRootId: 'f1' }), ['pivc_life']);
  assert.deepEqual(plans.allowedServices(data, { id: 'a1', role: 'agent', vendorRootId: 'f1' }), ['pivc_life']);
  assert.equal(plans.allowedServices(data, { id: 'f2', role: 'vendor_admin', vendorRootId: 'f2' }).length, plans.ALL.length); // older account: everything
  assert.equal(plans.serviceFor({ caseType: 'policy_verification', policyType: 'term' }), 'pivc_term');
  assert.equal(plans.serviceFor({ caseType: 'policy_verification', policyType: 'life' }), 'pivc_life');
  assert.equal(plans.serviceFor({ caseType: 'claim_investigation' }), 'motor_claim');
  assert.equal(plans.serviceFor({ service: 'nope', caseType: 'claim_investigation' }), 'motor_claim');
});

test('monthly usage is counted per service in India time', () => {
  const data = { cases: [
    { vendorId: 'f1', service: 'pivc_life', createdAt: '2026-09-30T20:00:00Z' }, // 1 Oct 01:30 IST
    { vendorId: 'f1', service: 'pivc_life', createdAt: '2026-10-05T10:00:00Z' },
    { vendorId: 'f1', service: 'motor_claim', createdAt: '2026-10-06T10:00:00Z' },
    { vendorId: 'f2', service: 'pivc_life', createdAt: '2026-10-06T10:00:00Z' }
  ] };
  assert.deepEqual(plans.usage(data, 'f1', '2026-10'), { pivc_life: 2, motor_claim: 1 });
  assert.deepEqual(plans.usage(data, 'f1', '2026-09'), {});
});

test('case numbers are compared without spaces, dashes or case', () => {
  assert.equal(normRef(' prm26-000123 '), 'PRM26000123');
  assert.equal(normRef('ab/12 34'), 'AB1234');
});

test('Aadhaar and PAN numbers never stay in full', () => {
  assert.equal(maskId('123412341234'), '••••••••1234');
  assert.equal(maskId('AB'), '••••');
  const t = redactIdsInText('Aadhaar 1234 5678 9012 and PAN ABCDE1234F found');
  assert.ok(!/5678/.test(t) && !/ABCDE/.test(t));
  assert.ok(t.includes('9012') && t.includes('234F'));
});

test('a call whose AI summary failed can never end as plain "verified"', () => {
  const mk = () => ({ id: 'c1', caseType: 'claim', claimNo: 'X', aiCall: { status: 'in_progress', flags: [], checks: [], answers: [{}, {}, {}], photos: { blink: true }, facePhotoCaptured: true,
    docs: { aadhaar: { received: true }, pan: { received: true }, chats: null, other: [] } } });
  const c = mk(); engine.applyFinish(c, { summary: '', sections: {}, concerns: [] });
  assert.notEqual(c.aiCall.decision, 'verified');
  assert.ok(c.aiCall.flags.some(f => /summary could not be written/.test(f)));
  assert.notEqual(c.status, 'completed');
});
