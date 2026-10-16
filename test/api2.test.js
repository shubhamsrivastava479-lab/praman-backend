require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, server } = require('../src/server');
const { db } = require('../src/db');
const { signToken } = require('../src/services/auth');

let base, T = {};
const call = async (method, path, tok, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json().catch(() => ({})) : Buffer.from(await r.arrayBuffer()) };
};
const aiCase = (id, extra = {}) => ({ id, vendorId: 'f1', caseType: 'claim', caseRef: 'PR-' + id, claimNo: 'C-' + id, insuredName: 'Ravi', status: 'in_progress', verificationMode: 'full_automation', createdAt: new Date().toISOString(),
  aiCall: { status: 'completed', decision: 'verified', startedAt: new Date(Date.now() - 600000).toISOString(), completedAt: new Date().toISOString(), flags: ['Address differs'], checks: [], answers: [], photos: {}, docs: { other: [] }, token: 't' + id }, ...extra });

test.before(async () => {
  await start(0); base = `http://127.0.0.1:${server.address().port}`;
  const d = db.data;
  const us = [
    { id: 'f1', email: 'a@f.test', vendorName: 'Firm', role: 'vendor_admin', approved: true, services: ['motor_claim'], followUp: { secondReviewAbove: 1000 } },
    { id: 'v1', email: 'v@f.test', vendorName: 'Firm', role: 'viewer', parentVendorId: 'f1' },
    { id: 'i1', email: 'i@f.test', vendorName: 'Firm', role: 'insurer', parentVendorId: 'f1' },
    { id: 'g1', email: 'g@f.test', vendorName: 'Firm', role: 'agent', parentVendorId: 'f1' }
  ];
  d.users.push(...us);
  d.cases.push(aiCase('done', { status: 'completed', reviewState: 'reviewed', completedAt: new Date().toISOString(), aiReview: { finalVerdict: 'verified', reviewerName: 'A', reviewedAt: new Date().toISOString() } }),
    aiCase('open', { reviewState: 'awaiting_review' }), aiCase('big', { reviewState: 'awaiting_review', policyValue: '5000' }));
  await db.write();
  for (const u of us) T[u.role] = signToken({ ...u, vendorRootId: 'f1' });
});
test.after(() => server.close());

test('insurer sees only finished cases; viewer cannot write', async () => {
  const l = await call('GET', '/api/cases', T.insurer);
  assert.deepEqual(l.body.map(c => c.id), ['done']);
  assert.equal((await call('GET', '/api/cases/open/ai-report', T.insurer)).status, 404);
  assert.equal((await call('GET', '/api/workflow/settings', T.insurer)).status, 403);
  assert.equal((await call('POST', '/api/cases/open/ai-review', T.viewer, { finalVerdict: 'verified' })).status, 403);
  assert.equal((await call('GET', '/api/cases', T.viewer)).body.length, 3);
});

test('server PDF works for the firm and the insurer', async () => {
  for (const role of ['vendor_admin', 'insurer']) {
    const r = await call('GET', '/api/cases/done/ai-report.pdf', T[role]);
    assert.equal(r.status, 200); assert.equal(r.body.slice(0, 5).toString(), '%PDF-');
  }
  assert.equal((await call('GET', '/api/cases/open/ai-report.pdf', T.insurer)).status, 404);
});

test('e-mail of the PDF says clearly when the mail server is not set up', async () => {
  const r = await call('POST', '/api/cases/done/email-report', T.vendor_admin, { to: 'x@y.com' });
  assert.equal(r.status, 503);
  assert.equal((await call('POST', '/api/cases/done/email-report', T.viewer, { to: 'x@y.com' })).status, 403);
});

test('a high-value case needs two different reviewers', async () => {
  const body = { finalVerdict: 'verified', remarks: 'ok', reviewerName: 'X' };
  const r1 = await call('POST', '/api/cases/big/ai-review', T.vendor_admin, body);
  assert.equal(r1.body.reviewState, 'awaiting_second_review');
  assert.equal(db.data.cases.find(c => c.id === 'big').status, 'in_progress');
  assert.equal((await call('POST', '/api/cases/big/ai-review', T.vendor_admin, body)).status, 409); // same person
  assert.equal(db.data.cases.find(c => c.id === 'big').reviewState, 'awaiting_second_review');
  const r2 = await call('POST', '/api/cases/big/ai-review', T.agent, body);
  assert.equal(r2.body.reviewState, 'reviewed');
  assert.equal(db.data.cases.find(c => c.id === 'big').status, 'completed');
  assert.ok(db.data.notifications.some(n => n.type === 'second_review'));
  const n = await call('GET', '/api/notifications', T.vendor_admin);
  assert.ok(n.body.unread >= 1);
  await call('POST', '/api/notifications/read', T.vendor_admin, {});
  assert.equal((await call('GET', '/api/notifications', T.vendor_admin)).body.unread, 0);
});

test('a normal case is completed by one sign-off', async () => {
  const r = await call('POST', '/api/cases/open/ai-review', T.vendor_admin, { finalVerdict: 'verified' });
  assert.equal(r.body.reviewState, 'reviewed');
});

test('insights are calculated for the firm', async () => {
  const r = await call('GET', '/api/analytics/insights?days=30', T.vendor_admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.totals.aiCases, 3);
  assert.equal(r.body.totals.completed, 3);
  assert.ok(r.body.topFlags.length >= 1);
  assert.ok(r.body.medianCallMinutes > 5);
});
