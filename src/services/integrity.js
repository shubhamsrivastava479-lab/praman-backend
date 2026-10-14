// Data integrity check — every record has a unique id, every document /
// event belongs to a case that exists (and to the same firm), case numbers
// and claim numbers are not duplicated. Used by Super Admin → Database.
const { normRef } = require('./ids');

function checkIntegrity(data) {
  const problems = [];
  const add = (kind, detail) => { if (problems.length < 200) problems.push({ kind, detail }); };
  const counts = {};

  for (const [col, list] of Object.entries(data)) {
    if (!Array.isArray(list)) continue;
    counts[col] = list.length;
    if (col === 'phoneOtps') continue; // keyed by case, not by id
    const seen = new Set();
    for (const r of list) {
      if (!r || !r.id) { add('missing id', `${col}: a record has no id`); continue; }
      if (seen.has(r.id)) add('duplicate id', `${col}: ${r.id}`);
      seen.add(r.id);
    }
  }

  const cases = data.cases || [];
  const byId = new Map(cases.map(c => [c.id, c]));
  const refs = new Map(), claims = new Map();
  for (const c of cases) {
    if (!c.caseRef) add('case without case no.', c.id);
    else if (refs.has(c.caseRef)) add('duplicate case no.', `${c.caseRef}: ${refs.get(c.caseRef)} and ${c.id}`);
    else refs.set(c.caseRef, c.id);
    const k = c.vendorId + '|' + normRef(c.claimNo);
    if (claims.has(k)) add('duplicate claim no. in one firm', `${c.claimNo}: ${claims.get(k)} and ${c.caseRef || c.id}`);
    else claims.set(k, c.caseRef || c.id);
    if (!c.vendorId) add('case without firm', c.caseRef || c.id);
  }

  let unassigned = 0;
  for (const e of data.evidence || []) {
    if (e.unassigned) {
      unassigned++;
      if (!e.vendorId) add('unassigned item without firm', e.id);
      continue;
    }
    const c = byId.get(e.caseId);
    if (!c) { add('document linked to a missing case', `${e.id} -> ${e.caseId}`); continue; }
    if (e.vendorId && e.vendorId !== c.vendorId) add('document firm differs from case firm', e.id);
    if (e.fileUrl && /\/cases\/[^/]+\//.test(e.fileUrl) && !e.fileUrl.includes(`/cases/${c.id}/`)) add('file stored in another case\'s folder', `${e.id} (case ${c.caseRef})`);
  }
  for (const col of ['custody', 'transcripts', 'reports']) {
    for (const r of data[col] || []) if (r.caseId && !byId.has(r.caseId)) add(`${col} entry linked to a missing case`, `${r.id} -> ${r.caseId}`);
  }
  return { ok: problems.length === 0, problems, counts, unassigned, checkedAt: new Date().toISOString() };
}

module.exports = { checkIntegrity };
