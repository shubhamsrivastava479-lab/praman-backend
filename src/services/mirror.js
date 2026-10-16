// Relational mirror (PostgreSQL only).
//
// The app keeps every record as one JSON row in `praman_records` (simple, safe, one server).
// For reporting, the insurer's BI tools and ordinary SQL, the same data is also copied into
// normal tables with real columns:
//
//   praman_m_cases      one row per case (status, verdict, dates, who signed off …)
//   praman_m_evidence   one row per stored photo / document / recording (no file links)
//   praman_m_custody    one row per activity-record line
//   praman_m_users      people and companies (no passwords, no secrets)
//
// The copy is one-way (app → tables) and is refreshed a few seconds after every save. If it ever
// fails the app is not affected; it is rebuilt completely on the next start. Never write to these tables.
// Turn it off with PRAMAN_MIRROR=0.
const TABLES = {
  praman_m_cases: ['id', 'vendor_id', 'case_ref', 'claim_no', 'case_type', 'service', 'verification_mode', 'status', 'review_state', 'ai_status', 'ai_decision', 'final_verdict', 'flag_count', 'checklist_done', 'checklist_total', 'assigned_to', 'policy_value', 'legal_hold', 'erased', 'created_at', 'completed_at', 'ai_started_at', 'ai_completed_at', 'reviewed_at', 'reviewed_by'],
  praman_m_evidence: ['id', 'case_id', 'vendor_id', 'type', 'source', 'has_file', 'purged', 'received_at'],
  praman_m_custody: ['id', 'case_id', 'actor', 'event', 'at'],
  praman_m_users: ['id', 'email', 'role', 'vendor_name', 'parent_vendor_id', 'approved', 'two_step', 'created_at']
};

const DDL = [
  `create table if not exists praman_m_cases (id text primary key, vendor_id text, case_ref text, claim_no text, case_type text, service text, verification_mode text, status text, review_state text, ai_status text, ai_decision text, final_verdict text, flag_count int, checklist_done int, checklist_total int, assigned_to text, policy_value numeric, legal_hold boolean, erased boolean, created_at timestamptz, completed_at timestamptz, ai_started_at timestamptz, ai_completed_at timestamptz, reviewed_at timestamptz, reviewed_by text)`,
  `create index if not exists praman_m_cases_vendor on praman_m_cases (vendor_id, status)`,
  `create table if not exists praman_m_evidence (id text primary key, case_id text, vendor_id text, type text, source text, has_file boolean, purged boolean, received_at timestamptz)`,
  `create index if not exists praman_m_evidence_case on praman_m_evidence (case_id)`,
  `create table if not exists praman_m_custody (id text primary key, case_id text, actor text, event text, at timestamptz)`,
  `create index if not exists praman_m_custody_case on praman_m_custody (case_id)`,
  `create table if not exists praman_m_users (id text primary key, email text, role text, vendor_name text, parent_vendor_id text, approved boolean, two_step boolean, created_at timestamptz)`
];

const ts = v => { const d = v ? new Date(v) : null; return d && !isNaN(d) ? d.toISOString() : null; };
const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, '')); return isFinite(n) ? n : null; };

