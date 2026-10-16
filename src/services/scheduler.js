// Background jobs that run inside the server (no extra service needed):
//   every minute   : send due webhook deliveries
//   every 5 minutes: customer reminders + escalation of late cases
//   once a day     : data retention clean-up (about 3:30 am India time)
// Needs ONE server instance (the same rule as the database).
const { db, uid } = require('../db');
const followup = require('./followup');
const webhooks = require('./webhooks');
const retention = require('./retention');
const errlog = require('./errlog');

const status = { startedAt: null, followup: null, webhooks: null, retention: null, recording: null };

function publicBase() {
  const p = process.env.PUBLIC_BASE_URL;
  return p && !/your-deployed|your_domain/i.test(p) ? p.replace(/\/$/, '') : null;
}

async function defaultSend(c, account, template, link) {
  const wa = require('./whatsapp');
  return wa.sendTemplateMessage(c.whatsappNumber, template, account, 'en', [{ type: 'body', parameters: [{ type: 'text', text: link }] }]);
}

// One pass over all open cases. `send` can be replaced in tests.
async function followupTick({ now = new Date(), send = defaultSend } = {}) {
  const base = publicBase();
  const { customerLink } = require('../routes/cases');
  const out = { reminded: 0, escalated: 0, failed: 0 };
  for (const c of db.data.cases) {
    if (!followup.isOpen(c)) continue;
    if (!c.dueAt) continue; // cases opened before this feature existed are never reminded or escalated by themselves
    const firm = db.data.users.find(u => u.id === c.vendorId);
    if (!firm || firm.approved === false) continue;
    const s = followup.settingsOf(firm);
    const d = followup.decide(c, s, now);
    if (d.action === 'escalate') {
      c.escalatedAt = now.toISOString();
      db.data.custody.push({ id: uid('cust'), caseId: c.id, event: `Case is past its deadline (${new Date(followup.dueOf(c, s)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}) — marked overdue for follow-up`, actor: 'system', timestamp: now.toISOString() });
      webhooks.emit('case.overdue', c, { overdue: true });
      require('./notifications').notify(c.vendorId, { type: 'overdue', caseId: c.id, text: `Case ${c.caseRef} is past its deadline` });
      out.escalated++;
    } else if (d.action === 'remind') {
      const account = db.data.whatsappAccounts.find(a => a.id === c.whatsappAccountId);
      const f = (c.followUp ||= { count: 0 });
      if (!account || !base) {
        f.skipReason = !account ? 'No WhatsApp number is linked to this case' : 'PUBLIC_BASE_URL is not set on the server';
        f.nextAt = new Date(now.getTime() + 6 * 3600e3).toISOString();
        continue;
      }
      try {
        await send(c, account, s.reminderTemplate, customerLink(c, base));
        f.count = (f.count || 0) + 1; f.lastAt = now.toISOString(); f.failCount = 0; f.skipReason = undefined;
        f.nextAt = new Date(now.getTime() + s.remindEveryHours * 3600e3).toISOString();
        c.lastContactAt = now.toISOString();
        db.data.custody.push({ id: uid('cust'), caseId: c.id, event: `Automatic WhatsApp reminder sent to the customer (${d.reason})`, actor: 'system', timestamp: now.toISOString() });
        out.reminded++;
      } catch (e) {
        f.failCount = (f.failCount || 0) + 1; f.lastError = String(e.message || e).slice(0, 160);
        f.nextAt = new Date(now.getTime() + 3600e3).toISOString();
        if (f.failCount >= 3) { f.stopped = true; db.data.custody.push({ id: uid('cust'), caseId: c.id, event: `Automatic reminders stopped: WhatsApp could not deliver (${f.lastError})`, actor: 'system', timestamp: now.toISOString() }); }
        out.failed++;
      }
    }
  }
  if (out.reminded || out.escalated || out.failed) await db.write();
  return out;
}

// A finished AI call whose video recording never arrived (browser blocked it, upload failed):
// after 15 minutes it is flagged and can no longer count as a clean "verified".
async function recordingTick({ now = new Date() } = {}) {
  let flagged = 0;
  for (const c of db.data.cases) {
    const a = c.aiCall;
    if (!a || a.status !== 'completed' || a.recordingFlagged || !a.completedAt) continue;
    if (now - new Date(a.completedAt) < 15 * 60e3) continue;
    if (db.data.evidence.some(e => e.caseId === c.id && e.type === 'call_recording')) continue;
    a.recordingFlagged = true;
    const note = 'The call recording was not received — only answers and photos are available; consider a live call';
    (a.flags ||= []).push(note);
    c.verificationFlags = [...(c.verificationFlags || []), note];
    if (a.decision === 'verified') a.decision = 'partially_verified';
    c.reviewState = c.aiReview ? c.reviewState : 'awaiting_review';
    if (c.status === 'completed' && !c.aiReview) c.status = 'in_progress';
    db.data.custody.push({ id: uid('cust'), caseId: c.id, event: note, actor: 'system', timestamp: now.toISOString() });
    flagged++;
  }
  if (flagged) await db.write();
  return { flagged };
}

async function guarded(name, fn) {
  try { status[name] = { at: new Date().toISOString(), result: await fn() }; }
  catch (e) { status[name] = { at: new Date().toISOString(), error: e.message }; errlog.record('scheduler:' + name, e); }
}

let lastRetentionDay = null;
function start() {
  if (status.startedAt) return;
  status.startedAt = new Date().toISOString();
  setInterval(() => guarded('webhooks', () => webhooks.processDue()), 60e3).unref();
  setInterval(() => guarded('followup', () => followupTick()), 5 * 60e3).unref();
  setInterval(() => guarded('recording', () => recordingTick()), 5 * 60e3).unref();
  setInterval(() => guarded('wallet', async () => { const w = require('./wallet'); const r = w.sweep(db.data); if (r.charged) await db.write(); const bad = w.reconcile(db.data); if (bad.length) errlog.record('wallet:mismatch', new Error('Wallet balance differs from ledger for ' + bad.map(b => b.vendorId).join(', '))); return { ...r, mismatch: bad.length }; }), 60e3).unref();
  setInterval(() => guarded('billing', () => require('./billing').tick()), 6 * 3600e3).unref();
  setInterval(() => guarded('backup', () => require('./backup').tick()), 30 * 60e3).unref();
  setInterval(() => {
    const ist = new Date(Date.now() + 5.5 * 3600e3);
    const day = ist.toISOString().slice(0, 10);
    if (ist.getUTCHours() === 3 && ist.getUTCMinutes() >= 30 && lastRetentionDay !== day) {
      lastRetentionDay = day;
      guarded('retention', () => retention.run());
    }
  }, 5 * 60e3).unref();
  // first pass a little after start-up
  setTimeout(() => guarded('followup', () => followupTick()), 30e3).unref();
  setTimeout(() => guarded('billing', () => require('./billing').tick()), 150e3).unref();
  setTimeout(() => guarded('backup', () => require('./backup').tick()), 120e3).unref();
}

module.exports = { start, followupTick, recordingTick, status };
