// One place that says what is different for each service:
//   - the questions the AI asks (by section),
//   - how the report is laid out: its title, result words, the areas on page 1,
//     the facts shown at the top, the trigger rules and the suggested next steps.
// The rest of the call (face photo, liveness, live code, Aadhaar, PAN) is the same for all.
//
// Trigger rules use only what is in the case record (Excel details, dates, amounts) and what
// the call found. They raise points for a person to look at. They never decide a case.

// ---------- question banks: [section, key, text] ----------
const LIFE_PIVC = [
  ['identity', 'dob', 'Please tell me your date of birth.'],
  ['identity', 'address', 'What is your current residential address?'],
  ['policyDetails', 'applied_self', 'Did you apply for this policy yourself?'],
  ['policyDetails', 'explained_by', 'Who explained this policy to you? Was it a person from the company or an agent?'],
  ['policyDetails', 'premium', 'Do you know how much premium you will pay and how often?'],
  ['policyDetails', 'term', 'For how many years will you pay the premium?'],
  ['policyDetails', 'promises', 'Did anyone promise you guaranteed returns, or ask you to pay in cash?'],
  ['policyDetails', 'signed_self', 'Did you sign the proposal form yourself?'],
  ['healthDisclosure', 'illness', 'Do you have any existing illness, for example diabetes, high blood pressure, or heart disease?'],
  ['healthDisclosure', 'surgery', 'Have you had any surgery or hospital admission in the last five years?'],
  ['healthDisclosure', 'tobacco', 'Do you smoke or use tobacco or alcohol?'],
  ['healthDisclosure', 'medicines', 'Are you currently taking any regular medicines?'],
  ['healthDisclosure', 'disclosed', 'Were all these health details correctly written in your proposal form?'],
  ['incomeOccupation', 'occupation', 'What is your occupation?'],
  ['incomeOccupation', 'income', 'What is your approximate annual income?'],
  ['nominee', 'nominee', 'Who is the nominee in your policy, and what is their relationship with you?'],
  ['identity', 'age', 'To confirm, how old are you, in years?']
];
// Term plans: large cover, low premium, so mis-selling and non-disclosure of health / income /
// other policies are the main risks.
const TERM_EXTRA = [
  ['policyDetails', 'sum_assured', 'What is the total cover amount, that is the sum assured, of this term policy?'],
  ['policyDetails', 'cover_reason', 'Why did you choose this much cover? For example, for a loan or for your family.'],
  ['policyDetails', 'no_maturity', 'Do you understand that this is a term plan, and no money is paid back if you survive the policy term?'],
  ['policyDetails', 'riders', 'Does your policy have any extra rider, like accidental death or critical illness cover?'],
  ['incomeOccupation', 'income_proof', 'Did you give your income proof, like ITR or salary slip, yourself?'],
  ['incomeOccupation', 'hazardous', 'Does your work or any hobby involve risk, for example driving heavy vehicles, mining, working at heights, or adventure sports?'],
  ['incomeOccupation', 'other_policies', 'Do you have any other life or term insurance policy, with this or any other company? If yes, what is the total cover?'],
  ['healthDisclosure', 'medical_test', 'Was a medical test done for this policy? If yes, where was it done?'],
  ['healthDisclosure', 'family_history', 'Did your parents, brothers or sisters have heart disease, cancer or diabetes before the age of sixty?'],
  ['healthDisclosure', 'rejected_before', 'In the last few years, was any insurance application of yours rejected or postponed?'],
  ['nominee', 'nominee_aware', 'Does your nominee know that this policy is in their name?']
];
// Health policy at issue: the big risk is a pre-existing illness that is not declared, for the
// proposer or any family member covered; then mis-selling (waiting periods not explained).
const HEALTH_PIVC = [
  ['identity', 'dob', 'Please tell me your date of birth.'],
  ['identity', 'address', 'What is your current residential address?'],
  ['policyDetails', 'applied_self', 'Did you apply for this health policy yourself?'],
  ['policyDetails', 'explained_by', 'Who explained this policy to you? Was it a person from the company or an agent?'],
  ['policyDetails', 'members', 'Which family members are covered in this policy?'],
  ['policyDetails', 'sum_insured', 'What is the sum insured, that is the cover amount, of this policy?'],
  ['policyDetails', 'premium', 'How much premium are you paying, and is it yearly or monthly?'],
  ['policyDetails', 'waiting', 'Were you told that some illnesses, and illnesses you already have, are covered only after a waiting period?'],
  ['policyDetails', 'promises', 'Did anyone promise that every illness will be covered from day one, or ask you to pay in cash?'],
  ['policyDetails', 'signed_self', 'Did you fill and sign the proposal form yourself?'],
  ['healthDisclosure', 'height_weight', 'What is your height and your weight?'],
  ['healthDisclosure', 'illness', 'Do you have diabetes, high blood pressure, thyroid, heart, kidney, liver or any long term illness? Since when?'],
  ['healthDisclosure', 'medicines', 'Are you taking any regular medicines? For what?'],
  ['healthDisclosure', 'surgery', 'Have you had any surgery or hospital admission in the last five years?'],
  ['healthDisclosure', 'tests_advised', 'Has any doctor advised you a test, surgery or admission that is still pending?'],
  ['healthDisclosure', 'member_health', 'Does any other family member covered in this policy have an illness or take regular medicine?'],
  ['healthDisclosure', 'disclosed', 'Were all these health details correctly written in your proposal form?'],
  ['lifestyle', 'tobacco', 'Do you or any covered family member smoke, chew tobacco, or drink alcohol? How often?'],
  ['lifestyle', 'occupation', 'What is your occupation?'],
  ['otherPolicies', 'other_health', 'Do you have, or did you have, any other health insurance? Was any claim made on it?'],
  ['otherPolicies', 'portability', 'Is this a new policy, or are you moving from another insurance company?'],
  ['identity', 'age', 'To confirm, how old are you, in years?']
];
const MOTOR_CLAIM = [
  ['lossDetails', 'when', 'On what date and at what time did the accident or loss happen?'],
  ['lossDetails', 'where', 'At what place did it happen? Please tell me the exact location.'],
  ['lossDetails', 'how', 'Please explain in your own words how it happened.'],
  ['lossDetails', 'purpose', 'For what purpose was the vehicle being used at that time, for example personal use, taxi, or carrying goods?'],
  ['driver', 'driver', 'Who was driving the vehicle at that time?'],
  ['driver', 'licence', 'Does the driver have a valid driving licence for this type of vehicle?'],
  ['lossDetails', 'injuries', 'Was anyone injured, or was any other vehicle or person involved?'],
  ['police', 'fir', 'Was a police complaint or FIR registered? If yes, at which police station?'],
  ['lossDetails', 'intimation', 'When did you inform the insurance company about this?'],
  ['vehicle', 'location', 'Where is the vehicle right now?'],
  ['vehicle', 'repair', 'Has the vehicle been repaired? If yes, at which garage?'],
  ['vehicle', 'previous_damage', 'Did the vehicle have any old damage, or any earlier insurance claim, before this incident?'],
  ['witness', 'witness', 'Were there any witnesses to the incident?']
];
// Health claim: did the hospitalisation happen as billed, was it needed, and was the illness
// there before the policy started.
const HEALTH_CLAIM = [
  ['hospitalStay', 'patient', 'Who was the patient, and what is their relationship with you?'],
  ['hospitalStay', 'symptoms', 'What problem or symptoms did the patient have, and since when?'],
  ['hospitalStay', 'first_doctor', 'Which doctor did you first show this problem to, and when?'],
  ['hospitalStay', 'hospital', 'In which hospital was the patient admitted, and in which city?'],
  ['hospitalStay', 'admit_dates', 'On what date was the patient admitted, and on what date discharged?'],
  ['hospitalStay', 'admit_how', 'How did you reach the hospital, and who advised the admission?'],
  ['hospitalStay', 'room', 'Where was the patient kept, for example general ward, private room, or ICU?'],
  ['treatment', 'treatment', 'What treatment or surgery was done in the hospital?'],
  ['treatment', 'tests', 'Which tests were done, for example blood test, X-ray, or scan?'],
  ['treatment', 'bill_paid', 'What was the total hospital bill, and how much did you pay yourself?'],
  ['treatment', 'pharmacy', 'Were the medicines bought from the hospital pharmacy or from outside?'],
  ['pastHistory', 'past_illness', 'Did the patient have this problem, or anything related to it, before this policy started?'],
  ['pastHistory', 'chronic', 'Does the patient have diabetes, high blood pressure, heart, kidney or any long term illness? Since when?'],
  ['pastHistory', 'past_admission', 'Was the patient admitted to any hospital in the last five years? For what?'],
  ['pastHistory', 'habits', 'Does the patient smoke, drink alcohol, or use tobacco?'],
  ['policyInfo', 'other_policy', 'Do you have any other health insurance, or did you claim for this treatment anywhere else?'],
  ['policyInfo', 'agent_help', 'Did any agent, hospital staff, or other person help you to file this claim?']
];
// Employee background verification: the candidate confirms identity, address, education,
// work history, gaps and a criminal declaration on video, from where they live.
const BGV = [
  ['identity', 'dob', 'Please tell me your date of birth.'],
  ['identity', 'father_name', "What is your father's full name?"],
  ['address', 'current_address', 'What is your current address, and since when have you lived there?'],
  ['address', 'at_address', 'Are you at this address right now?'],
  ['address', 'permanent_address', 'What is your permanent address?'],
  ['education', 'qualification', 'What is your highest qualification, from which college or university, and in which year did you pass?'],
  ['education', 'roll_no', 'What was your roll number or registration number for that course?'],
  ['employment', 'current_employer', 'Where are you working now, or where did you work last? What was your designation?'],
  ['employment', 'emp_dates', 'From which month and year, to which month and year, did you work there?'],
  ['employment', 'salary', 'What was your last monthly salary?'],
  ['employment', 'leaving', 'Why did you leave, or why are you leaving, that job?'],
  ['employment', 'manager', 'What is the name of your reporting manager there?'],
  ['employment', 'previous_employer', 'Before that, where did you work, and for how long?'],
  ['gaps', 'gap', 'Was there any time when you were not studying or working? What were you doing then?'],
  ['declaration', 'criminal', 'Has any police case or court case ever been filed against you?'],
  ['declaration', 'dual', 'Are you working anywhere else at the moment, full time or part time?'],
  ['references', 'reference', 'Please tell me the name and phone number of one person who can confirm your work, like a former manager or colleague.'],
  ['identity', 'age', 'To confirm, how old are you, in years?']
];

