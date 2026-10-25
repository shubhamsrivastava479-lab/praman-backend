// A firm's own version of the checklist, per service:
//   firm.checklistConfig[serviceKey] = { skip: [stepId], mandatory: [stepId], extra: [{ key, text }] }
//   skip       default questions / body photos / WhatsApp-history steps the firm does not want asked
//   mandatory  items that MUST be done: if one is missing the call can never end as "verified"
//   extra      the firm's own extra questions (asked after the standard questions)
// Identity steps (name, confirmations, face, blink, Aadhaar, PAN) can never be skipped.
const plans = require('./plans');

const CORE = id => id === 'name' || id === 'closing' || id.startsWith('confirm_') || ['face', 'blink', 'aadhaar', 'pan'].includes(id);
const MAX_EXTRA = 15;
const clean = (t, n) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, n);

function normalize(raw) {
  const r = raw || {};
  const ids = v => [...new Set((Array.isArray(v) ? v : []).map(x => clean(x, 60)).filter(x => /^[a-z0-9_]+$/i.test(x)))];
  const extra = [];
  for (const e of (Array.isArray(r.extra) ? r.extra : [])) {
    const text = clean(e && e.text, 300);
    if (!text) continue;
    let key = clean(e.key, 40).toLowerCase().replace(/[^a-z0-9_]/g, '') || 'x' + (extra.length + 1) + Math.random().toString(36).slice(2, 6);
    if (extra.some(x => x.key === key)) key += extra.length;
    extra.push({ key, text });
    if (extra.length >= MAX_EXTRA) break;
  }
  return { skip: ids(r.skip).filter(id => !CORE(id)), mandatory: ids(r.mandatory), extra };
}

const forService = (firm, key) => normalize(firm && firm.checklistConfig && firm.checklistConfig[key]);
const forCase = (firm, c) => forService(firm, plans.serviceOfCase(c));

// What the editor shows: every default step of the service, plus the firm's choices.
function catalog(serviceKey, firm) {
  const engine = require('./ai-call-engine');
  const s = plans.SERVICES[serviceKey];
  const probe = { service: serviceKey, caseType: s.caseType, policyType: s.policyType, claimNo: 'X', policyNo: 'Y', insuredName: 'X', vehicleNo: serviceKey === 'motor_claim' ? 'X' : '', district: 'X' };
  const cfg = forService(firm, serviceKey);
  const items = engine.buildQueue(probe, { skip: [], extra: [] }).filter(x => x.type !== 'close').map(x => ({
    id: x.id, section: x.section || '', type: x.type, core: CORE(x.id),
    label: x.type === 'confirm' ? `Confirm ${x.label} from your records` : x.text.length > 140 ? x.text.slice(0, 139) + '…' : x.text,
    asked: !cfg.skip.includes(x.id) || CORE(x.id), mandatory: cfg.mandatory.includes(x.id)
  }));
  return { service: serviceKey, label: s.label, items, extra: cfg.extra.map(e => ({ ...e, id: 'q_' + e.key, mandatory: cfg.mandatory.includes('q_' + e.key) })) };
}

module.exports = { CORE, normalize, forService, forCase, catalog, MAX_EXTRA };
