const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers');
const { PgStore } = require('../src/db');

test('database save: only changed records are written, and no second copy of the data is kept', async () => {
  const store = new PgStore('postgres://u:p@localhost:5432/x');
  const calls = [];
  store.pool = { connect: async () => ({ query: async (sql, args) => { calls.push({ sql: String(sql).trim().split(/\s+/)[0], args }); return { rows: [] }; }, release() {} }) };
  const data = { users: [{ id: 'u1', email: 'a@b.in' }, { id: 'u2', email: 'c@d.in' }], settings: { a: 1 }, empty: [] };
  const count = () => calls.filter(c => c.sql === 'insert').reduce((n, c) => n + c.args[0].length, 0);

  let r = await store.flush(data);
  assert.equal(r.upserted, 3); assert.equal(r.deleted, 0);                      // first save writes everything
  for (const v of store.snap.values()) assert.match(v, /^\d+\|[A-Za-z0-9+/=]+$/); // fingerprint only, no JSON text
  r = await store.flush(data);
  assert.deepEqual(r, { upserted: 0, deleted: 0 });                              // nothing changed: nothing written
  data.users[1].email = 'new@d.in';
  r = await store.flush(data);
  assert.equal(r.upserted, 1);                                                   // one record changed
  data.users.splice(0, 1);
  r = await store.flush(data);
  assert.equal(r.deleted, 1);                                                    // one record removed
  data.users.push({ id: 'u2', email: 'dup@x.in' });                              // same id twice: kept apart
  r = await store.flush(data);
  assert.equal(r.upserted, 1);
});
