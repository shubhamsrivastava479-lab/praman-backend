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
  if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return valid(y, +m[2], +m[1]); }
  m = /^(\d{4})[/.-](\d{1,2})$/.exec(s) || /^(\d{1,2})[/.-](\d{4})$/.exec(s); // month and year only: first of the month
  if (m) { const y = m[1].length === 4 ? +m[1] : +m[2], mo = m[1].length === 4 ? +m[2] : +m[1]; return valid(y, mo, 1); }
  m = /^([A-Za-z]{3,9})[\s,-]+(\d{4})$/.exec(s); // "Jan 2022", "January 2022"
  if (m) { const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1; return mo ? valid(+m[2], mo, 1) : null; }
  m = /^(\d{4})$/.exec(s); // year only
  if (m) return valid(+m[1], 1, 1);
  return null; // anything else is not read as a date: no guessing
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function valid(y, mo, d) { const t = new Date(Date.UTC(y, mo - 1, d)); return t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? t : null; }
const days = (a, b) => Math.round((b - a) / 86400000);
const ageOn = (dob, at = new Date()) => { const d = toDate(dob); if (!d) return null; let y = at.getUTCFullYear() - d.getUTCFullYear(); const m = at.getUTCMonth() - d.getUTCMonth(); if (m < 0 || (m === 0 && at.getUTCDate() < d.getUTCDate())) y--; return y; };
// Long-standing illnesses that commonly come up as pre-existing (PED) in health claims.
const CHRONIC = /diabet|sugar|hypertens|blood pressure|\bbp\b|thyroid|cardiac|heart|angina|kidney|renal|ckd|dialysis|liver|cirrhosis|asthma|copd|cataract|knee replacement|arthritis|hernia|piles|haemorrhoid|hemorrhoid|fistula|stone|calculus|cancer|tumou?r|epilep|stroke|paraly/i;