const SECTION_LABELS = {
  identity: 'Identity', policyDetails: 'Policy details and sales practice', healthDisclosure: 'Health disclosure',
  incomeOccupation: 'Income and occupation', nominee: 'Nominee', lossDetails: 'Incident details', police: 'Police / FIR',
  vehicle: 'Vehicle', witness: 'Witnesses', driver: 'Driver and licence', chatHistory: 'WhatsApp history check',
  hospitalStay: 'Hospital stay', treatment: 'Treatment and bills', pastHistory: 'Past illness', policyInfo: 'Other claims and help',
  lifestyle: 'Lifestyle and occupation', otherPolicies: 'Other policies', address: 'Address', education: 'Education',
  employment: 'Employment', gaps: 'Gaps', declaration: 'Declarations', references: 'References', custom: 'Additional questions'
};

// ---------- report areas ----------
// Each area: [key, label, rule]. A rule may name check ids (regex), answer keys, answer
// sections, and built-in sources: docs, location, chats, triggers, signoff.
const A = {
  identity: ['identity', 'Identity', { checks: /^(name_|aadhaar|pan_|dob_aadhaar|dob_spoken|confirm_)/, keys: ['dob', 'address', 'age', 'father_name'] }],
  face: ['face', 'Face and liveness', { checks: /^(face_|blink|challenge|live_code)/ }],
  body: ['body', 'Body photos and age', { checks: /^body_/ }],
  docs: ['docs', 'Documents', { checks: /^(id_tamper_|doc_)/, src: ['docs'] }],
  docsChats: ['docs', 'Documents and chats', { checks: /^(id_tamper_|doc_|chat)/, src: ['docs'] }],
  docsTriggers: ['docs', 'Documents and triggers', { checks: /^(id_tamper_|doc_)/, src: ['docs', 'triggers'] }],
  location: ['location', 'Location / device', { checks: /^(location|device)/, src: ['location'] }],
  triggers: ['triggers', 'Policy timing and triggers', { src: ['triggers'] }],
  signoff: ['signoff', 'Reviewer sign-off', { src: ['signoff'] }]
};
const area = (key, label, rule) => [key, label, rule];