// Pure: turns the in-memory data into table rows (easy to test).
function rowsOf(data) {
  const ckl = require('./checklist');
  const out = { praman_m_cases: [], praman_m_evidence: [], praman_m_custody: [], praman_m_users: [] };
  for (const c of data.cases || []) {
    let sum = { done: null, total: null };
    try { if (c.aiCall) sum = ckl.summarize(ckl.buildChecklist(c)); } catch { /* keep nulls */ }
    const a = c.aiCall || {}, rv = c.aiReview || null;
    out.praman_m_cases.push({
      id: c.id, vendor_id: c.vendorId, case_ref: c.caseRef || null, claim_no: c.claimNo || null, case_type: c.caseType || null, service: c.service || null,
      verification_mode: c.verificationMode || null, status: c.status || null, review_state: c.reviewState || null, ai_status: a.status || null, ai_decision: a.decision || null,
      final_verdict: rv && rv.finalVerdict !== 'pending_verification' ? rv.finalVerdict : null, flag_count: (a.flags || []).length, checklist_done: sum.done, checklist_total: sum.total,
      assigned_to: c.assignedAgentId || c.assignedTo || null, policy_value: num(c.policyValue), legal_hold: !!c.legalHold, erased: !!c.erasedAt,
      created_at: ts(c.createdAt), completed_at: ts(c.completedAt), ai_started_at: ts(a.startedAt), ai_completed_at: ts(a.completedAt), reviewed_at: ts(rv && rv.reviewedAt), reviewed_by: rv ? (rv.reviewedByLogin || rv.reviewerName || null) : null
    });
  }
  for (const e of data.evidence || []) out.praman_m_evidence.push({ id: e.id, case_id: e.caseId || null, vendor_id: e.vendorId || null, type: e.type || null, source: e.source || null, has_file: !!e.fileUrl, purged: !!e.purgedAt, received_at: ts(e.receivedAt) });
  for (const x of data.custody || []) out.praman_m_custody.push({ id: x.id, case_id: x.caseId || null, actor: x.actor || null, event: String(x.event || '').slice(0, 1000), at: ts(x.timestamp) });
  for (const u of data.users || []) out.praman_m_users.push({ id: u.id, email: u.email || null, role: u.role || 'vendor_admin', vendor_name: u.vendorName || null, parent_vendor_id: u.parentVendorId || null, approved: u.approved !== false, two_step: !!u.totpEnabled, created_at: ts(u.createdAt) });
  return out;
}

const state = { sig: new Map(), ready: false, timer: null, running: false, last: null, error: null };

async function ensure(pool) {
  for (const q of DDL) await pool.query(q);
  state.ready = true;
}

// Copies what changed since the last pass.
async function sync(pool, data) {
  if (!state.ready) await ensure(pool);
  const rows = rowsOf(data);
  let up = 0, del = 0;
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const [table, cols] of Object.entries(TABLES)) {
      const seen = new Set(), changed = [];
      for (const r of rows[table]) {
        if (!r.id) continue;
        const k = table + '\0' + r.id; seen.add(k);
        const s = JSON.stringify(r);
        if (state.sig.get(k) !== s) { changed.push(r); state.sig.set(k, s); }
      }
      for (let i = 0; i < changed.length; i += 500) {
        const part = changed.slice(i, i + 500);
        const set = cols.filter(c => c !== 'id').map(c => `${c} = excluded.${c}`).join(', ');
        await client.query(`insert into ${table} (${cols.join(', ')}) select ${cols.join(', ')} from jsonb_populate_recordset(null::${table}, $1::jsonb) on conflict (id) do update set ${set}`, [JSON.stringify(part)]);
        up += part.length;
      }
      const gone = [...state.sig.keys()].filter(k => k.startsWith(table + '\0') && !seen.has(k));
      for (let i = 0; i < gone.length; i += 1000) {
        const ids = gone.slice(i, i + 1000).map(k => k.split('\0')[1]);
        await client.query(`delete from ${table} where id = any($1::text[])`, [ids]);
        del += ids.length;
      }
      gone.forEach(k => state.sig.delete(k));
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    state.sig.clear();      // start over next time
    throw e;
  } finally { client.release(); }
  return { up, del };
}

// Called after every successful save: refreshes the tables a few seconds later (one pass at a time).
function schedule(db) {
  if (process.env.PRAMAN_MIRROR === '0' || db.mode !== 'postgres' || state.timer) return;
  state.timer = setTimeout(async () => {
    state.timer = null;
    if (state.running) return schedule(db);
    state.running = true;
    try { state.last = { at: new Date().toISOString(), ...(await sync(db.store.pool, db.data)) }; state.error = null; }
    catch (e) { state.error = { at: new Date().toISOString(), message: e.message }; console.error('Relational mirror failed (the app is not affected):', e.message); }
    finally { state.running = false; }
  }, 4000);
  state.timer.unref();
}

module.exports = { rowsOf, sync, schedule, ensure, state, TABLES };