// Rules on ONE case's own record (Excel details, dates, amounts) and its call times.
// Each result: { label, state: focus | check | clear | none, detail, area? }  (area = page-1 box)
const PREMIUM_TIMES = { yearly: 1, annual: 1, annually: 1, single: 1, halfyearly: 2, half: 2, semiannual: 2, quarterly: 4, monthly: 12 };
const IST_HOUR = iso => (new Date(new Date(iso).getTime() + 5.5 * 3600e3)).getUTCHours();
function triggers(svc, c) {
  const d = c.details || {}, out = [], a = c.aiCall || {};
  const add = (label, state, detail, area) => out.push({ label, state, detail, ...(area ? { area } : {}) });
  const start = toDate(d.policyStartDate), end = toDate(d.policyEndDate);
  if (svc === 'health_claim') {
    const adm = toDate(d.admissionDate), dis = toDate(d.dischargeDate);
    const accident = /accident|injur/i.test(String(d.claimType || '') + ' ' + String(d.diagnosis || ''));
    if (start && adm) {
      const n = days(start, adm);
      add('Policy timing', n < 0 ? 'focus' : n < 30 ? (accident ? 'check' : 'focus') : n <= 90 ? 'check' : 'clear',
        n < 0 ? 'Admission date is before the policy start date'
          : n < 30 ? `Admission ${n} days after the policy start: inside the first 30-day waiting period${accident ? ' (accident claims are allowed in it)' : d.claimType ? ' and not an accident' : ' (claim type not given)'}`
            : `Admission ${n} days after the policy start date${n <= 90 ? ': early claim' : ''}`);
    } else add('Policy timing', 'none', 'Policy start date or admission date not in the case record');
    if (adm && dis) {
      const n = days(adm, dis);
      add('Length of hospital stay', n < 0 ? 'focus' : n === 0 ? 'check' : n > 10 ? 'check' : 'clear',
        n < 0 ? 'Discharge date is before the admission date' : n === 0 ? 'Admitted and discharged the same day: confirm it was day care or truly needed admission' : `${n} day${n > 1 ? 's' : ''} in hospital${n > 10 ? ': long stay, check it was needed' : ''}`);
      const wd = adm.getUTCDay();
      if ((wd === 0 || wd === 6) && n <= 1) add('Weekend short stay', 'check', `Admitted on a ${wd === 0 ? 'Sunday' : 'Saturday'} for ${n === 0 ? 'less than a day' : '1 day'}`);
    } else add('Length of hospital stay', 'none', 'Admission or discharge date not in the case record');
    if (d.diagnosis && CHRONIC.test(d.diagnosis)) {
      const yrs = start ? days(start, adm || new Date()) / 365.25 : null;
      if (yrs != null && yrs >= 5) add('Possible pre-existing illness', 'clear', `"${d.diagnosis}" is often long-standing, but the policy has run over 5 years (moratorium): it can be questioned only for fraud`);
      else add('Possible pre-existing illness', 'check', `"${d.diagnosis}" is often long-standing. Check past records${yrs != null ? `; policy has run ${yrs < 1 ? Math.round(yrs * 365.25) + ' days' : yrs.toFixed(1) + ' years'}` : ''}`);
    } else add('Possible pre-existing illness', d.diagnosis ? 'clear' : 'none', d.diagnosis ? 'Diagnosis is not in the list of usually long-standing illnesses' : 'Diagnosis not in the case record');
    const amt = amount(d.claimAmount);
    add('Claim amount', amt ? (amt >= 100000 ? 'check' : 'clear') : 'none', amt ? `${money(amt)}${amt >= 100000 ? ': above Rs. 1 lakh, a closer look is usual' : ''}` : 'Claim amount not in the case record');
  } else if (svc === 'motor_claim') {
    const inc = toDate(d.incidentDate);
    if (start && inc) { const n = days(start, inc); add('Incident soon after the policy started', n < 0 ? 'focus' : n <= 30 ? 'focus' : n <= 60 ? 'check' : 'clear', n < 0 ? 'Incident date is before the policy start date' : `Incident ${n} days after the policy start date`); }
    else add('Incident soon after the policy started', 'none', 'Policy start date or incident date not in the case record');
    if (end && inc) { const n = days(end, inc); add('Incident near the policy end', n > 0 ? 'focus' : n >= -15 ? 'check' : 'clear', n > 0 ? `Incident ${n} days AFTER the policy end date` : n >= -15 ? `Incident ${-n} days before the policy end date` : `Incident ${-n} days before the policy end date`); }
    if (inc && c.createdAt) { const n = days(inc, new Date(c.createdAt)); add('Time from incident to investigation', n > 15 ? 'check' : 'clear', `Case opened ${n} days after the incident${n > 15 ? ': check when the claim was first reported' : ''}`); }
    else add('Time from incident to investigation', 'none', 'Incident date not in the case record');
    const amt = amount(d.claimAmount);
    add('Claim amount', amt ? (amt >= 200000 ? 'check' : 'clear') : 'none', amt ? money(amt) : 'Claim amount not in the case record');
  } else if (svc === 'pivc_life' || svc === 'pivc_term' || svc === 'pivc_health') {
    const age = ageOn(d.dob);
    add('Senior citizen proposer', age == null ? 'none' : age >= 60 ? 'check' : 'clear', age == null ? 'Date of birth not in the case record' : age >= 60 ? `Age ${age}: confirm the product suits the customer and was clearly explained` : `Age ${age}`);
    const sa = Number(c.policyValue) || 0, income = amount(d.annualIncome);
    if (svc !== 'pivc_health') add('Large cover', sa ? (sa >= 1000000 ? 'check' : 'clear') : 'none', sa ? `${money(sa)}${sa >= 1000000 ? ': live executive call required' : ''}` : 'Sum assured not in the case record');
    if (svc === 'pivc_term' && age != null && age < 25 && sa >= 10000000) add('Young proposer with very large cover', 'check', `Age ${age} with ${money(sa)} cover: check income and reason for cover`);
    const prem = amount(d.premium), times = PREMIUM_TIMES[String(d.premiumFrequency || '').toLowerCase().replace(/[^a-z]/g, '')];
    if (prem && income && times) {
      const pct = Math.round(prem * times / income * 100);
      add('Premium compared with income', pct > 50 ? 'focus' : pct > 30 ? 'check' : 'clear', `Yearly premium ${money(prem * times)} is ${pct}% of yearly income ${money(income)}${pct > 30 ? ': may not be affordable' : ''}`, 'sales');
    } else add('Premium compared with income', 'none', !income ? 'Yearly income not in the case record' : !prem ? 'Premium not in the case record' : 'Premium frequency (yearly / monthly ...) not in the case record');
    if (svc !== 'pivc_health') {
      if (sa && income) { const x = sa / income; add('Cover compared with income', x > 25 ? 'check' : 'clear', `Cover is ${x.toFixed(1)} times the yearly income${x > 25 ? ': above 25 times, check the reason for this cover' : ''}`, 'income'); }
      else add('Cover compared with income', 'none', 'Sum assured or yearly income not in the case record');
    }
  } else if (svc === 'bgv_employee') {
    const f1 = toDate(d.employer1From), t1 = toDate(d.employer1To), f2 = toDate(d.employer2From), t2 = toDate(d.employer2To);
    for (const [f, t, n] of [[f1, t1, 'latest'], [f2, t2, 'previous']]) if (f && t && t < f) add(`Dates of the ${n} job`, 'focus', `"To" date is before the "from" date`, 'employment');
    if (t2 && f1) {
      const g = days(t2, f1);
      if (g > 90) add('Gap between jobs', 'check', `${Math.round(g / 30.4)} months between the previous job and the latest job`, 'gaps');
      else if (g < -30) add('Two jobs at the same time', 'check', `The previous job ends ${Math.round(-g / 30.4)} months after the latest job started`, 'employment');
      else add('Gap between jobs', 'clear', g > 0 ? `${g} days between jobs` : 'No gap', 'gaps');
    } else add('Gap between jobs', 'none', 'Job dates not in the case record', 'gaps');
    const by = toDate(d.dob), py = Number(String(d.passingYear || '').replace(/\D/g, '').slice(0, 4));
    if (by && py > 1900) { const age = py - by.getUTCFullYear(); add('Age at passing the qualification', age < 18 ? 'check' : 'clear', `About ${age} years old in the passing year ${py}${age < 18 ? ': unusually young, check the year' : ''}`, 'education'); }
    else add('Age at passing the qualification', 'none', 'Date of birth or passing year not in the case record', 'education');
  }
  // the call itself
  if (a.startedAt) {
    const h = IST_HOUR(a.startedAt);
    if (h >= 22 || h < 7) add('Call at night', 'check', `Call started at ${String(h).padStart(2, '0')}:00 to ${String((h + 1) % 24).padStart(2, '0')}:00 India time`);
    const endAt = a.completedAt || a.handoffAt;
    if (a.status === 'completed' && endAt) { const m = (new Date(endAt) - new Date(a.startedAt)) / 60000; if (m < 4) add('Very short call', 'check', `The whole call took ${m.toFixed(1)} minutes`); }
  }
  for (const x of a.crossCase || []) add('Same details on another case', 'focus', x.text || String(x));
  return out;
}