const CLAIM_VERDICT = { verified: 'No adverse findings', partially_verified: 'Needs more checks', found_discrepancy: 'Adverse findings', unverified: 'Could not verify', pending_verification: 'Pending review', handoff: 'Handed to an executive' };
const PIVC_VERDICT = { verified: 'Clean: no issue found', partially_verified: 'Needs follow-up', found_discrepancy: 'Discrepancy found', unverified: 'Could not verify', pending_verification: 'Pending review', handoff: 'Handed to an executive' };
const BGV_VERDICT = { verified: 'Green: verified', partially_verified: 'Amber: with exceptions', found_discrepancy: 'Red: discrepancy', unverified: 'Grey: insufficient', pending_verification: 'Pending review', handoff: 'Handed to an executive' };

const PIVC_SALES = ['applied_self', 'explained_by', 'promises', 'signed_self'];

const PROFILES = {
  health_claim: {
    title: 'Health claim investigation report', person: 'Claimant', verdict: CLAIM_VERDICT,
    questions: () => HEALTH_CLAIM, order: ['identity', 'hospitalStay', 'treatment', 'pastHistory', 'policyInfo', 'custom'],
    chats: ['hospital', 'admit', 'bill', 'doctor'],
    areas: [A.identity, A.face, area('stay', 'Hospital stay', { sections: ['hospitalStay'] }), area('treatment', 'Treatment and bills', { sections: ['treatment'] }),
      area('history', 'Past illness (PED)', { sections: ['pastHistory'] }), area('other', 'Other claims and help', { sections: ['policyInfo'] }),
      A.triggers, A.docsChats, A.location, A.signoff],
    facts: d => [['Hospital', d.hospitalName], ['Admitted / discharged', [d.admissionDate, d.dischargeDate].filter(Boolean).join(' to ')], ['Diagnosis', d.diagnosis], ['Claim amount', money(d.claimAmount)], ['Claim type', d.claimType]],
    next: {
      focus: ['Field visit to the hospital: indoor case papers, nursing and medicine charts, OT notes, original file',
        'Match pharmacy and lab bills with prescriptions and test reports', 'Meet the treating doctor: diagnosis, duration of illness, need for admission',
        'Collect past treatment records (family doctor, earlier hospital) for pre-existing illness', 'Check other claims for this patient through IIB and other insurers'],
      check: ['Ask the claimant for the missing or unclear documents', 'Call the hospital billing desk to confirm admission and discharge dates'],
      clear: ['No adverse findings in the digital check. Process the claim as per policy terms.']
    }
  },
  motor_claim: {
    title: 'Motor claim investigation report', person: 'Claimant', verdict: CLAIM_VERDICT,
    questions: () => MOTOR_CLAIM, order: ['identity', 'lossDetails', 'driver', 'police', 'vehicle', 'witness', 'custom'],
    chats: null, // built from the vehicle number (ai-call-engine)
    areas: [A.identity, A.face, area('incident', 'Incident story', { sections: ['lossDetails', 'witness'] }), area('driver', 'Driver and licence', { sections: ['driver'] }),
      area('police', 'Police / FIR', { sections: ['police'] }), area('vehicle', 'Vehicle and repair', { sections: ['vehicle'] }),
      A.triggers, A.docsChats, A.location, A.signoff],
    facts: (d, c) => [['Vehicle', [c.vehicleNo, d.vehicleMake].filter(Boolean).join(', ')], ['Incident', [d.incidentDate, d.incidentPlace].filter(Boolean).join(', ')], ['Claim type', d.claimType], ['Claim amount', money(d.claimAmount)]],
    next: {
      focus: ['Spot survey of the vehicle and the place of the incident', 'Verify the FIR / GD entry at the police station', 'Verify the driving licence and RC on Parivahan / Vahan',
        'Check the repair estimate and any old damage with the garage', 'Check earlier claims on this vehicle'],
      check: ['Ask the claimant for the missing documents (FIR copy, DL, RC, repair estimate)', 'Call the garage to confirm when the vehicle came in'],
      clear: ['No adverse findings in the digital check. Proceed with the surveyor\'s assessment.']
    }
  },
  pivc_life: {
    title: 'Life policy verification report (PIVC)', person: 'Proposer', verdict: PIVC_VERDICT,
    questions: () => LIFE_PIVC, order: ['identity', 'policyDetails', 'healthDisclosure', 'incomeOccupation', 'nominee', 'custom'],
    areas: [A.identity, A.face, A.body, area('product', 'Product understanding', { keys: ['premium', 'term', 'sum_assured', 'cover_reason', 'no_maturity', 'riders'] }),
      area('sales', 'Sales practice', { keys: PIVC_SALES, concern: 'focus' }), area('health', 'Health disclosure', { sections: ['healthDisclosure'] }),
      area('income', 'Income and occupation', { sections: ['incomeOccupation'] }), area('nominee', 'Nominee', { sections: ['nominee'] }),
      A.docsTriggers, A.signoff],
    facts: (d, c) => [['Plan', d.productName], ['Sum assured', c.policyValue ? money(c.policyValue) : ''], ['Premium', money(d.premium)], ['Agent', d.agentName]],
    next: {
      focus: ['Call back by a senior executive to confirm the customer understood the policy', 'Go through the signed proposal form with the customer',
        'If mis-selling is confirmed, explain free-look cancellation and refund', 'Refer any non-disclosure to underwriting before the policy is issued'],
      check: ['Clarify the points marked Check with the customer on a short call'],
      clear: ['No mis-selling or non-disclosure found. The policy can go ahead.']
    }
  },
  pivc_health: {
    title: 'Health policy verification report (PIVC)', person: 'Proposer', verdict: PIVC_VERDICT,
    questions: () => HEALTH_PIVC, order: ['identity', 'policyDetails', 'healthDisclosure', 'lifestyle', 'otherPolicies', 'custom'],
    areas: [A.identity, A.face, area('body', 'Body photos and build', { checks: /^body_/, keys: ['height_weight'] }),
      area('product', 'Product understanding', { keys: ['members', 'sum_insured', 'premium', 'waiting'] }), area('sales', 'Sales practice', { keys: PIVC_SALES, concern: 'focus' }),
      area('medical', 'Medical history', { sections: ['healthDisclosure'], skipKeys: ['height_weight'] }), area('lifestyle', 'Lifestyle and occupation', { sections: ['lifestyle'] }),
      area('others', 'Other policies', { sections: ['otherPolicies'] }), A.docsTriggers, A.signoff],
    facts: (d, c) => [['Plan', d.productName], ['Sum insured', c.policyValue ? money(c.policyValue) : ''], ['Premium', money(d.premium)], ['Agent', d.agentName]],
    next: {
      focus: ['Ask for medical records or a medical test for the illness that came up', 'Refer to underwriting: loading, waiting period or exclusion for the declared illness',
        'Senior executive call back if the waiting periods were not explained', 'If mis-selling is confirmed, explain free-look cancellation and refund'],
      check: ['Clarify the points marked Check with the customer on a short call'],
      clear: ['Declared health details match the call. The policy can go ahead.']
    }
  },
  bgv_employee: {
    title: 'Employee background verification report', person: 'Candidate', verdict: BGV_VERDICT,
    questions: () => BGV, order: ['identity', 'address', 'education', 'employment', 'gaps', 'declaration', 'references', 'custom'],
    chats: false, body: false,
    areas: [A.identity, A.face, area('address', 'Address', { sections: ['address'], src: ['location'] }), area('education', 'Education', { sections: ['education'] }),
      area('employment', 'Employment', { sections: ['employment'] }), area('gaps', 'Gaps', { sections: ['gaps'] }),
      area('declaration', 'Criminal and dual work', { sections: ['declaration'], concern: 'focus' }), area('references', 'References', { sections: ['references'] }),
      A.docs, A.signoff],
    facts: d => [['Client', d.clientName || d.insurerName], ['Position', d.position || d.productName], ['Employee ID', d.employeeId]],
    next: {
      focus: ['Verify employment in writing with the HR of each employer', 'Verify the degree with the university or the issuing board',
        'Physical address visit if the live location did not match the stated address', 'Court record and police verification through an authorised source'],
      check: ['Ask the candidate for the missing documents (degree, relieving letter, payslips)', 'Call the reference given by the candidate'],
      clear: ['Details given on the call are consistent. Complete source checks (employer, university, court) as per the package.']
    }
  }
};
PROFILES.pivc_term = { ...PROFILES.pivc_life, title: 'Term policy verification report (PIVC)', questions: () => [...LIFE_PIVC, ...TERM_EXTRA] };

