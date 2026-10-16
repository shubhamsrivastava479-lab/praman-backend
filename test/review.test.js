require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/services/ai-call-engine');
const { db } = require('../src/db');
const scheduler = require('../src/services/scheduler');
const { buildAiReport } = require('../src/services/ai-report');

const finished = () => ({ id: 'cr1', caseType: 'claim', claimNo: 'X1', status: 'in_progress', createdAt: '2026-10-01T00:00:00Z',
  aiCall: { status: 'in_progress', flags: [], checks: [], answers: [{}, {}, {}], photos: { blink: true }, facePhotoCaptured: true,
    docs: { aadhaar: { received: true }, pan: { received: true }, chats: null, other: [] } } });
const summary = { summary: 'All good.', sections: {}, concerns: [] };

test('a clean call waits for a person unless the firm turned review off', () => {
  const a = finished(); engine.applyFinish(a, summary);
  assert.equal(a.reviewState === 'awaiting_review' || a.spotCheckRequired, true);
  assert.notEqual(a.status, 'completed');
  const seen = new Set();
  for (let i = 0; i < 60; i++) { const b = finished(); engine.applyFinish(b, summary, { requireReview: false }); seen.add(b.status + '/' + b.reviewState); }
  assert.ok(seen.has('completed/not_required'));
});

test('a finished call with no recording is flagged after 15 minutes and is no longer "verified"', async () => {
  const c = finished(); c.aiCall.status = 'completed'; c.aiCall.decision = 'verified'; c.aiCall.completedAt = '2026-10-01T10:00:00Z'; c.status = 'completed';
  db.data.cases.push(c);
  assert.deepEqual(await scheduler.recordingTick({ now: new Date('2026-10-01T10:10:00Z') }), { flagged: 0 }); // too early
  assert.deepEqual(await scheduler.recordingTick({ now: new Date('2026-10-01T10:20:00Z') }), { flagged: 1 });
  assert.equal(c.aiCall.decision, 'partially_verified');
  assert.equal(c.status, 'in_progress');
  assert.deepEqual(await scheduler.recordingTick({ now: new Date('2026-10-01T11:00:00Z') }), { flagged: 0 }); // only once
});

test('report fingerprint is stable, and changes when the content changes', () => {
  const c = finished(); c.aiCall.status = 'completed'; c.aiCall.startedAt = '2026-10-01T09:00:00Z'; c.aiCall.completedAt = '2026-10-01T09:10:00Z';
  const r1 = buildAiReport(c, { evidence: [], custody: [] }), r2 = buildAiReport(c, { evidence: [], custody: [], publicView: true });
  assert.match(r1.meta.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(r1.meta.fingerprint, r2.meta.fingerprint);
  c.aiCall.flags.push('new flag');
  assert.notEqual(buildAiReport(c, { evidence: [], custody: [] }).meta.fingerprint, r1.meta.fingerprint);
  assert.equal(r1.recordingMissing, true);
  assert.match(r1.idSources.aadhaar, /photo only/);
});
