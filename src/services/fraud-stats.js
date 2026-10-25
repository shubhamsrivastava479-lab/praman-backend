// Fraud dashboard numbers for one firm. Counting and averages only: every number
// can be traced back to the cases it came from.
const plans = require('./plans');
const profiles = require('./service-profiles');
const rules = require('./record-rules');

const RESULT = c => (c.aiReview && c.aiReview.finalVerdict && c.aiReview.finalVerdict !== 'pending_verification') ? c.aiReview.finalVerdict : (c.aiCall && c.aiCall.decision) || null;
const BAD = new Set(['found_discrepancy', 'unverified']);

function build(data, vendorId, { days = 90, now = new Date() } = {}) {
  const since = now.getTime() - days * 864e5;
  const all = (data.cases || []).filter(c => c.vendorId === vendorId);
  const cases = all.filter(c => new Date(c.createdAt).getTime() >= since);
  const evByCase = new Map();
  for (const e of data.evidence || []) if (e.caseId) (evByCase.get(e.caseId) || evByCase.set(e.caseId, []).get(e.caseId)).push(e);

  const totals = { cases: cases.length, focus: 0, check: 0, clear: 0, noData: 0, results: {}, overdue: 0, open: 0 };
  const byService = {}, trig = {}, ent = { hospital: {}, garage: {}, agent: {}, vehicle: {} };
  const tat = [];
  for (const c of cases) {
    const svc = plans.serviceOfCase(c);
    const s = byService[svc] || (byService[svc] = { service: svc, label: plans.SERVICES[svc].short, cases: 0, focus: 0, discrepancy: 0 });
    s.cases++;
    const r = RESULT(c); if (r) totals.results[r] = (totals.results[r] || 0) + 1;
    if (BAD.has(r)) s.discrepancy++;
    const list = [...profiles.triggers(svc, c), ...rules.crossCase(c, data), ...rules.fileRules(c, data, evByCase.get(c.id) || [])];
    const worst = list.some(x => x.state === 'focus') ? 'focus' : list.some(x => x.state === 'check') ? 'check' : list.some(x => x.state === 'clear') ? 'clear' : 'noData';
    totals[worst]++; if (worst === 'focus') s.focus++;
    for (const x of list) {
      if (x.state !== 'focus' && x.state !== 'check') continue;
      const k = x.label; const t = trig[k] || (trig[k] = { label: k, focus: 0, check: 0 }); t[x.state]++;
    }
    const d = c.details || {};
    const bump = (kind, name) => {
      const key = rules.norm(name); if (!key) return;
      const e = ent[kind][key] || (ent[kind][key] = { name: String(name).trim(), cases: 0, discrepancy: 0, focus: 0 });
      e.cases++; if (BAD.has(r)) e.discrepancy++; if (worst === 'focus') e.focus++;
    };
    if (svc === 'health_claim') bump('hospital', d.hospitalName);
    if (svc === 'motor_claim') { bump('garage', d.garageName); bump('vehicle', c.vehicleNo); }
    bump('agent', d.agentName);
    const done = c.completedAt || (c.aiReview && c.aiReview.reviewedAt) || null;
    if (done) tat.push((new Date(done) - new Date(c.createdAt)) / 3600e3);
    else { totals.open++; if (c.dueAt && new Date(c.dueAt) < now) totals.overdue++; }
  }
  const top = o => Object.values(o).sort((a, b) => b.focus - a.focus || b.discrepancy - a.discrepancy || b.cases - a.cases).slice(0, 10);
  const sorted = tat.slice().sort((a, b) => a - b);
  return {
    days, since: new Date(since).toISOString(),
    totals,
    tat: { finished: tat.length, averageHours: tat.length ? +(tat.reduce((a, b) => a + b, 0) / tat.length).toFixed(1) : null, medianHours: sorted.length ? +sorted[Math.floor(sorted.length / 2)].toFixed(1) : null },
    byService: Object.values(byService).sort((a, b) => b.cases - a.cases),
    triggers: Object.values(trig).sort((a, b) => (b.focus * 2 + b.check) - (a.focus * 2 + a.check)).slice(0, 15),
    hospitals: top(ent.hospital), garages: top(ent.garage), agents: top(ent.agent), vehicles: top(ent.vehicle).filter(v => v.cases > 1)
  };
}

module.exports = { build };