const profileOf = svc => PROFILES[svc] || PROFILES.motor_claim;

// ---------- trigger rules ----------
const money = v => { const n = Number(String(v == null ? '' : v).replace(/[^0-9.]/g, '')); return n ? 'Rs. ' + n.toLocaleString('en-IN') : (v ? String(v) : ''); };
const amount = v => Number(String(v == null ? '' : v).replace(/[^0-9.]/g, '')) || 0;
function toDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s); // Indian style day/month/year
  if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return new Date(Date.UTC(y, +m[2] - 1, +m[1])); }
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t);
}
const days = (a, b) => Math.round((b - a) / 86400000);
const ageOn = (dob, at = new Date()) => { const d = toDate(dob); if (!d) return null; let y = at.getUTCFullYear() - d.getUTCFullYear(); const m = at.getUTCMonth() - d.getUTCMonth(); if (m < 0 || (m === 0 && at.getUTCDate() < d.getUTCDate())) y--; return y; };
// Long-standing illnesses that commonly come up as pre-existing (PED) in health claims.
const CHRONIC = /diabet|sugar|hypertens|blood pressure|\bbp\b|thyroid|cardiac|heart|angina|kidney|renal|ckd|dialysis|liver|cirrhosis|asthma|copd|cataract|knee replacement|arthritis|hernia|piles|haemorrhoid|hemorrhoid|fistula|stone|calculus|cancer|tumou?r|epilep|stroke|paraly/i;

