// Audit log: who did what, and when. Kept in db.data.auditLog (newest last), per firm.
// It records actions (logins, settings, sign-offs, exports, team changes, data requests, backups).
// It never stores passwords, tokens or answers — only what happened.
const { db, uid } = require('../db');

const MAX = 20000;

// who: { id, email, role, vendorRootId } (a token payload) or a plain string such as 'system'
function log(who, action, detail, vendorId) {
  try {
    const u = who && typeof who === 'object' ? who : { email: String(who || 'system') };
    const list = (db.data.auditLog ||= []);
    list.push({ id: uid('aud'), at: new Date().toISOString(), vendorId: vendorId || u.vendorRootId || null, userId: u.id || null, who: String(u.email || 'system').slice(0, 120), role: u.role || '', action: String(action).slice(0, 80), detail: String(detail || '').slice(0, 300) });
    if (list.length > MAX) list.splice(0, list.length - MAX);
  } catch { /* never break the real action */ }
}

function listFor(vendorId, { limit = 100, before = null, action = '' } = {}) {
  let l = (db.data.auditLog || []).filter(x => x.vendorId === vendorId && (!action || x.action.startsWith(action)));
  if (before) l = l.filter(x => x.at < before);
  return l.slice(-limit).reverse();
}

module.exports = { log, listFor };
