require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, server } = require('../src/server');
const { db } = require('../src/db');
const { signToken } = require('../src/services/auth');

let base, T;
test.before(async () => {
  await start(0); base = `http://127.0.0.1:${server.address().port}`;
  db.data.users.push({ id: 'sc1', email: 'sc@t', vendorName: 'Firm', role: 'vendor_admin', approved: true });
  db.data.cases.push({ id: 'cl1', vendorId: 'sc1', caseRef: 'PRM-1', claimNo: 'C1', caseType: 'claim_investigation', status: 'in_progress', createdAt: new Date().toISOString() },
                     { id: 'pv1', vendorId: 'sc1', caseRef: 'PRM-2', claimNo: 'P1', caseType: 'policy_verification', status: 'in_progress', createdAt: new Date().toISOString() });
  await db.write();
  T = signToken({ id: 'sc1', email: 'sc@t', role: 'vendor_admin', vendorRootId: 'sc1' });
});
test.after(() => server.close());

const upload = async (caseId, fields) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('recording', new Blob([Buffer.from('fake video bytes')], { type: 'video/mp4' }), 'call.mp4');
  const r = await fetch(`${base}/api/live/case/${caseId}/external-recording`, { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: fd });
  return { status: r.status, body: await r.json() };
};

test('screen-share check saves checklist, flags refusals, and logs it', async () => {
  const checklist = JSON.stringify([{ key: 'whatsapp_chats', status: 'shown' }, { key: 'fir', status: 'refused' }, { key: 'hacker', status: 'shown' }, { key: 'photos', status: 'bogus' }, { key: 'calls', status: 'na' }]);
  const r = await upload('cl1', { callType: 'google_meet', screenShared: '1', consent: '1', notes: 'Chat seen', checklist });
  assert.equal(r.status, 200);
  await db.read();
  const c = db.data.cases.find(x => x.id === 'cl1');
  assert.deepEqual(c.screenCheck && [c.screenCheck.shown, c.screenCheck.refused, c.screenCheck.total], [1, 1, 3]);   // unknown key / status ignored
  assert.ok(c.verificationFlags.some(f => /declined to show on screen.*police complaint/i.test(f)));
  const ev = db.data.evidence.find(e => e.id === r.body.evidenceId);
  assert.match(ev.caption, /Google Meet video call with screen share/);
  assert.match(ev.analysis.keyDetails, /Customer refused: Police complaint/);
  assert.ok(db.data.custody.some(x => x.caseId === 'cl1' && /Screen-share check done/.test(x.event)));
});
test('consent is required, and the checklist is ignored for policy verification', async () => {
  assert.equal((await upload('cl1', { callType: 'whatsapp_video', checklist: '[]' })).status, 400);
  const r = await upload('pv1', { callType: 'whatsapp_video', screenShared: '1', consent: '1', checklist: JSON.stringify([{ key: 'fir', status: 'refused' }]) });
  assert.equal(r.status, 200);
  await db.read();
  assert.equal(db.data.cases.find(x => x.id === 'pv1').screenCheck, undefined);
});
