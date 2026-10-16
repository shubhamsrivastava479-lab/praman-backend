require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/services/ai-call-engine');
const { buildChecklist, summarize } = require('../src/services/checklist');
const { buildAiReport } = require('../src/services/ai-report');

const mk = type => {
  const c = { id: 'k1', caseType: type, policyType: 'life', claimNo: 'P-1', insuredName: 'Ravi Kumar', district: 'Pune', vehicleNo: type === 'claim' ? 'MH12AB1234' : '', createdAt: '2026-10-01T00:00:00Z', aiCall: {} };
  engine.startSession(c, { language: 'English' });
  return c;
};
const byId = (items, id) => items.find(x => x.id === id);

test('the checklist follows the case type', () => {
  const life = buildChecklist(mk('policy_verification')), claim = buildChecklist(mk('claim'));
  assert.ok(byId(life, 'body_stand') && byId(life, 'q_illness'));        // policy: body photos + health questions
  assert.ok(!byId(claim, 'body_stand') && byId(claim, 'q_fir') && byId(claim, 'chats'));  // claim: FIR + WhatsApp history
  assert.ok(life.every(x => x.status === 'pending' || x.status === 'in_progress'));
});

test('each item is marked as the call goes on', () => {
  const c = mk('claim'), a = c.aiCall;
  a.i = 3;
  a.answers.push({ key: 'spokenName', intent: undefined, value: 'Ravi Kumar', english: 'Ravi Kumar' });
  a.answers.push({ key: 'insuredName', intent: 'confirmed' });
  a.answers.push({ key: 'claimNo', intent: 'denied', value: 'X' });
  let l = buildChecklist(c);
  assert.equal(byId(l, 'name').status, 'done');
  assert.equal(byId(l, 'confirm_insuredName').status, 'done');
  assert.equal(byId(l, 'confirm_claimNo').status, 'partial');
  assert.equal(byId(l, 'confirm_vehicleNo').status, 'in_progress');        // the AI is on it now (index 3)
  assert.equal(byId(l, 'face').status, 'pending');
  a.i = 6;                                                                    // passed the vehicle confirm without an answer, and the district one
  l = buildChecklist(c);
  assert.equal(byId(l, 'confirm_vehicleNo').status, 'not_done');
  a.photos = { face: true, blink: false }; a.i = 8;
  a.docs.aadhaar.front = true; a.docs.pan.received = true; a.docs.pan.masked = '••••••234F';
  l = buildChecklist(c);
  assert.equal(byId(l, 'face').status, 'done');
  assert.equal(byId(l, 'blink').status, 'not_done');
  assert.equal(byId(l, 'aadhaar').status, 'partial');
  assert.equal(byId(l, 'pan').status, 'done');
  const s = summarize(l); assert.equal(s.total, l.length); assert.ok(s.done >= 3 && s.notDone >= 2);
});

test('the report carries the checklist', () => {
  const c = mk('claim'); c.aiCall.status = 'completed';
  const r = buildAiReport(c, { evidence: [], custody: [] });
  assert.equal(r.checklist.total, r.checklist.items.length);
  assert.ok(r.checklist.items.some(x => x.label.includes('FIR')));
  assert.ok(r.checklist.notDone > 0);   // finished call, nothing answered: shown as not done, never silently hidden
});
