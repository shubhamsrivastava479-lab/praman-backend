// Identifiers and storage keys — one place, so every record and file is
// named the same way.
//
//   case.id        case_<time><random>       internal, never changes
//   case.caseRef   PRM26-000123              human case number, unique across the platform
//   case.claimNo   from the insurer          unique per firm (duplicates are blocked)
//   evidence.id    ev_<time><random>         the stored file is named after it:
//                  cases/<case.id>/<evidence.id>.<ext>   (unassigned WhatsApp items:
//                  unassigned/<vendorId>/<evidence.id>.<ext>)
const crypto = require('crypto');

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
}

const EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/gif': 'gif',
  'application/pdf': 'pdf', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/3gpp': '3gp',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/webm': 'webm', 'audio/amr': 'amr',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'text/plain': 'txt'
};
function extFor(mime, fallback = 'bin') {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  return EXT[m] || (m.split('/')[1] || fallback).replace(/[^a-z0-9]/g, '').slice(0, 6) || fallback;
}

function caseFileKey(caseId, evidenceId, mimeOrExt) {
  const ext = /\//.test(mimeOrExt || '') ? extFor(mimeOrExt) : String(mimeOrExt || 'bin').replace(/^\./, '');
  return `cases/${String(caseId).replace(/[^A-Za-z0-9_-]/g, '')}/${evidenceId}.${ext}`;
}
function unassignedFileKey(vendorId, evidenceId, mime) {
  return `unassigned/${String(vendorId).replace(/[^A-Za-z0-9_-]/g, '')}/${evidenceId}.${extFor(mime)}`;
}

// PRM26-000123: year of creation + platform-wide running number.
function nextCaseRef(data, when = new Date()) {
  const s = (data.platformSettings = data.platformSettings || {});
  s.caseSeq = (Number(s.caseSeq) || 0) + 1;
  return `PRM${String(when.getFullYear()).slice(-2)}-${String(s.caseSeq).padStart(6, '0')}`;
}

const normRef = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Brings older records up to the current shape. Safe to run at every start.
function backfill(data) {
  let changed = 0;
  const cases = (data.cases || []).slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const c of cases) {
    if (!c.caseRef) { c.caseRef = nextCaseRef(data, c.createdAt ? new Date(c.createdAt) : new Date()); changed++; }
    if (!c.selfToken) { c.selfToken = crypto.randomBytes(16).toString('hex'); changed++; }
    if (!c.service) { c.service = require('./plans').serviceOfCase(c); changed++; }
  }
  const byId = new Map((data.cases || []).map(c => [c.id, c]));
  for (const e of data.evidence || []) {
    if (!e.id) { e.id = uid('ev'); changed++; }
    const c = e.caseId && byId.get(e.caseId);
    if (c && e.vendorId !== c.vendorId) { e.vendorId = c.vendorId; changed++; }
  }
  return changed;
}

module.exports = { uid, extFor, caseFileKey, unassignedFileKey, nextCaseRef, normRef, backfill };
