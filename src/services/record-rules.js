// Rules that compare a case with the firm's OTHER cases, and rules on the stored files.
// Exact matching only (after removing spaces, dots and capital letters), so the same input
// always gives the same answer. Nothing here is AI. Only cases of the same firm are compared.
const ff = require('./file-facts');
const { toDate, days, ageOn } = require('./service-profiles');

const norm = v => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');
const refOf = c => c.caseRef || c.claimNo || c.id;
const listRefs = arr => arr.slice(0, 4).map(refOf).join(', ') + (arr.length > 4 ? ` and ${arr.length - 4} more` : '');
const CLAIMS = new Set(['health_claim', 'motor_claim']);
const svcOf = c => require('./plans').serviceOfCase(c);
const dateOf = c => toDate((c.details || {}).admissionDate) || toDate((c.details || {}).incidentDate) || (c.createdAt ? new Date(c.createdAt) : null);
const within = (a, b, n) => a && b && Math.abs(days(a, b)) <= n;
const isBad = c => (c.aiReview && ['found_discrepancy', 'unverified'].includes(c.aiReview.finalVerdict)) || (!c.aiReview && c.aiCall && c.aiCall.decision === 'found_discrepancy');

// Programs whose name in a PDF / photo shows it was made or changed in an editor.
const EDITORS = /photoshop|gimp|canva|picsart|snapseed|lightroom|pixlr|fotor|ilovepdf|smallpdf|sejda|pdfescape|pdf-?xchange|foxit phantom|nitro|pdfelement|wondershare|inkscape|coreldraw|illustrator|paint\.net|microsoft word|libreoffice|google docs|wps/i;

function crossCase(c, data) {
  const out = [], add = (label, state, detail, area) => out.push({ label, state, detail, source: 'record', ...(area ? { area } : {}) });
  const svc = svcOf(c), d = c.details || {}, me = dateOf(c);
  const others = (data.cases || []).filter(o => o.id !== c.id && o.vendorId === c.vendorId);

  const wa = norm(c.whatsappNumber);
  if (wa) {
    const diff = others.filter(o => norm(o.whatsappNumber) === wa && norm(o.insuredName) && norm(c.insuredName) && norm(o.insuredName) !== norm(c.insuredName));
    if (diff.length) add('Same WhatsApp number, different person', 'focus', `This number is also on ${listRefs(diff)} under another name`);
  }
  if (CLAIMS.has(svc)) {
    const pol = norm(c.policyNo);
    if (pol) {
      const same = others.filter(o => CLAIMS.has(svcOf(o)) && norm(o.policyNo) === pol && within(dateOf(o), me, 365));
      add('Other claims on this policy (12 months)', same.length >= 2 ? 'focus' : same.length ? 'check' : 'clear', same.length ? `${same.length} other claim${same.length > 1 ? 's' : ''}: ${listRefs(same)}` : 'No other claim on this policy number');
    }
  }
  if (svc === 'motor_claim' && norm(c.vehicleNo)) {
    const same = others.filter(o => svcOf(o) === 'motor_claim' && norm(o.vehicleNo) === norm(c.vehicleNo) && within(dateOf(o), me, 365));
    add('Other claims on this vehicle (12 months)', same.length >= 2 ? 'focus' : same.length ? 'check' : 'clear', same.length ? `${same.length} other claim${same.length > 1 ? 's' : ''}: ${listRefs(same)}` : 'No other claim on this vehicle number');
  }
  if (svc === 'motor_claim' && norm(d.garageName)) {
    const same = others.filter(o => svcOf(o) === 'motor_claim' && norm((o.details || {}).garageName) === norm(d.garageName) && within(dateOf(o), me, 30));
    add('Claims from this garage (30 days)', same.length >= 4 ? 'check' : 'clear', `${same.length} other claim${same.length === 1 ? '' : 's'} from ${d.garageName} within 30 days`);
  }
  if (svc === 'health_claim' && norm(d.hospitalName)) {
    const same = others.filter(o => svcOf(o) === 'health_claim' && norm((o.details || {}).hospitalName) === norm(d.hospitalName) && within(dateOf(o), me, 30));
    const bad = same.filter(isBad);
    add('Claims from this hospital (30 days)', bad.length >= 2 ? 'focus' : same.length >= 3 ? 'check' : 'clear',
      `${same.length} other claim${same.length === 1 ? '' : 's'} from ${d.hospitalName} within 30 days${bad.length ? `, ${bad.length} with a discrepancy` : ''}`);
  }
  if (norm(d.agentName)) {
    const same = others.filter(o => norm((o.details || {}).agentName) === norm(d.agentName));
    const bad = same.filter(isBad);
    if (same.length) {
      const share = bad.length / same.length;
      add('Track record of this agent', bad.length >= 3 && share >= 0.3 ? 'focus' : bad.length >= 2 ? 'check' : 'clear',
        `${bad.length} of ${same.length} other case${same.length > 1 ? 's' : ''} of agent ${d.agentName} had a discrepancy`, 'sales');
      if (/^pivc_/.test(svc)) {
        const seniors = same.filter(o => { const g = ageOn((o.details || {}).dob); return g != null && g >= 60; });
        if (seniors.length >= 3) add('Agent with many senior customers', 'check', `${seniors.length} other customers of agent ${d.agentName} are 60 or older`, 'sales');
      }
    }
  }
  return out;
}

