const test = require('node:test');
const assert = require('node:assert');
process.env.JWT_SECRET = 'test'; delete process.env.DATABASE_URL;
const { db } = require('../src/db');
const ntf = require('../src/services/notifications');
const followup = require('../src/services/followup');

test('notifications are per firm, can be read, and are capped', async () => {
  await db.read();
  db.data.notifications = [];
  ntf.notify('v1', { type: 'x', text: 'one' });
  ntf.notify('v2', { type: 'x', text: 'other firm' });
  const u = { id: 'u1', vendorRootId: 'v1' };
  let l = ntf.listFor(u);
  assert.equal(l.items.length, 1); assert.equal(l.unread, 1);
  ntf.markRead(u);
  l = ntf.listFor(u);
  assert.equal(l.unread, 0);
  for (let i = 0; i < 320; i++) ntf.notify('v1', { text: 'n' + i });
  assert.ok(ntf.listFor(u, 1000).items.length <= 300);
  assert.equal(ntf.listFor({ id: 'z', vendorRootId: 'v2' }).items.length, 1);
});

test('new firm settings are cleaned up', () => {
  const s = followup.normalize({ cannedRemarks: ['  ok ', '', 'b'], secondReviewAbove: '500000', notifyEmail: 'a@b.com<script>' });
  assert.deepEqual(s.cannedRemarks, ['ok', 'b']);
  assert.equal(s.secondReviewAbove, 500000);
  assert.ok(!/[<>]/.test(s.notifyEmail));
  assert.equal(followup.normalize({}).completionMessage, true);
});
