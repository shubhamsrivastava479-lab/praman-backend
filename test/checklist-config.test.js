require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/services/ai-call-engine');
const cc = require('../src/services/checklist-config');

const firm = cfg => ({ checklistConfig: { motor_claim: cfg } });
const base = { caseType: 'claim_investigation', claimNo: 'C1', insuredName: 'A', vehicleNo: 'MH12AB1234', district: 'Pune', createdAt: '2026-10-01T00:00:00Z' };
const start = f => { const c = { id: 'x', ...base, aiCall: {} }; engine.startSession(c, { language: 'English', config: cc.forCase(f, c) }); return c; };
const ids = c => c.aiCall.queue.map(s => s.id);

test('a firm can leave out standard questions and add its own, but never the identity steps', () => {
  const c = start(firm({ skip: ['q_witness', 'q_repair', 'face', 'aadhaar', 'confirm_district'], extra: [{ key: 'garage', text: 'Which garage will repair the vehicle?' }] }));
  assert.ok(!ids(c).includes('q_witness') && !ids(c).includes('q_repair'));
  assert.ok(ids(c).includes('face') && ids(c).includes('aadhaar') && ids(c).includes('confirm_district')); // core steps stay
  assert.ok(ids(c).includes('q_garage'));
  assert.ok(ids(c).indexOf('q_garage') < ids(c).indexOf('chats_consent'));
});

test('skipping the WhatsApp consent also drops its screenshot step', () => {
  const c = start(firm({ skip: ['chats_consent'] }));
  assert.ok(!ids(c).includes('chats_consent') && !ids(c).includes('chats'));
});

test('a mandatory item that is not done stops the call from ending as verified and asks for a live call', () => {
  const c = start(firm({ extra: [{ key: 'garage', text: 'Which garage?' }], mandatory: ['q_garage', 'q_fir'] }));
  const a = c.aiCall;
  a.photos = { face: true, blink: true }; a.facePhotoCaptured = true; a.docs.aadhaar.received = a.docs.aadhaar.front = a.docs.aadhaar.back = true; a.docs.pan.received = true; a.docs.pan.masked = 'x';
  a.answers = [{}, {}, {}]; a.i = a.queue.length - 1;
  engine.applyFinish(c, { summary: 'ok', sections: {}, concerns: [] }, { requireReview: true });
  assert.notEqual(a.decision, 'verified');
  assert.ok(a.flags.some(f => /Mandatory item not completed: Which garage/.test(f)));
  assert.equal(c.needsExecutive, true);
});

test('the editor lists the standard steps and what the firm chose', () => {
  const cat = cc.catalog('motor_claim', firm({ skip: ['q_witness'], mandatory: ['q_fir'], extra: [{ key: 'g', text: 'Garage?' }] }));
  const w = cat.items.find(i => i.id === 'q_witness'), f = cat.items.find(i => i.id === 'q_fir');
  assert.equal(w.asked, false); assert.equal(f.mandatory, true);
  assert.equal(cat.items.find(i => i.id === 'face').core, true);
  assert.equal(cat.extra[0].id, 'q_g');
});
