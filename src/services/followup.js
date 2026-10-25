// Follow-up of open cases: deadline (TAT), automatic WhatsApp reminders with the
// customer's link, and escalation when a case runs late.
//
// Settings are per firm (vendor admin edits them): firm.followUp
//   tatHours          hours from case creation until the case is due (default 48)
//   autoRemind        send reminders by itself (default true)
//   remindEveryHours  gap between reminders (default 6)
//   maxReminders      how many reminders in total (default 3)
//   quietFrom/quietTo no reminders between these India-time hours (default 21 → 8)
//   reminderTemplate  approved WhatsApp template that carries the link
//   requireReview     a "verified" AI call still waits for an investigator's sign-off before the case is completed (default true)
//
// Case fields: dueAt, assignedTo (agent user id), followUp { count, lastAt, nextAt, stopped }, escalatedAt
const DEFAULTS = { tatHours: 48, autoRemind: true, remindEveryHours: 6, maxReminders: 3, quietFrom: 21, quietTo: 8, reminderTemplate: 'claim_investigation_intake', linkTemplate: '', requireReview: true, notifyEmail: '', insurerEmail: '', cannedRemarks: [], secondReviewAbove: 0, completionMessage: true };

const num = (v, lo, hi, d) => { const n = Number(v); return isFinite(n) && v !== '' && v != null ? Math.min(hi, Math.max(lo, n)) : d; };

function normalize(raw = {}) {
  const r = raw || {};
  return {
    tatHours: num(r.tatHours, 1, 24 * 90, DEFAULTS.tatHours),
    requireReview: r.requireReview === undefined ? DEFAULTS.requireReview : !!r.requireReview,
    autoRemind: r.autoRemind === undefined ? DEFAULTS.autoRemind : !!r.autoRemind,
    remindEveryHours: num(r.remindEveryHours, 1, 24 * 14, DEFAULTS.remindEveryHours),
    maxReminders: Math.round(num(r.maxReminders, 0, 20, DEFAULTS.maxReminders)),
    quietFrom: Math.round(num(r.quietFrom, 0, 23, DEFAULTS.quietFrom)),
    quietTo: Math.round(num(r.quietTo, 0, 23, DEFAULTS.quietTo)),
    notifyEmail: String(r.notifyEmail || '').trim().slice(0, 200).replace(/[^\w.@+,;\- ]/g, ''),
    insurerEmail: String(r.insurerEmail || '').trim().slice(0, 200).replace(/[^\w.@+,;\- ]/g, ''),
    cannedRemarks: (Array.isArray(r.cannedRemarks) ? r.cannedRemarks : []).map(x => String(x || '').trim().slice(0, 300)).filter(Boolean).slice(0, 12),
    secondReviewAbove: num(r.secondReviewAbove, 0, 1e10, 0),      // 0 = off; sum assured / claim amount above this needs two sign-offs
    completionMessage: r.completionMessage === undefined ? true : !!r.completionMessage,
    reminderTemplate: String(r.reminderTemplate || DEFAULTS.reminderTemplate).replace(/[^a-z0-9_]/gi, '').slice(0, 80) || DEFAULTS.reminderTemplate,
    linkTemplate: String(r.linkTemplate || '').replace(/[^a-z0-9_]/gi, '').slice(0, 80) // optional: {{1}} name, {{2}} reason, {{3}} link
  };
}

const settingsOf = firm => normalize(firm && firm.followUp);

const istHour = d => new Date(d.getTime() + 5.5 * 3600e3).getUTCHours();
function inQuietHours(now, s) {
  const h = istHour(now);
  if (s.quietFrom === s.quietTo) return false;
  return s.quietFrom > s.quietTo ? (h >= s.quietFrom || h < s.quietTo) : (h >= s.quietFrom && h < s.quietTo);
}

const isOpen = c => c.status !== 'completed';
const dueOf = (c, s) => {
  if (c.dueAt) return c.dueAt;
  let base = new Date(c.createdAt).getTime();
  if (!Number.isFinite(base)) base = Date.now();     // an older record with no valid date must not break the list
  return new Date(base + (s.tatHours || 48) * 3600e3).toISOString();
};

// Does this case still wait for the customer? (link sent, AI call not finished)
function waitingForCustomer(c) {
  if (!isOpen(c)) return false;
  if (c.verificationMode !== 'full_automation') return false; // executive cases: a person calls, no reminder links
  const st = c.aiCall && c.aiCall.status;
  return st === 'not_started' || st === 'in_progress' || !st;
}

// Where does this case stand on time?  'ok' | 'due_soon' (< 6 h) | 'overdue' | 'done'
function timeState(c, s, now = new Date()) {
  if (!isOpen(c)) return 'done';
  const left = new Date(dueOf(c, s)).getTime() - now.getTime();
  if (left < 0) return 'overdue';
  return left < 6 * 3600e3 ? 'due_soon' : 'ok';
}

// Decides what to do for one case right now. Pure function (easy to test).
//   → { action: 'remind' | 'escalate' | 'none', reason }
function decide(c, s, now = new Date()) {
  if (!isOpen(c)) return { action: 'none', reason: 'closed' };
  const f = c.followUp || {};
  const overdue = timeState(c, s, now) === 'overdue';
  if (overdue && !c.escalatedAt) return { action: 'escalate', reason: 'overdue' };
  if (!s.autoRemind || f.stopped || !waitingForCustomer(c)) return { action: 'none', reason: 'no reminder needed' };
  if ((f.count || 0) >= s.maxReminders) return { action: 'none', reason: 'reminder limit reached' };
  if (c.aiCall && c.aiCall.status === 'in_progress' && c.aiCall.lastActivityAt && now - new Date(c.aiCall.lastActivityAt) < 15 * 60e3) return { action: 'none', reason: 'customer is on the call' };
  const first = new Date(c.lastContactAt || c.createdAt).getTime() + s.remindEveryHours * 3600e3;
  const due = f.nextAt ? new Date(f.nextAt).getTime() : first;
  if (now.getTime() < due) return { action: 'none', reason: 'not yet time' };
  if (inQuietHours(now, s)) return { action: 'none', reason: 'quiet hours' };
  return { action: 'remind', reason: `reminder ${(f.count || 0) + 1} of ${s.maxReminders}` };
}

module.exports = { DEFAULTS, normalize, settingsOf, istHour, inQuietHours, isOpen, dueOf, waitingForCustomer, timeState, decide };