// Files of this case: exact same file in another case, and what the file itself says.
function fileRules(c, data, evidence) {
  const out = [], add = (label, state, detail) => out.push({ label, state, detail, source: 'record', area: 'docs' });
  const mine = (evidence || []).filter(e => e.fileUrl && !e.purgedAt);
  if (!mine.length) return out;
  const hashOf = e => e.sha256 || (ff.factsFor(e.fileUrl) || {}).sha256 || null;
  // index of other cases' files of the same firm
  const byHash = new Map();
  const caseById = new Map((data.cases || []).map(x => [x.id, x]));
  for (const e of data.evidence || []) {
    if (!e.caseId || e.caseId === c.id || !e.fileUrl || e.purgedAt) continue;
    const o = caseById.get(e.caseId); if (!o || o.vendorId !== c.vendorId) continue;
    const h = hashOf(e); if (!h) continue;
    (byHash.get(h) || byHash.set(h, new Set()).get(h)).add(o);
  }
  let checked = 0, dup = 0;
  const caseStart = c.createdAt ? new Date(c.createdAt) : null;
  for (const e of mine) {
    const h = hashOf(e); if (!h) continue;
    checked++;
    const what = e.fileName || (e.type === 'image' ? 'A photo' : e.type === 'document' ? 'A document' : 'A file');
    const hit = byHash.get(h);
    if (hit && hit.size) { dup++; add('Exact same file in another case', 'focus', `${what} (received ${String(e.receivedAt || '').slice(0, 10)}) is the exact same file as in ${listRefs([...hit])}`); }
    const f = ff.factsFor(e.fileUrl) || {};
    if (f.pdf) {
      const p = f.pdf;
      if (p.producer && EDITORS.test(p.producer + ' ' + (p.creator || ''))) add('PDF made with an editing program', 'check', `${what}: made with "${[p.creator, p.producer].filter(Boolean).join(' / ')}"`);
      if (p.created && p.modified && Date.parse(p.modified + 'Z') - Date.parse(p.created + 'Z') > 60000) add('PDF changed after it was made', 'check', `${what}: made ${p.created.replace('T', ' ')}, changed ${p.modified.replace('T', ' ')}`);
      if (p.saves > 1) add('PDF saved more than once', 'check', `${what}: the file holds ${p.saves} saved versions`);
    }
    if (f.exif) {
      const x = f.exif;
      if (x.software && EDITORS.test(x.software)) add('Photo edited in an app', 'check', `${what}: last saved with "${x.software}"`);
      const taken = x.taken ? new Date(x.taken + 'Z') : null;
      if (taken && caseStart && days(taken, caseStart) > 1) add('Photo taken before the case', 'check', `${what}: taken on ${x.taken.slice(0, 10)}, the case was opened on ${c.createdAt.slice(0, 10)}`);
    }
  }
  if (checked && !dup) add('Exact same file in another case', 'clear', `${checked} file${checked > 1 ? 's' : ''} compared with the firm's other cases: no copy found`);
  if (!checked) add('Exact same file in another case', 'none', 'Files of this case are still being fingerprinted');
  return out;
}

module.exports = { crossCase, fileRules, norm, EDITORS };
