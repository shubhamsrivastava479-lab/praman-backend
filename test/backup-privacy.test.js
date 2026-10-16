require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, server } = require('../src/server');
const { db } = require('../src/db');
const { signToken, hashPassword } = require('../src/services/auth');
const backup = require('../src/services/backup');
const storage = require('../src/services/storage');
const totp = require('../src/services/totp');
const mirror = require('../src/services/mirror');

let base, adm, sup;
const call = async (method, path, tok, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

test.before(async () => {
  await start(0); base = `http://127.0.0.1:${server.address().port}`;
  const d = db.data;
  d.users.push({ id: 'f1', email: 'a@f.test', vendorName: 'Firm', role: 'vendor_admin', approved: true, passwordHash: await hashPassword('pw12345'), services: ['pivc_life'] },
    { id: 'sa', email: 'root@p.test', vendorName: 'Platform', role: 'super_admin', passwordHash: 'x' });
  d.platformSettings.geminiApiKey = 'SECRET-KEY';
  d.cases.push({ id: 'c1', vendorId: 'f1', caseType: 'policy_verification', caseRef: 'PR-1', claimNo: 'A1', insuredName: 'Sita Devi', whatsappNumber: '919800000000', district: 'Pune', status: 'in_progress', createdAt: new Date().toISOString(),
    aiCall: { status: 'completed', token: 'tk1', answers: [{ key: 'name', question: 'Name?', value: 'Sita', english: 'Sita' }], docs: { aadhaar: { received: true, name: 'Sita' } }, flags: [], checks: [] } });
  d.transcripts.push({ id: 't1', caseId: 'c1', text: 'private' });
  await db.write();
  adm = signToken({ ...d.users[0], vendorRootId: 'f1' }); sup = signToken({ ...d.users[1], vendorRootId: 'sa' });
});
test.after(() => server.close());

test('backup → verify → restore brings back deleted data, and never contains the API keys', async () => {
  const e = await backup.run();
  assert.ok(e.counts.cases >= 1);
  const raw = require('zlib').gunzipSync(await storage.readFile(e.url)).toString();
  assert.ok(!raw.includes('SECRET-KEY'), 'platform secrets must not be in a backup');
  assert.equal((await backup.verify(e)).ok, true);
  db.data.cases.length = 0; db.data.platformSettings.geminiApiKey = 'NEW-KEY'; await db.write();
  await backup.restore(e);
  assert.equal(db.data.cases.length >= 1, true);
  assert.equal(db.data.platformSettings.geminiApiKey, 'NEW-KEY'); // settings are left alone
  assert.ok(db.data.backupLog.some(b => b.label === 'before-restore'));
});

test('backups: restore needs the typed word; the tick makes one backup per day', async () => {
  const id = db.data.backupLog[0].id;
  assert.equal((await call('POST', `/api/super-admin/backups/${id}/restore`, sup, { confirm: 'yes' })).status, 400);
  assert.equal((await call('GET', '/api/super-admin/backups', sup)).body.items.length >= 1, true);
  assert.equal((await call('GET', '/api/super-admin/backups', adm)).status, 403);
  const now = new Date('2030-01-01T10:00:00Z');
  assert.equal((await backup.tick(now)).made, true);
  assert.equal((await backup.tick(now)).made, false);
  assert.equal((await backup.tick(new Date('2030-01-01T18:00:00Z'))).made, false); // 23:30 IST, same India day
});

test('two-step login: needs the code, accepts it, locks after wrong codes', async () => {
  const s = await call('POST', '/api/auth/2fa/setup', adm, {});
  assert.ok(s.body.secret);
  assert.equal((await call('POST', '/api/auth/2fa/enable', adm, { code: '000000' })).status, 400);
  assert.equal((await call('POST', '/api/auth/2fa/enable', adm, { code: totp.codeAt(s.body.secret) })).status, 200);
  let r = await call('POST', '/api/auth/login', null, { email: 'a@f.test', password: 'pw12345' });
  assert.equal(r.status, 401); assert.equal(r.body.needCode, true);
  r = await call('POST', '/api/auth/login', null, { email: 'a@f.test', password: 'pw12345', code: totp.codeAt(s.body.secret) });
  assert.equal(r.status, 200); assert.ok(r.body.token);
  for (let i = 0; i < 5; i++) await call('POST', '/api/auth/login', null, { email: 'a@f.test', password: 'pw12345', code: '111111' });
  r = await call('POST', '/api/auth/login', null, { email: 'a@f.test', password: 'pw12345', code: totp.codeAt(s.body.secret) });
  assert.equal(r.status, 429); // locked even with the right code
  assert.ok(db.data.auditLog.some(a => a.action === '2fa_enabled'));
  assert.ok(db.data.auditLog.some(a => a.action === 'login_failed'));
});

test('data deletion: customer asks, firm erases, personal data is gone but the case stays', async () => {
  const f = await storage.saveFile(Buffer.from('img'), 'cases/c1/x.jpg', 'image/jpeg');
  db.data.evidence.push({ id: 'e9', caseId: 'c1', vendorId: 'f1', type: 'liveness_selfie', fileUrl: f, caption: 'face', analysis: { visibleText: 'secret' }, receivedAt: new Date().toISOString() });
  await db.write();
  assert.equal((await call('POST', '/api/ai-call/tk1/data-request', null, { reason: 'please' })).status, 200);
  await call('POST', '/api/ai-call/tk1/data-request', null, {}); // second time: no duplicate
  assert.equal(db.data.dataRequests.filter(r => r.caseId === 'c1').length, 1);
  assert.ok(db.data.notifications.some(n => n.type === 'data_request'));
  const rid = db.data.dataRequests[0].id;
  assert.equal((await call('POST', `/api/workflow/data-requests/${rid}`, adm, { action: 'decline' })).status, 400); // needs a reason
  const r = await call('POST', `/api/workflow/data-requests/${rid}`, adm, { action: 'erase' });
  assert.equal(r.status, 200);
  const c = db.data.cases.find(x => x.id === 'c1');
  assert.equal(c.insuredName, '[erased]'); assert.equal(c.whatsappNumber, '');
  assert.equal(c.aiCall.answers[0].value, undefined);
  assert.equal(db.data.transcripts.some(t => t.caseId === 'c1'), false);
  const ev = db.data.evidence.find(e => e.id === 'e9');
  assert.equal(ev.fileUrl, null);
  assert.equal(require('fs').existsSync(require('path').join(storage.mediaDir, 'cases/c1/x.jpg')), false);
  assert.equal((await call('POST', `/api/workflow/data-requests/${rid}`, adm, { action: 'erase' })).status, 409); // already closed
});

test('legal hold blocks erasure', async () => {
  db.data.cases.push({ id: 'c2', vendorId: 'f1', caseRef: 'PR-2', claimNo: 'A2', legalHold: true, status: 'completed', aiCall: { token: 'tk2', answers: [] } });
  await db.write();
  const dr = await call('POST', '/api/ai-call/tk2/data-request', null, {}); assert.equal(dr.status, 200, JSON.stringify(dr.body));
  const rid = db.data.dataRequests.find(r => r.caseId === 'c2').id;
  assert.equal((await call('POST', `/api/workflow/data-requests/${rid}`, adm, { action: 'erase' })).status, 409);
});

test('activity log is per firm and the relational mirror produces clean rows', async () => {
  const l = await call('GET', '/api/workflow/audit?limit=50', adm);
  assert.ok(Array.isArray(l.body) && l.body.length >= 1);
  assert.ok(l.body.every(x => x.vendorId === 'f1'));
  const rows = mirror.rowsOf(db.data);
  assert.ok(rows.praman_m_cases.find(r => r.id === 'c1'));
  assert.ok(!JSON.stringify(rows.praman_m_users).includes('passwordHash'));
  assert.ok(!JSON.stringify(rows.praman_m_users).includes('totpSecret'));
});
