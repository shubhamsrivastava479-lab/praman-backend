const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers');
const { db } = require('../src/db');
const gl = require('../src/services/gridlines');

const user = { id: 'u1', email: 'v@acme.in' };
function stub(fn) { const real = global.fetch; global.fetch = fn; return () => { global.fetch = real; }; }
const ok = body => async () => ({ ok: true, status: 200, json: async () => body });

test('every call is logged with its data; keys are per check', async () => {
  await db.read();
  const ps = (db.data.platformSettings ||= {});
  ps.gridlinesKeys = { rc_detailed: 'KEY_RC', cibil: 'KEY_CIBIL' };
  db.data.cases.push({ id: 'case1', vendorId: 'f1', caseRef: 'CLM-1' });
  let seen;
  const undo = stub(async (url, o) => { seen = { url, key: o.headers['X-API-Key'], body: JSON.parse(o.body) }; return { ok: true, status: 200, json: async () => ({ request_id: 'R1', data: { code: '1000', vehicle: { owner: 'A' } } }) }; });
  try {
    const r = await gl.call({ api: 'rc_detailed', input: { rcNumber: 'mh 12 ab 1234' }, user, vendorId: 'f1', caseId: 'case1' });
    assert.equal(seen.key, 'KEY_RC');                                   // its own key
    assert.match(seen.url, /\/rc-api\//);
    assert.equal(seen.body.rc_number, 'MH12AB1234');                    // upper-cased, spaces removed
    assert.equal(r.txn.status, 'success');
    assert.equal(r.txn.providerRef, 'R1');
    assert.notEqual(r.txn.input.rcNumber, 'MH12AB1234');                // masked in the log
    assert.equal(db.data.apiResults.find(x => x.txnId === r.txn.id).data.vehicle.owner, 'A');   // data kept
    assert.ok(db.data.evidence.find(e => e.apiResultId === r.result.id));                        // on the case
  } finally { undo(); }
});

test('no key, bad input, missing consent are blocked but still logged', async () => {
  await db.read();
  const before = db.data.apiTransactions.length;
  await assert.rejects(gl.call({ api: 'fastag', input: { vehicleNumber: 'MH12AB1234' }, user, vendorId: 'f1' }), e => e.code === 'NOT_CONFIGURED');
  await assert.rejects(gl.call({ api: 'rc_detailed', input: { rcNumber: '!!' }, user, vendorId: 'f1' }), e => e.code === 'INVALID');
  await assert.rejects(gl.call({ api: 'cibil', input: { fullName: 'A B', dateOfBirth: '1990-01-01', mobile: '9876543210', panNumber: 'ABCDE1234F', pincode: '411001' }, user, vendorId: 'f1' }), e => e.code === 'INVALID');
  const added = db.data.apiTransactions.slice(before);
  assert.equal(added.length, 3);
  assert.ok(added.every(t => t.status === 'blocked'));
});

test('provider failure is logged and the wallet is refunded', async () => {
  await db.read();
  db.data.platformSettings.gridlinesKeys.rc_detailed = 'KEY_RC';
  const undo = stub(async () => ({ ok: false, status: 500, json: async () => ({ message: 'boom' }) }));
  try {
    await assert.rejects(gl.call({ api: 'rc_detailed', input: { rcNumber: 'MH12AB1234' }, user, vendorId: 'f1' }), e => e.code === 'PROVIDER_DOWN' && !/boom/.test(e.message));
    const t = db.data.apiTransactions.at(-1);
    assert.equal(t.status, 'failed'); assert.equal(t.httpStatus, 500); assert.match(t.error, /boom/);
  } finally { undo(); }
});

test('CIBIL runs with consent and Super Admin path override', async () => {
  await db.read();
  db.data.platformSettings.gridlinesApis = { cibil: { path: '/cibil-v2/fetch' } }; await db.write();
  let url;
  const undo = stub(async u => { url = u; return { ok: true, status: 200, json: async () => ({ data: { score: 780 } }) }; });
  try {
    const r = await gl.call({ api: 'cibil', input: { fullName: 'A B', dateOfBirth: '1990-01-01', mobile: '9876543210', panNumber: 'ABCDE1234F', pincode: '411001' }, user, vendorId: 'f1', consent: true });
    assert.match(url, /\/cibil-v2\/fetch$/);
    assert.equal(r.result.data.score, 780);
    assert.ok(r.txn.consentAt);
  } finally { undo(); }
});

test('key & path check reads the provider answer', async () => {
  await db.read();
  db.data.platformSettings.gridlinesKeys = { fastag: 'K' }; await db.write();
  for (const [status, verdict] of [[401, 'bad_key'], [404, 'bad_path'], [400, 'ok'], [503, 'down']]) {
    const undo = stub(async () => ({ ok: false, status, json: async () => ({ message: 'x' }) }));
    try { assert.equal((await gl.probe('fastag')).verdict, verdict); } finally { undo(); }
  }
  assert.equal((await gl.probe('cibil')).verdict, 'no_key');
});
