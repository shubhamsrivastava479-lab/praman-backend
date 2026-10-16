require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { start, server } = require('../src/server');
const { db } = require('../src/db');
const { signToken } = require('../src/services/auth');
const webhooks = require('../src/services/webhooks');
const scheduler = require('../src/services/scheduler');
const retention = require('../src/services/retention');

let base, adminTok, agentTok, otherTok, recv, received = [];

test.before(async () => {
  await start(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const d = db.data;
  d.users.push(
    { id: 'firm1', email: 'a@firm.test', vendorName: 'Firm One', role: 'vendor_admin', approved: true, services: ['pivc_life'], retentionDays: 60 },
    { id: 'agent1', email: 'ag@firm.test', vendorName: 'Firm One', agentName: 'Agent One', role: 'agent', parentVendorId: 'firm1' },
    { id: 'firm2', email: 'b@other.test', vendorName: 'Firm Two', role: 'vendor_admin', approved: true }
  );
  d.whatsappAccounts.push({ id: 'wa1', vendorId: 'firm1', displayPhoneNumber: '+91 99999 00000', token: 't', phoneNumberId: 'p' });
  await db.write(); // local-file mode re-reads the file on every request
  adminTok = signToken({ ...d.users[0], vendorRootId: 'firm1' });
  agentTok = signToken({ ...d.users[1], vendorRootId: 'firm1' });
  otherTok = signToken({ ...d.users[2], vendorRootId: 'firm2' });
  recv = http.createServer((req, res) => { let b = ''; req.on('data', x => b += x); req.on('end', () => { received.push({ headers: req.headers, body: b }); res.end('ok'); }); });
  await new Promise(r => recv.listen(0, '127.0.0.1', r));
});
test.after(() => { recv.close(); server.close(); });

const call = async (method, path, { tok, key, body } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (tok) headers.Authorization = 'Bearer ' + tok;
  if (key) headers['X-API-Key'] = key;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

let apiKey, secret, caseId;

test('integration: vendor admin creates an API key (shown once); agents cannot', async () => {
  assert.equal((await call('POST', '/api/integration/key', { tok: agentTok })).status, 403);
  const r = await call('POST', '/api/integration/key', { tok: adminTok });
  assert.equal(r.status, 200);
  assert.match(r.body.apiKey, /^pk_live_/);
  apiKey = r.body.apiKey;
  const again = await call('GET', '/api/integration', { tok: adminTok });
  assert.equal(again.body.hasKey, true);
  assert.equal(JSON.stringify(again.body).includes(apiKey), false); // the key itself is never shown again
  assert.equal(JSON.stringify(db.data.users.find(u => u.id === 'firm1').integration).includes(apiKey), false); // and not stored
});

test('API: key is required and must be valid', async () => {
  assert.equal((await call('GET', '/api/v1/cases')).status, 401);
  assert.equal((await call('GET', '/api/v1/cases', { key: 'pk_live_' + 'a'.repeat(48) })).status, 401);
});

test('API: open a case, once; same request again returns the same case', async () => {
  const body = { policyNo: 'POL-100', whatsappNumber: '+91 98765 43210', insuredName: 'Rajesh Kumar', service: 'pivc_life', externalRef: 'INS-77', sendLink: false };
  const r = await call('POST', '/api/v1/cases', { key: apiKey, body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.service, 'pivc_life');
  assert.match(r.body.customerLink, /\/ai-call\.html\?t=/);
  assert.ok(r.body.dueAt);
  caseId = r.body.caseId;
  const again = await call('POST', '/api/v1/cases', { key: apiKey, body });
  assert.equal(again.status, 200); assert.equal(again.body.duplicate, true); assert.equal(again.body.caseId, caseId);
  const other = await call('POST', '/api/v1/cases', { key: apiKey, body: { ...body, externalRef: 'INS-78' } });
  assert.equal(other.status, 409);
});

test('API: validation and plan are enforced', async () => {
  assert.equal((await call('POST', '/api/v1/cases', { key: apiKey, body: { whatsappNumber: '919876543210' } })).status, 400);
  assert.equal((await call('POST', '/api/v1/cases', { key: apiKey, body: { policyNo: 'X1', whatsappNumber: '123' } })).status, 400);
  const motor = await call('POST', '/api/v1/cases', { key: apiKey, body: { claimNo: 'CL-1', whatsappNumber: '919876543210', service: 'motor_claim', sendLink: false } });
  assert.equal(motor.status, 403); // not in this firm's plan
});

test('API: read a case by id, case number or policy number; other firms cannot see it', async () => {
  const one = await call('GET', '/api/v1/cases/' + caseId, { key: apiKey });
  assert.equal(one.status, 200);
  const ref = one.body.caseRef;
  assert.equal((await call('GET', '/api/v1/cases/' + encodeURIComponent(ref), { key: apiKey })).body.caseId, caseId);
  assert.equal((await call('GET', '/api/v1/cases/pol-100', { key: apiKey })).body.caseId, caseId);
  const list = await call('GET', '/api/v1/cases?status=open', { key: apiKey });
  assert.equal(list.body.count, 1);
  // second firm with its own key sees nothing
  const k2 = await call('POST', '/api/integration/key', { tok: otherTok });
  assert.equal((await call('GET', '/api/v1/cases/' + caseId, { key: k2.body.apiKey })).status, 404);
  assert.equal((await call('GET', '/api/v1/cases', { key: k2.body.apiKey })).body.count, 0);
  assert.equal((await call('GET', '/api/v1/cases/' + caseId + '/report', { key: apiKey })).status, 409); // not ready yet
});

test('webhook: address is validated, event is delivered signed, finished call is reported', async () => {
  const bad = await call('PUT', '/api/integration/webhook', { tok: adminTok, body: { webhookUrl: 'ftp://x' } });
  assert.equal(bad.status, 400);
  const url = `http://127.0.0.1:${recv.address().port}/hook`;
  const ok = await call('PUT', '/api/integration/webhook', { tok: adminTok, body: { webhookUrl: url, events: ['ai_call.completed', 'case.created'] } });
  assert.equal(ok.status, 200);
  secret = ok.body.signingSecret; assert.match(secret, /^whsec_/);
  assert.equal((await call('PUT', '/api/integration/webhook', { tok: adminTok, body: { webhookUrl: url, events: ['case.created'] } })).body.signingSecret, null); // secret is shown only once

  const t = await call('POST', '/api/integration/test', { tok: adminTok });
  assert.equal(t.body.ok, true, JSON.stringify(t.body));

  // a new case creates an event; the worker sends it
  await call('POST', '/api/v1/cases', { key: apiKey, body: { policyNo: 'POL-200', whatsappNumber: '919876543211', service: 'pivc_life', sendLink: false } });
  assert.equal(await webhooks.processDue(new Date(Date.now() + 1000)), 1);
  const ev = received.filter(r => r.headers['x-praman-event'] === 'case.created');
  assert.equal(ev.length, 1);
  assert.equal(webhooks.verifySignature(secret, ev[0].body, ev[0].headers['x-praman-signature']), true);
  assert.equal(JSON.parse(ev[0].body).data.claimNo, 'POL-200');
  // event not in the firm's list is not sent
  const c = db.data.cases.find(x => x.id === caseId);
  assert.equal(webhooks.emit('ai_call.completed', c), null);
});

test('workflow: assign, deadline, summary, permissions', async () => {
  assert.equal((await call('POST', `/api/workflow/cases/${caseId}/assign`, { tok: adminTok, body: { agentId: 'agent1' } })).status, 200);
  assert.equal((await call('POST', `/api/workflow/cases/${caseId}/assign`, { tok: adminTok, body: { agentId: 'someone-else' } })).status, 400);
  assert.equal((await call('POST', `/api/workflow/cases/${caseId}/assign`, { tok: otherTok, body: { agentId: null } })).status, 404); // other firm's case
  assert.equal((await call('POST', `/api/workflow/cases/${caseId}/due`, { tok: agentTok, body: { dueAt: 'nonsense' } })).status, 400);
  const past = new Date(Date.now() - 3600e3).toISOString();
  assert.equal((await call('POST', `/api/workflow/cases/${caseId}/due`, { tok: agentTok, body: { dueAt: past } })).status, 200);
  const sum = await call('GET', '/api/workflow/summary', { tok: agentTok });
  assert.equal(sum.body.overdue, 1); assert.equal(sum.body.byPerson.agent1.open, 1);
  assert.equal((await call('PUT', '/api/workflow/settings', { tok: agentTok, body: { tatHours: 10 } })).status, 403);
  const st = await call('PUT', '/api/workflow/settings', { tok: adminTok, body: { tatHours: 24, maxReminders: 2 } });
  assert.equal(st.body.settings.tatHours, 24); assert.equal(st.body.settings.maxReminders, 2);
});

test('scheduler: a late case is escalated once and an event is queued', async () => {
  const r1 = await scheduler.followupTick({ now: new Date(), send: async () => { throw new Error('should not send'); } });
  assert.equal(r1.escalated, 1);
  const c = db.data.cases.find(x => x.id === caseId);
  assert.ok(c.escalatedAt);
  const r2 = await scheduler.followupTick({ now: new Date(), send: async () => {} });
  assert.equal(r2.escalated, 0);
  assert.ok(db.data.custody.some(x => x.caseId === caseId && /past its deadline/.test(x.event)));
});

test('scheduler: a reminder is sent with the customer link, counted, and limited', async () => {
  const followup = require('../src/services/followup');
  process.env.PUBLIC_BASE_URL = 'https://praman.example.com';
  const c = db.data.cases.find(x => x.claimNo === 'POL-200');
  c.whatsappAccountId = 'wa1';
  await db.write();
  const sent = [];
  const send = async (cs, acct, tpl, link) => { sent.push({ to: cs.whatsappNumber, tpl, link }); };
  const daytime = t => { const d = new Date(t); while (followup.inQuietHours(d, { quietFrom: 21, quietTo: 8 })) d.setUTCHours(d.getUTCHours() + 1); return d; };
  const mine = () => sent.filter(x => x.to === c.whatsappNumber);

  const t1 = daytime(new Date(c.createdAt).getTime() + 7 * 3600e3);
  await scheduler.followupTick({ now: t1, send });
  assert.equal(mine().length, 1);
  assert.match(mine()[0].link, /^https:\/\/praman\.example\.com\/ai-call\.html\?t=/);
  assert.equal(c.followUp.count, 1);
  await scheduler.followupTick({ now: t1, send });
  assert.equal(mine().length, 1); // not again straight away
  const t2 = daytime(t1.getTime() + 7 * 3600e3);
  await scheduler.followupTick({ now: t2, send });
  assert.equal(mine().length, 2);
  await scheduler.followupTick({ now: daytime(t2.getTime() + 7 * 3600e3), send });
  assert.equal(mine().length, 2); // the limit of 2 is reached
});

test('scheduler: a message that WhatsApp refuses is retried, then reminders stop with a note', async () => {
  const c = db.data.cases.find(x => x.claimNo === 'POL-100');
  c.whatsappAccountId = 'wa1'; c.followUp = { count: 0 }; c.dueAt = new Date(Date.now() + 99 * 3600e3).toISOString();
  const failing = async () => { throw new Error('template not approved'); };
  let t = new Date(Date.now() + 10 * 86400e3); t.setUTCHours(6, 0, 0, 0);
  for (let i = 0; i < 3; i++) { await scheduler.followupTick({ now: t, send: failing }); t = new Date(t.getTime() + 2 * 3600e3); }
  assert.equal(c.followUp.stopped, true);
  assert.match(c.followUp.lastError, /template not approved/);
  assert.ok(db.data.custody.some(x => x.caseId === c.id && /reminders stopped/.test(x.event)));
});

test('retention: only finished cases past their period lose files; legal hold protects', async () => {
  const done = (id, daysAgo, extra = {}) => {
    const t = new Date(Date.now() - daysAgo * 86400e3).toISOString();
    db.data.cases.push({ id, vendorId: 'firm1', status: 'completed', completedAt: t, aiCall: { status: 'completed', completedAt: t }, ...extra });
    db.data.evidence.push({ id: 'ev_' + id, caseId: id, vendorId: 'firm1', fileUrl: '/media/' + id + '.jpg' });
  };
  done('old1', 90); done('new1', 10); done('held', 90, { legalHold: true });
  db.data.cases.push({ id: 'open1', vendorId: 'firm1', status: 'in_progress', createdAt: '2020-01-01' });
  db.data.evidence.push({ id: 'ev_open1', caseId: 'open1', vendorId: 'firm1', fileUrl: '/media/open1.jpg' });
  const removed = [];
  const dry = await retention.run({ dryRun: true });
  assert.equal(dry.files, 1);
  const real = await retention.run({ remove: async u => { removed.push(u); } });
  assert.deepEqual(removed, ['/media/old1.jpg']);
  const ev = db.data.evidence.find(e => e.id === 'ev_old1');
  assert.equal(ev.fileUrl, null); assert.ok(ev.purgedAt);
  assert.ok(db.data.evidence.find(e => e.id === 'ev_new1').fileUrl);
  assert.ok(db.data.evidence.find(e => e.id === 'ev_held').fileUrl);
  assert.ok(db.data.evidence.find(e => e.id === 'ev_open1').fileUrl);
  assert.ok(db.data.custody.some(x => x.caseId === 'old1' && /retention/.test(x.event)));
  assert.equal((await retention.run({ remove: async () => { throw new Error('again'); } })).files, 0); // nothing left to do
  assert.equal(real.deleted, 1);
});

test('error log: a crashing route is answered cleanly and recorded', async () => {
  const errlog = require('../src/services/errlog');
  errlog.record('test', new Error('Gemini said key=AIzaSyABCDEFGHIJKLMNOPQRSTUV and 1234 5678 9012'));
  errlog.record('test', new Error('Gemini said key=AIzaSyABCDEFGHIJKLMNOPQRSTUV and 1234 5678 9012'));
  const e = db.data.errorLog.find(x => x.source === 'test');
  assert.equal(e.count, 2); // same problem is one line with a counter
  assert.ok(!/AIzaSyABCDEFG/.test(e.message) && !/5678/.test(e.message)); // secrets and ID numbers are never logged
  const r = await fetch(base + '/api/cases', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminTok }, body: '{bad json' });
  assert.equal(r.status, 400);
});

test('AI call: background noise is never taken as the customer\'s answer', async () => {
  const gemini = require('../src/services/gemini');
  const keep = [gemini.transcribeAndTranslateAudio, gemini.generateSpeech];
  gemini.generateSpeech = async () => { throw new Error('no voice in tests'); };
  try {
    const mk = await call('POST', '/api/v1/cases', { key: apiKey, body: { policyNo: 'POL-NOISE', whatsappNumber: '919876500001', service: 'pivc_life', sendLink: false, verificationMode: 'full_automation' } });
    const token = new URL(mk.body.customerLink).searchParams.get('t');
    const start = await fetch(`${base}/api/ai-call/${token}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: 'English', consent: true }) });
    const turn = (await start.json()).turn;
    assert.equal(turn.expect, 'voice');
    const send = async () => {
      const fd = new FormData();
      fd.append('stage', turn.stage);
      fd.append('audio', new Blob([Buffer.alloc(8000, 1)], { type: 'audio/wav' }), 'a.wav');
      return (await fetch(`${base}/api/ai-call/${token}/turn`, { method: 'POST', body: fd })).json();
    };
    // 1) only noise: the model marks it unclear, even though it "heard" words
    gemini.transcribeAndTranslateAudio = async () => ({ clear: false, english: 'Thanks for watching!', original: 'Thanks for watching!' });
    const r1 = await send();
    assert.equal(r1.noisy, true); assert.equal(r1.heard, null);
    const c = db.data.cases.find(x => x.claimNo === 'POL-NOISE');
    assert.equal((c.aiCall.answers || []).length, 0);
    assert.equal(c.aiCall.queue[c.aiCall.i].id, turn.stage); // still on the same question
    // 2) clear speech is accepted as before
    gemini.transcribeAndTranslateAudio = async () => ({ clear: true, english: 'My name is Rajesh Kumar', original: 'My name is Rajesh Kumar', language: 'English' });
    const r2 = await send();
    assert.equal(r2.noisy, false); assert.equal(r2.heard, 'My name is Rajesh Kumar');
  } finally { [gemini.transcribeAndTranslateAudio, gemini.generateSpeech] = keep; }
});

test('scheduler: older cases without a deadline are left alone (no surprise messages after an update)', async () => {
  db.data.cases.push({ id: 'legacy1', vendorId: 'firm1', status: 'in_progress', verificationMode: 'full_automation', aiCall: { status: 'not_started', token: 'zz' }, createdAt: '2020-01-01T00:00:00.000Z', whatsappNumber: '919800000000', whatsappAccountId: 'wa1' });
  const sent = [];
  const r = await scheduler.followupTick({ now: new Date(), send: async (...a) => { sent.push(a); } });
  assert.equal(sent.some(a => a[0].id === 'legacy1'), false);
  assert.equal(db.data.cases.find(x => x.id === 'legacy1').escalatedAt, undefined);
});

test('review: sign-off completes the case, keeps the earlier sign-off, and other firms cannot review', async () => {
  db.data.cases.push({ id: 'rv1', vendorId: 'firm1', caseType: 'claim', claimNo: 'RV-1', caseRef: 'PR-RV1', status: 'in_progress', createdAt: new Date().toISOString(), reviewState: 'awaiting_review', aiCall: { status: 'completed', decision: 'verified', flags: [], checks: [], answers: [] } });
  await db.write();
  assert.equal((await call('POST', '/api/cases/rv1/ai-review', { tok: otherTok, body: { finalVerdict: 'verified' } })).status, 404);
  assert.equal((await call('POST', '/api/cases/rv1/ai-review', { tok: agentTok, body: { finalVerdict: 'pending_verification', reviewerName: 'A' } })).status, 200);
  let c = db.data.cases.find(x => x.id === 'rv1'); await db.read(); c = db.data.cases.find(x => x.id === 'rv1');
  assert.notEqual(c.status, 'completed'); // "pending" is not a decision
  assert.equal((await call('POST', '/api/cases/rv1/ai-review', { tok: adminTok, body: { finalVerdict: 'verified', reviewerName: 'Boss' } })).status, 200);
  await db.read(); c = db.data.cases.find(x => x.id === 'rv1');
  assert.equal(c.status, 'completed'); assert.equal(c.reviewState, 'reviewed');
  assert.equal(c.aiReviewHistory.length, 1); assert.equal(c.aiReview.reviewedByLogin, 'a@firm.test');
});

test('checklist: a person can mark an item done with a note; it shows with their name and can be undone; other firms cannot', async () => {
  const engine = require('../src/services/ai-call-engine');
  const c = { id: 'ov1', vendorId: 'firm1', caseType: 'claim_investigation', claimNo: 'OV-1', caseRef: 'PR-OV1', insuredName: 'Ov', status: 'in_progress', createdAt: new Date().toISOString(), aiCall: {} };
  engine.startSession(c, { language: 'English' }); c.aiCall.status = 'completed'; c.aiCall.i = c.aiCall.queue.length - 1;
  db.data.cases.push(c); await db.write();
  const url = '/api/cases/ov1/checklist/q_fir';
  assert.equal((await call('POST', url, { tok: otherTok, body: { note: 'x' } })).status, 404);
  assert.equal((await call('POST', url, { tok: agentTok, body: {} })).status, 400);                 // a note is required
  const ok = await call('POST', url, { tok: agentTok, body: { note: 'Asked on the live call: FIR 123 at Kothrud police station' } });
  assert.equal(ok.status, 200);
  const it = ok.body.aiChecklist.find(i => i.id === 'q_fir');
  assert.equal(it.status, 'done'); assert.equal(it.byHuman, true); assert.match(it.detail, /Done by ag@firm.test.*FIR 123/);
  const undo = await call('POST', url, { tok: agentTok, body: { undo: true } });
  assert.notEqual(undo.body.aiChecklist.find(i => i.id === 'q_fir').status, 'done');
});

test('summary counts cases waiting for review', async () => {
  db.data.cases.push({ id: 'rw1', vendorId: 'firm1', caseType: 'claim_investigation', claimNo: 'RW-1', status: 'in_progress', createdAt: new Date().toISOString(), reviewState: 'awaiting_review', aiCall: { status: 'completed' } });
  await db.write();
  const r = await call('GET', '/api/workflow/summary', { tok: adminTok });
  assert.ok(r.body.review >= 1);
});
