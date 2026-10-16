// Customer data-deletion requests (DPDP Act readiness).
//
// A customer can ask, from the link on their call page, for their personal data to be erased.
// The firm decides: erase (files and personal details are removed; the case number, result,
// flags and the activity record stay so the firm can still show that a check was done) or
// decline with a reason (for example when the law requires the firm to keep the record).
// A case under legal hold is never erased by this tool.
const { db, uid } = require('../db');
const storage = require('./storage');

const ERASED = '[erased]';

async function eraseCase(c, by) {
  if (c.legalHold) throw new Error('This case is under legal hold. Remove the hold first.');
  const out = { files: 0, failed: 0 };
  for (const e of db.data.evidence.filter(x => x.caseId === c.id)) {
    if (e.fileUrl) { try { await storage.deleteFile(e.fileUrl); out.files++; } catch { out.failed++; continue; } }
    e.fileUrl = null; e.purgedAt = new Date().toISOString(); e.location = null; e.analysis = null; e.caption = 'Erased on the customer\'s request';
  }
  if (out.failed) throw new Error(`${out.failed} file(s) could not be deleted from storage. Nothing else was erased; please try again.`);
  db.data.transcripts = db.data.transcripts.filter(t => t.caseId !== c.id);
  db.data.callSessions = db.data.callSessions.filter(s => s.caseId !== c.id);
  db.data.reports = db.data.reports.filter(r => r.caseId !== c.id);
  Object.assign(c, { insuredName: ERASED, whatsappNumber: '', vehicleNo: '', district: '', policyNo: c.policyNo ? ERASED : '', policyValue: null, erasedAt: new Date().toISOString(), erasedBy: by });
  const a = c.aiCall;
  if (a) {
    a.answers = (a.answers || []).map(x => ({ key: x.key, section: x.section, question: x.question, erased: true }));
    a.docs = {}; a.captured = null; a.startLocation = null; a.locations = []; a.deviceSig = null; a.summary = ERASED;
    a.chatReview = null; a.idKeysSaved = undefined; a.token = a.token; // link stays so the page can say "erased"
  }
  c.shareToken = null;   // old report links stop working
  db.data.custody.push({ id: uid('cust'), caseId: c.id, event: `Personal data erased on the customer's request (${out.files} file(s) deleted)`, actor: by || 'system', timestamp: new Date().toISOString() });
  return out;
}

module.exports = { eraseCase };
