require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAiReport } = require('../src/services/ai-report');
const pdf = require('../src/services/report-pdf');
const roles = require('../src/services/roles');

const mk = () => ({ id: 'p1', caseType: 'claim', caseRef: 'PR-1', claimNo: 'X-1', insuredName: 'Ravi Kumar', status: 'completed', reviewState: 'reviewed', createdAt: '2026-10-01T00:00:00Z',
  aiReview: { finalVerdict: 'verified', reviewerName: 'Asha', remarks: 'All matches. ₹5,00,000 cover — हिंदी', reviewedAt: '2026-10-02T00:00:00Z' },
  aiCall: { status: 'completed', language: 'Hindi', startedAt: '2026-10-01T09:00:00Z', completedAt: '2026-10-01T09:10:00Z', decision: 'verified', summary: 'Customer confirmed the details.', flags: ['Address differs'], checks: [{ id: 'x', label: 'Face match', result: 'pass' }],
    answers: [{ key: 'name', section: 'identity', question: 'Your name?', value: 'Ravi', english: 'Ravi', original: 'रवि' }], photos: { blink: true }, docs: { aadhaar: { received: true, masked: '••••1234', name: 'Ravi Kumar' }, pan: { received: true }, other: [] } } });

test('server PDF is made, is a real PDF and survives Hindi text and a bad logo', async () => {
  const R = buildAiReport(mk(), { evidence: [], custody: [{ timestamp: '2026-10-01T09:00:00Z', event: 'Call started', actor: 'system' }], firm: 'Demo Firm' });
  const buf = await pdf.render(R, { logoDataUrl: 'data:image/png;base64,AAAA' });
  assert.equal(buf.slice(0, 5).toString(), '%PDF-');
  assert.ok(buf.length > 2000);
  assert.equal(pdf.clean('₹5 — हिंदी “ok”'), 'Rs.5 - "ok"');
});

test('viewer can only read; insurer can only see finished reports', () => {
  const call = (role, method, url) => { let allowed = false; let code = null; const res = { status(n) { code = n; return this; }, json() { return this; } }; const tok = require('../src/services/auth').signToken({ id: 'u', role, vendorRootId: 'f' }); roles.guard({ get: () => 'Bearer ' + tok, method, originalUrl: url }, res, () => { allowed = true; }); return allowed ? 'ok' : code; };
  assert.equal(call('viewer', 'GET', '/api/cases'), 'ok');
  assert.equal(call('viewer', 'POST', '/api/cases'), 403);
  assert.equal(call('insurer', 'GET', '/api/cases'), 'ok');
  assert.equal(call('insurer', 'GET', '/api/cases/abc/ai-report'), 'ok');
  assert.equal(call('insurer', 'GET', '/api/cases/abc/ai-report.pdf'), 'ok');
  assert.equal(call('insurer', 'GET', '/api/workflow/settings'), 403);
  assert.equal(call('insurer', 'POST', '/api/cases/abc/ai-review'), 403);
  assert.equal(call('agent', 'POST', '/api/cases'), 'ok');
  assert.equal(roles.insurerCan({ status: 'completed', reviewState: 'reviewed' }), true);
  assert.equal(roles.insurerCan({ status: 'completed', reviewState: 'awaiting_review' }), false);
  assert.equal(roles.insurerCan({ status: 'in_progress' }), false);
});
