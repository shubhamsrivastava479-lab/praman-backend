// What a vendor has bought from Praman.
//
// Each verification / investigation type is a separate "service". Super Admin
// switches services on per vendor and sets the price per case; the vendor's
// dashboard then shows a workspace only for the services they have, and the
// server refuses cases for any other service.
//
//   vendor.services      ['pivc_life', 'motor_claim']   (missing = all, for older accounts)
//   vendor.servicePrices { pivc_life: 150, motor_claim: 400 }  (₹ per case, optional)
//   case.service         'pivc_life'
const SERVICES = {
  pivc_life: {
    label: 'Life Insurance Policy Verification',
    short: 'Life PIVC',
    icon: '🛡️',
    caseType: 'policy_verification',
    policyType: 'life',
    numberLabel: 'Policy no.',
    about: 'Verifies a new life insurance policy with the customer: identity, policy and sales details, health and income disclosure, nominee. AI call takes a face photo, eye-blink check and full-body photos (standing and sitting) with location.'
  },
  pivc_term: {
    label: 'Term Insurance Policy Verification',
    short: 'Term PIVC',
    icon: '📄',
    caseType: 'policy_verification',
    policyType: 'term',
    numberLabel: 'Policy no.',
    about: 'Everything in life policy verification plus term-specific questions: sum assured, other policies, family medical history, medical tests, smoking and alcohol.'
  },
  motor_claim: {
    label: 'Motor Claim Investigation',
    short: 'Motor claim',
    icon: '🚗',
    caseType: 'claim_investigation',
    policyType: null,
    numberLabel: 'Claim no.',
    about: 'Investigates an accident or theft claim: loss details, police / FIR, vehicle, witnesses, WhatsApp chat history screenshots, documents and photos of the vehicle with location.'
  },
  health_claim: {
    label: 'Health Claim Investigation',
    short: 'Health claim',
    icon: '🏥',
    caseType: 'claim_investigation',
    policyType: 'health',
    numberLabel: 'Claim no.',
    about: 'Investigates a hospitalisation claim with the claimant on video: hospital stay, treatment and bills, past illness (pre-existing disease), other claims, WhatsApp history screenshots and documents, with policy-timing triggers in the report.'
  },
  pivc_health: {
    label: 'Health Insurance Policy Verification',
    short: 'Health PIVC',
    icon: '🩺',
    caseType: 'policy_verification',
    policyType: 'health',
    numberLabel: 'Policy no.',
    about: 'Verifies a new health policy with the proposer: identity, members covered, waiting periods explained, height and weight, illnesses of every covered member, lifestyle, other policies and portability. Face, liveness and full-body photos with location.'
  },
  bgv_employee: {
    label: 'Employee Background Verification',
    short: 'Employee BGV',
    icon: '🪪',
    caseType: 'background_verification',
    policyType: null,
    numberLabel: 'Case / employee no.',
    about: 'Video verification of a job candidate from their home: identity, current and permanent address with live location, education, employment history, gaps, criminal and dual-employment declaration, and a reference.'
  }
};
const ALL = Object.keys(SERVICES);

// Which service a case (or a create request) belongs to.
function serviceFor({ service, caseType, policyType } = {}) {
  if (service && SERVICES[service]) return service;
  const t = String(caseType || ''), pt = String(policyType || '');
  if (/bgv|background|employee|candidate/i.test(t)) return 'bgv_employee';
  if (/pivc|policy|life|term|issuance|login|proposal/i.test(t)) return /term/i.test(pt + t) ? 'pivc_term' : /health|medi/i.test(pt + t) ? 'pivc_health' : 'pivc_life';
  if (/health|hospital|medi/i.test(t + ' ' + pt)) return 'health_claim';
  return 'motor_claim';
}
const serviceOfCase = c => c.service && SERVICES[c.service] ? c.service : serviceFor({ caseType: c.caseType, policyType: c.policyType });

// The firm's own record (agents use their parent firm's services).
function firmOf(data, user) {
  if (!user) return null;
  const rootId = user.vendorRootId || user.id;
  return (data.users || []).find(u => u.id === rootId) || null;
}

// Services a logged-in user may use. Super Admin and older accounts without a
// list may use everything.
function allowedServices(data, user) {
  if (!user) return [];
  if (user.role === 'super_admin') return ALL.slice();
  const firm = firmOf(data, user);
  if (!firm) return [];
  if (firm.role === 'super_admin') return ALL.slice();
  if (!Array.isArray(firm.services)) return ALL.slice();
  return firm.services.filter(s => SERVICES[s]);
}

function publicList(keys, prices) {
  return keys.map(k => ({ key: k, ...SERVICES[k], price: prices && prices[k] != null ? prices[k] : null }));
}

// Cases per service in a month (YYYY-MM, India time) for billing.
function usage(data, vendorId, month) {
  const out = {};
  for (const c of data.cases || []) {
    if (c.vendorId !== vendorId) continue;
    const m = new Date(new Date(c.createdAt).getTime() + 5.5 * 3600e3).toISOString().slice(0, 7);
    if (m !== month) continue;
    const s = serviceOfCase(c);
    out[s] = (out[s] || 0) + 1;
  }
  return out;
}

module.exports = { SERVICES, ALL, serviceFor, serviceOfCase, allowedServices, firmOf, publicList, usage };