function triggers(svc, c) {
  const d = c.details || {}, out = [];
  const add = (label, state, detail) => out.push({ label, state, detail });
  const start = toDate(d.policyStartDate);
  if (svc === 'health_claim') {
    const adm = toDate(d.admissionDate), dis = toDate(d.dischargeDate);
    if (start && adm) { const n = days(start, adm); add('Claim soon after the policy started', n <= 30 ? 'focus' : n <= 90 ? 'check' : 'clear', `Admission ${n} days after the policy start date`); }
    else add('Claim soon after the policy started', 'none', 'Policy start date or admission date not in the case record');
    if (adm && dis) {
      const n = days(adm, dis);
      add('Length of hospital stay', n < 0 ? 'focus' : n === 0 ? 'check' : n > 10 ? 'check' : 'clear',
        n < 0 ? 'Discharge date is before the admission date' : n === 0 ? 'Admitted and discharged the same day: confirm it was day care or truly needed admission' : `${n} day${n > 1 ? 's' : ''} in hospital${n > 10 ? ': long stay, check it was needed' : ''}`);
    } else add('Length of hospital stay', 'none', 'Admission or discharge date not in the case record');
    if (d.diagnosis && CHRONIC.test(d.diagnosis)) {
      const yrs = start ? days(start, adm || new Date()) / 365.25 : null;
      if (yrs != null && yrs >= 5) add('Possible pre-existing illness', 'clear', `"${d.diagnosis}" is often long-standing, but the policy has run over 5 years (moratorium): it can be questioned only for fraud`);
      else add('Possible pre-existing illness', 'check', `"${d.diagnosis}" is often long-standing. Check past records${yrs != null ? `; policy has run ${yrs.toFixed(1)} years` : ''}`);
    } else add('Possible pre-existing illness', d.diagnosis ? 'clear' : 'none', d.diagnosis ? 'Diagnosis is not one that is usually long-standing' : 'Diagnosis not in the case record');
    const amt = amount(d.claimAmount);
    add('Claim amount', amt ? (amt >= 100000 ? 'check' : 'clear') : 'none', amt ? `${money(amt)}${amt >= 100000 ? ': above Rs. 1 lakh, a closer look is usual' : ''}` : 'Claim amount not in the case record');
  } else if (svc === 'motor_claim') {
    const inc = toDate(d.incidentDate);
    if (start && inc) { const n = days(start, inc); add('Incident soon after the policy started', n < 0 ? 'focus' : n <= 30 ? 'focus' : n <= 60 ? 'check' : 'clear', n < 0 ? 'Incident date is before the policy start date' : `Incident ${n} days after the policy start date`); }
    else add('Incident soon after the policy started', 'none', 'Policy start date or incident date not in the case record');
    if (inc && c.createdAt) { const n = days(inc, new Date(c.createdAt)); add('Time from incident to investigation', n > 15 ? 'check' : 'clear', `Case opened ${n} days after the incident${n > 15 ? ': check when the claim was first reported' : ''}`); }
    else add('Time from incident to investigation', 'none', 'Incident date not in the case record');
    const amt = amount(d.claimAmount);
    add('Claim amount', amt ? (amt >= 200000 ? 'check' : 'clear') : 'none', amt ? money(amt) : 'Claim amount not in the case record');
  } else if (svc === 'pivc_life' || svc === 'pivc_term' || svc === 'pivc_health') {
    const age = ageOn(d.dob);
    add('Senior citizen proposer', age == null ? 'none' : age >= 60 ? 'check' : 'clear', age == null ? 'Date of birth not in the case record' : age >= 60 ? `Age ${age}: confirm the product suits the customer and was clearly explained` : `Age ${age}`);
    const sa = Number(c.policyValue) || 0;
    if (svc !== 'pivc_health') add('Large cover', sa ? (sa >= 1000000 ? 'check' : 'clear') : 'none', sa ? `${money(sa)}${sa >= 1000000 ? ': live executive call required' : ''}` : 'Sum assured not in the case record');
    if (svc === 'pivc_term' && age != null && age < 25 && sa >= 10000000) add('Young proposer with very large cover', 'check', `Age ${age} with ${money(sa)} cover: check income and reason for cover`);
  }
  for (const x of (c.aiCall && c.aiCall.crossCase) || []) add('Same details on another case', 'focus', x.text || String(x));
  return out;
}

module.exports = { PROFILES, profileOf, SECTION_LABELS, triggers, toDate, ageOn, money };