// ---------- matching what the insurer sent with what the customer says ----------
// Each spec: field (key in case.details, or a case field like policyValue), label, type
// (date | amount | year | number | text), area (page-1 box), and the question that asks for it.
// The question NEVER says the value on record: the customer has to say it themselves.
// If a question of the service already asks for it (key), the field is attached to that question;
// otherwise the extra question is added (only when the record has a value for the field).
const M = (field, label, type, area, key, text, section) => ({ field, label, type, area, key, text, section });
const COMMON_MATCH = [
  M('city', 'City', 'text', 'identity', 'm_city', 'In which city do you live?', 'identity'),
  M('pincode', 'PIN code', 'number', 'identity', 'm_pincode', 'What is the PIN code of your area?', 'identity')
];
const MATCH = {
  health_claim: [
    M('dob', 'Date of birth', 'date', 'identity', 'm_dob', 'Please tell me the patient\'s date of birth.', 'identity'),
    M('hospitalName', 'Hospital name', 'text', 'stay', 'hospital'),
    M('admissionDate', 'Admission date', 'date', 'stay', 'admit_dates'),
    M('dischargeDate', 'Discharge date', 'date', 'stay', 'admit_dates'),
    M('diagnosis', 'Diagnosis', 'text', 'stay', 'm_diagnosis', 'What illness did the doctor say the patient had?', 'hospitalStay'),
    M('claimType', 'Claim type (cashless / reimbursement)', 'text', 'treatment', 'm_claim_type', 'Was this claim cashless at the hospital, or are you claiming the money back after paying?', 'treatment'),
    M('claimAmount', 'Claim amount', 'amount', 'treatment', 'm_claim_amount', 'How much money have you claimed from the insurance company?', 'treatment')
  ],
  motor_claim: [
    M('dob', 'Date of birth', 'date', 'identity', 'm_dob', 'Please tell me your date of birth.', 'identity'),
    M('incidentDate', 'Incident date', 'date', 'incident', 'when'),
    M('incidentPlace', 'Incident place', 'text', 'incident', 'where'),
    M('vehicleMake', 'Vehicle make and model', 'text', 'vehicle', 'm_vehicle_make', 'Which company and model is the vehicle?', 'vehicle'),
    M('garageName', 'Garage', 'text', 'vehicle', 'repair'),
    M('claimType', 'Claim type', 'text', 'incident', 'm_claim_type', 'Is this claim for an accident, theft, or something else?', 'lossDetails'),
    M('claimAmount', 'Claim amount', 'amount', 'vehicle', 'm_claim_amount', 'How much money have you claimed, or what is the repair estimate?', 'vehicle')
  ],
  pivc_life: [
    M('dob', 'Date of birth', 'date', 'identity', 'dob'),
    M('productName', 'Plan name', 'text', 'product', 'm_plan', 'What is the name of the plan you have bought?', 'policyDetails'),
    M('policyValue', 'Sum assured', 'amount', 'product', 'm_sum_assured', 'What is the sum assured, that is the cover amount, of this policy?', 'policyDetails'),
    M('premium', 'Premium', 'amount', 'product', 'premium'),
    M('premiumFrequency', 'Premium frequency', 'text', 'product', 'premium'),
    M('agentName', 'Agent name', 'text', 'sales', 'm_agent', 'What is the name of the agent or advisor who sold you this policy?', 'policyDetails'),
    M('annualIncome', 'Yearly income', 'amount', 'income', 'income'),
    M('nomineeName', 'Nominee name', 'text', 'nominee', 'nominee')
  ],
  pivc_health: [
    M('dob', 'Date of birth', 'date', 'identity', 'dob'),
    M('productName', 'Plan name', 'text', 'product', 'm_plan', 'What is the name of the health plan you have bought?', 'policyDetails'),
    M('policyValue', 'Sum insured', 'amount', 'product', 'sum_insured'),
    M('premium', 'Premium', 'amount', 'product', 'premium'),
    M('premiumFrequency', 'Premium frequency', 'text', 'product', 'premium'),
    M('agentName', 'Agent name', 'text', 'sales', 'm_agent', 'What is the name of the agent or advisor who sold you this policy?', 'policyDetails'),
    M('nomineeName', 'Nominee name', 'text', 'others', 'm_nominee', 'Who is the nominee in this policy?', 'otherPolicies')
  ],
  bgv_employee: [
    M('dob', 'Date of birth', 'date', 'identity', 'dob'),
    M('clientName', 'Company offering the job', 'text', 'employment', 'm_client', 'Which company has offered you this job?', 'employment'),
    M('position', 'Position offered', 'text', 'employment', 'm_position', 'For which position or role have you been selected?', 'employment'),
    M('passingYear', 'Passing year', 'year', 'education', 'qualification'),
    M('employer1Name', 'Latest employer', 'text', 'employment', 'current_employer'),
    M('employer1From', 'Latest job start', 'date', 'employment', 'emp_dates'),
    M('employer1To', 'Latest job end', 'date', 'employment', 'emp_dates'),
    M('employer2Name', 'Previous employer', 'text', 'employment', 'previous_employer')
  ]
};
MATCH.pivc_term = MATCH.pivc_life.map(x => x.field === 'policyValue' ? { ...x, key: 'sum_assured', text: undefined, section: undefined } : x);

