// Data retention: after a case is finished, its photos / recordings / documents are
// deleted from file storage when the firm's retention period (days) is over.
//
//   firm.retentionDays   number of days after the case finished; empty / 0 = keep forever
//   case.legalHold       true = never delete (court case, complaint, audit)
//
// What is deleted: the stored FILES (photos, call recordings, documents).
// What stays: the case, the AI report, transcripts and the chain of custody (with a line
// saying which files were deleted and when) — the proof that the verification was done.
const { db, uid } = require('../db');
const storage = require('./storage');

const finishedAt = c => {
  if (c.status !== 'completed' && !(c.aiCall && ['completed', 'handoff'].includes(c.aiCall.status))) return null;
  const t = (c.aiCall && c.aiCall.completedAt) || c.completedAt || (c.aiReview && c.aiReview.reviewedAt) || null;
  return t ? new Date(t) : null; // unknown finish date → never deleted automatically
};

function days(firm) {
  const n = Number(firm && firm.retentionDays);
  return isFinite(n) && n >= 1 ? Math.round(n) : 0;
}

// Which cases are due, and how many files they hold.
function plan(now = new Date()) {
  const out = [];
  for (const c of db.data.cases) {
    if (c.legalHold) continue;
    const firm = db.data.users.find(u => u.id === c.vendorId);
    const d = days(firm);
    if (!d) continue;
    const done = finishedAt(c);
    if (!done || now - done < d * 86400e3) continue;
    const files = db.data.evidence.filter(e => e.caseId === c.id && e.fileUrl && !e.purgedAt);
    if (files.length) out.push({ c, files, days: d });
  }
  return out;
}

async function run({ dryRun = false, now = new Date(), remove = storage.deleteFile } = {}) {
  const due = plan(now);
  const res = { cases: due.length, files: due.reduce((s, x) => s + x.files.length, 0), deleted: 0, failed: 0, dryRun };
  if (dryRun) return res;
  for (const { c, files, days: d } of due) {
    let ok = 0, bad = 0;
    for (const e of files) {
      try { await remove(e.fileUrl); e.purgedAt = now.toISOString(); e.purgedFileUrl = undefined; e.fileUrl = null; ok++; }
      catch (err) { bad++; e.purgeError = String(err.message || err).slice(0, 120); }
    }
    res.deleted += ok; res.failed += bad;
    if (ok) {
      db.data.custody.push({ id: uid('cust'), caseId: c.id, event: `${ok} stored file(s) deleted under the ${d}-day data retention policy${bad ? ` (${bad} could not be deleted yet)` : ''}`, actor: 'system', timestamp: now.toISOString() });
      c.filesPurgedAt = now.toISOString();
    }
  }
  // Data fetched by ID checks (PAN, RC, CIBIL ...) follows the same period; the transaction log itself is kept.
  res.apiResults = 0;
  for (const c of db.data.cases) {
    if (c.legalHold) continue;
    const d = days(db.data.users.find(u => u.id === c.vendorId)), done = finishedAt(c);
    if (!d || !done || now - done < d * 86400e3) continue;
    for (const r of (db.data.apiResults || [])) if (r.caseId === c.id && !r.purgedAt) { r.data = null; r.request = null; r.raw = undefined; r.purgedAt = now.toISOString(); res.apiResults++; }
  }
  if (res.deleted || res.failed || res.apiResults) await db.write();
  return res;
}

module.exports = { finishedAt, days, plan, run };
