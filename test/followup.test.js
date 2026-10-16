require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../src/services/followup');

const S = f.normalize({});
const open = (extra = {}) => ({ id: 'c1', status: 'in_progress', verificationMode: 'full_automation', aiCall: { status: 'not_started' }, createdAt: '2026-10-01T04:30:00.000Z', ...extra }); // 10:00 IST

test('settings are clamped to sane values', () => {
  const s = f.normalize({ tatHours: 99999, remindEveryHours: 0, maxReminders: -3, quietFrom: 40, reminderTemplate: 'my tpl; drop' });
  assert.equal(s.tatHours, 24 * 90);
  assert.equal(s.remindEveryHours, 1);
  assert.equal(s.maxReminders, 0);
  assert.equal(s.quietFrom, 23);
  assert.equal(s.reminderTemplate, 'mytpldrop');
  assert.deepEqual(f.normalize(undefined), f.DEFAULTS);
});

test('quiet hours use India time and wrap over midnight', () => {
  assert.equal(f.inQuietHours(new Date('2026-10-01T16:00:00Z'), S), true);  // 21:30 IST
  assert.equal(f.inQuietHours(new Date('2026-10-01T02:00:00Z'), S), true);  // 07:30 IST
  assert.equal(f.inQuietHours(new Date('2026-10-01T05:00:00Z'), S), false); // 10:30 IST
  assert.equal(f.inQuietHours(new Date('2026-10-01T05:00:00Z'), { ...S, quietFrom: 5, quietTo: 5 }), false);
});

test('deadline defaults to creation + TAT and time state follows it', () => {
  const c = open();
  assert.equal(f.dueOf(c, S), '2026-10-03T04:30:00.000Z');
  assert.equal(f.timeState(c, S, new Date('2026-10-01T12:00:00Z')), 'ok');
  assert.equal(f.timeState(c, S, new Date('2026-10-03T00:00:00Z')), 'due_soon');
  assert.equal(f.timeState(c, S, new Date('2026-10-04T00:00:00Z')), 'overdue');
  assert.equal(f.timeState({ ...c, status: 'completed' }, S, new Date('2026-12-01')), 'done');
  assert.equal(f.timeState({ ...c, dueAt: '2026-10-01T05:00:00.000Z' }, S, new Date('2026-10-01T06:00:00Z')), 'overdue');
});

test('first reminder goes out after the gap, never in quiet hours', () => {
  const c = open();
  assert.equal(f.decide(c, S, new Date('2026-10-01T06:00:00Z')).action, 'none');           // too early (11:30 IST)
  assert.equal(f.decide(c, S, new Date('2026-10-01T11:00:00Z')).action, 'remind');         // 16:30 IST, 6.5 h later
  assert.equal(f.decide(c, S, new Date('2026-10-01T16:30:00Z')).reason, 'quiet hours');    // 22:00 IST
});

test('reminders stop at the limit, when stopped, or when the case is finished', () => {
  const t = new Date('2026-10-01T11:00:00Z');
  assert.equal(f.decide(open({ followUp: { count: 3 } }), S, t).action, 'none');
  assert.equal(f.decide(open({ followUp: { stopped: true } }), S, t).action, 'none');
  assert.equal(f.decide(open({ status: 'completed' }), S, t).action, 'none');
  assert.equal(f.decide(open({ aiCall: { status: 'completed' } }), S, t).action, 'none');
  assert.equal(f.decide(open({ verificationMode: 'executive' }), S, t).action, 'none');
  assert.equal(f.decide(open(), { ...S, autoRemind: false }, t).action, 'none');
});

test('no reminder while the customer is actively on the call', () => {
  const t = new Date('2026-10-01T11:00:00Z');
  const c = open({ aiCall: { status: 'in_progress', lastActivityAt: '2026-10-01T10:55:00.000Z' } });
  assert.equal(f.decide(c, S, t).action, 'none');
  const idle = open({ aiCall: { status: 'in_progress', lastActivityAt: '2026-10-01T09:00:00.000Z' } });
  assert.equal(f.decide(idle, S, t).action, 'remind');
});

test('a late case is escalated once', () => {
  const late = new Date('2026-10-04T00:00:00Z');
  assert.equal(f.decide(open(), S, late).action, 'escalate');
  assert.notEqual(f.decide(open({ escalatedAt: '2026-10-04T00:00:00Z' }), S, late).action, 'escalate');
});

test('next reminder time is respected', () => {
  const c = open({ followUp: { count: 1, nextAt: '2026-10-01T18:00:00.000Z' } });
  assert.equal(f.decide(c, S, new Date('2026-10-01T11:00:00Z')).action, 'none');
  assert.equal(f.decide(c, S, new Date('2026-10-02T04:00:00Z')).action, 'remind');
});