// Value on record for a spec (Excel details, or the case's own fields).
const recordValue = (c, f) => {
  const d = c.details || {};
  if (f === 'policyValue') return c.policyValue ? String(c.policyValue) : '';
  if (f === 'clientName') return d.clientName || '';
  return d[f] == null ? '' : String(d[f]).trim();
};
const matchSpecs = (svc, c) => [...(MATCH[svc] || []), ...COMMON_MATCH]
  .filter(m => recordValue(c, m.field))
  .map(m => ({ ...m, expected: recordValue(c, m.field) }));

// Exact comparison of what the customer said (already turned into a plain value) with the record.
// Returns { result: match | partial | mismatch | unknown, detail }.
function compareValue(spec, said, aiSame) {
  const rec = spec.expected;
  if (said == null || String(said).trim() === '') return { result: 'unknown', detail: `No clear ${spec.label.toLowerCase()} in the answer; record: ${rec}` };
  const both = `said: ${said}; record: ${rec}`;
  if (spec.type === 'date') {
    const a = toDate(said), b = toDate(rec);
    if (!a || !b) return { result: 'unknown', detail: `Could not read a date (${both})` };
    const monthOnly = /^\d{4}-\d{1,2}$/.test(String(said).trim()) || /^\d{4}-\d{1,2}$/.test(rec) || /^[A-Za-z]{3,9}[\s,-]+\d{4}$/.test(rec);
    if (monthOnly) return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() ? { result: 'match', detail: `Same month (${both})` } : { result: 'mismatch', detail: `Different month (${both})` };
    const n = Math.abs(days(a, b));
    return n === 0 ? { result: 'match', detail: `Same date (${both})` } : n <= 2 ? { result: 'partial', detail: `${n} day${n > 1 ? 's' : ''} apart (${both})` } : { result: 'mismatch', detail: `${n} days apart (${both})` };
  }
  if (spec.type === 'amount' || spec.type === 'number' || spec.type === 'year') {
    const a = amount(said), b = amount(rec);
    if (!a || !b) return { result: 'unknown', detail: `Could not read a number (${both})` };
    if (spec.type === 'number') return a === b ? { result: 'match', detail: both } : { result: 'mismatch', detail: both };
    if (spec.type === 'year') { const g = Math.abs(a - b); return g === 0 ? { result: 'match', detail: both } : g === 1 ? { result: 'partial', detail: `1 year apart (${both})` } : { result: 'mismatch', detail: `${g} years apart (${both})` }; }
    const pct = Math.abs(a - b) / b * 100;
    const fmt = x => 'Rs. ' + x.toLocaleString('en-IN');
    const txt = `said: ${fmt(a)}; record: ${fmt(b)}`;
    return pct <= 1 ? { result: 'match', detail: txt } : pct <= 10 ? { result: 'partial', detail: `${pct.toFixed(0)}% different (${txt})` } : { result: 'mismatch', detail: `${pct.toFixed(0)}% different (${txt})` };
  }
  // text: exact after removing spaces / dots / case, or one contains the other; otherwise the AI's view
  const n = v => String(v).toLowerCase().replace(/[^a-z0-9]/g, '');
  const A = n(said), B = n(rec);
  if (A && B && (A === B || (Math.min(A.length, B.length) >= 4 && (A.includes(B) || B.includes(A))))) return { result: 'match', detail: both };
  if (aiSame === true) return { result: 'partial', detail: `Different words, the AI thinks it is the same (${both})` };
  if (aiSame === false) return { result: 'mismatch', detail: both };
  return { result: 'unknown', detail: `Could not compare (${both})` };
}

module.exports = { PROFILES, profileOf, SECTION_LABELS, triggers, toDate, ageOn, money, amount, days, matchSpecs, compareValue, MATCH };
