// Full-automation verification call: the AI voice agent's script and state machine.
//
// Design rules (so concurrent webhook / API requests never overwrite each other
// in the JSON database):
//   * prepare*()  = async work (Gemini, Gridlines). Never mutates the database.
//   * apply*()    = synchronous state change on a FRESH copy of the case.
// Routes call prepare first, then re-read the db, then apply, then write.
//
// Privacy: full Aadhaar / PAN numbers and the raw photos used for matching are
// held in memory only (SECRET_TTL), never written to the database. The
// database gets masked numbers (last 4) plus the name / DOB / address text.

const { db, uid } = require('../db');
const gemini = require('./gemini');
const kyc = require('./kyc');
const { getSetting } = require('./platform-settings');
const { maskId, redactIdsInText } = require('./security');

const SECRET_TTL = 60 * 60 * 1000;
const secrets = new Map(); // caseId -> { aadhaarNumber, panNumber, aadhaarRef, selfieB64, aadhaarFrontB64, exp }

function sec(caseId, create = true) {
  const now = Date.now();
  for (const [k, v] of secrets) if (v.exp < now) secrets.delete(k);
  let s = secrets.get(caseId);
  if (!s && create) { s = { exp: now + SECRET_TTL }; secrets.set(caseId, s); }
  if (s) s.exp = now + SECRET_TTL;
  return s;
}

// ---------- small helpers ----------
const now = () => new Date().toISOString();
const isPolicy = c => c.caseType === 'policy_verification';
const typeLabel = c => isPolicy(c)
  ? (c.policyType === 'term' ? 'term insurance policy verification' : 'life insurance policy verification')
  : 'motor claim investigation';

// Rough great-circle distance in km, used to notice if the customer moves
// far away during the call (e.g. a different person takes over elsewhere).
function distanceKm(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude), dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const validLoc = l => l && isFinite(Number(l.latitude)) && isFinite(Number(l.longitude)) && !(Number(l.latitude) === 0 && Number(l.longitude) === 0);

function normName(n) {
  return String(n || '').toLowerCase()
    .replace(/\b(mr|mrs|ms|shri|smt|sri|dr|kumari|late)\b\.?/g, ' ')
    .replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
}
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
function nameMatch(a, b) {
  const A = normName(a), B = normName(b);
  if (!A.length || !B.length) return 'unknown';
  let hit = 0;
  for (const t of A) {
    if (B.some(u => u === t || (t.length === 1 && u[0] === t) || (u.length === 1 && t[0] === u) ||
        (t.length >= 5 && u.length >= 5 && editDistance(t, u) <= 1))) hit++;
  }
  const score = hit / Math.max(A.length, B.length);
  return score >= 0.99 ? 'match' : score >= 0.5 ? 'partial' : 'mismatch';
}
function normDob(s) {
  const t = String(s || '').trim();
  const m = t.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) return { d: m[1].padStart(2, '0'), m: m[2].padStart(2, '0'), y: m[3] };
  const y = t.match(/\b(19|20)\d{2}\b/);
  return y ? { y: y[0] } : null;
}
function dobMatch(a, b) {
  const A = normDob(a), B = normDob(b);
  if (!A || !B) return 'unknown';
  if (A.y !== B.y) return 'mismatch';
  if (A.d && B.d) return (A.d === B.d && A.m === B.m) ? 'match' : 'mismatch';
  return 'match';
}
const spell = v => String(v).replace(/\s+/g, '').split('').join(' ');

function record(c, event, actor = 'ai_agent') {
  db.data.custody.push({ id: uid('cust'), caseId: c.id, event, actor, timestamp: now() });
}
function transcript(c, speaker, original, english, language) {
  if (!original && !english) return;
  db.data.transcripts.push({
    id: uid('tr'), caseId: c.id, source: 'ai_call', speaker,
    original: original || english, english: english || original, language: language || 'English', timestamp: now()
  });
}
function setCheck(a, id, label, result, detail) {
  const entry = { id, label, result, detail: detail || '', at: now() };
  const i = a.checks.findIndex(x => x.id === id);
  if (i >= 0) a.checks[i] = entry; else a.checks.push(entry);
}

// ---------- the script ----------
const PIVC_QUESTIONS = [
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
  ['nominee', 'nominee', 'Who is the nominee in your policy, and what is their relationship with you?']
];
// Extra questions for TERM plans: large cover, low premium, so mis-selling and
// non-disclosure of health / income / other policies are the main risks.
const TERM_EXTRA_QUESTIONS = [
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

const CLAIM_QUESTIONS = [
  ['lossDetails', 'when', 'On what date and at what time did the accident or loss happen?'],
  ['lossDetails', 'where', 'At what place did it happen? Please tell me the exact location.'],
  ['lossDetails', 'how', 'Please explain in your own words how it happened.'],
  ['lossDetails', 'driver', 'Who was driving the vehicle at that time?'],
  ['lossDetails', 'injuries', 'Was anyone injured, or was any other vehicle or person involved?'],
  ['police', 'fir', 'Was a police complaint or FIR registered? If yes, at which police station?'],
  ['vehicle', 'location', 'Where is the vehicle right now?'],
  ['vehicle', 'repair', 'Has the vehicle been repaired? If yes, at which garage?'],
  ['witness', 'witness', 'Were there any witnesses to the incident?']
];

function chatKeywords(c) {
  const k = ['accident', 'theft', 'police'];
  const v = String(c.vehicleNo || '').replace(/\s/g, '');
  k.push(v.length >= 4 ? v.slice(-4) : 'claim');
  return k;
}

function buildQueue(c) {
  const q = [];
  q.push({ id: 'name', type: 'ask', kind: 'name', key: 'spokenName', section: 'identity', text: 'Please tell me your full name.' });

  const confirms = [];
  if (c.insuredName) confirms.push({ key: 'insuredName', label: 'name', value: c.insuredName });
  if (c.claimNo) confirms.push({ key: 'claimNo', label: c.caseType === 'policy_verification' ? 'policy number' : 'claim number', value: c.claimNo, spell: true });
  if (c.policyNo && c.policyNo !== c.claimNo) confirms.push({ key: 'policyNo', label: 'policy number', value: c.policyNo, spell: true });
  if (c.vehicleNo) confirms.push({ key: 'vehicleNo', label: 'vehicle number', value: c.vehicleNo, spell: true });
  if (c.district) confirms.push({ key: 'district', label: 'district', value: c.district });
  for (const f of confirms) {
    q.push({
      id: 'confirm_' + f.key, type: 'confirm', key: f.key, label: f.label, value: f.value, section: 'identity',
      text: `Our records show your ${f.label} as ${f.spell ? spell(f.value) : f.value}. Is that correct?`
    });
  }

  q.push({
    id: 'face', type: 'photo', shot: 'face', countdown: 3, section: 'identity',
    text: 'Now please hold your mobile phone in front of your face, so that your face is clearly visible inside the oval on the screen. I will take a photo in three seconds.'
  });
  q.push({
    id: 'blink', type: 'burst', shot: 'blink', countdown: 2, section: 'identity',
    text: 'Thank you. Now keep looking at the camera, and slowly close and open your eyes two times.'
  });
  if (isPolicy(c)) {
    q.push({
      id: 'body_stand', type: 'photo', shot: 'stand', countdown: 10, section: 'identity',
      text: 'Now I need a full body photo. Please keep the phone on a table or against a wall, or ask someone to hold it, and step back two or three steps so that your whole body, from head to feet, is visible. Please stand straight. I will take the photo in ten seconds.'
    });
    q.push({
      id: 'body_sit', type: 'photo', shot: 'sit', countdown: 8, section: 'identity',
      text: 'Thank you. Now please sit down on a chair at the same place, so that your whole body is still visible. I will take the photo in eight seconds.'
    });
  }
  q.push({
    id: 'aadhaar', type: 'docs', doc: 'aadhaar', section: 'identity',
    text: 'Please send clear photos of the front and the back of your Aadhaar card on this WhatsApp chat. I will wait here, and continue as soon as I receive them.'
  });
  q.push({
    id: 'pan', type: 'docs', doc: 'pan', section: 'identity',
    text: 'Now please send a clear photo of your PAN card on the same WhatsApp chat.'
  });

  const bank = isPolicy(c)
    ? (c.policyType === 'term' ? [...PIVC_QUESTIONS, ...TERM_EXTRA_QUESTIONS] : PIVC_QUESTIONS)
    : CLAIM_QUESTIONS;
  for (const [section, key, text] of bank) q.push({ id: 'q_' + key, type: 'ask', kind: 'free', key, section, text });

  // Claim cases: WhatsApp history check. The customer searches their own
  // WhatsApp and sends screenshots of the search results (phone browsers
  // cannot share the screen, so screenshots are the way that works on every phone).
  if (!isPolicy(c)) {
    const keywords = chatKeywords(c);
    q.push({
      id: 'chats_consent', type: 'consent', section: 'chatHistory',
      text: 'One more step, which is optional. To understand when and with whom the incident was first discussed, I would like you to search your own WhatsApp for a few words, and send me screenshots of the search results. You decide what to send. Do you agree? Please say yes or no.'
    });
    q.push({
      id: 'chats', type: 'docs', doc: 'chats', section: 'chatHistory', keywords,
      text: `Thank you. Please open WhatsApp and tap the search bar at the top. Type the word ${keywords[0]}, and take a screenshot of the results. Then do the same for ${keywords.slice(1, -1).join(', ')} and ${keywords[keywords.length - 1]}. You can also search in Hindi. Send all the screenshots on this same WhatsApp chat with us, then come back here and tap the button that says I have sent all screenshots.`
    });
  }

  q.push({
    id: 'closing', type: 'close',
    text: 'Thank you for your time. Your verification call is now complete. Our team will review it and contact you if anything more is needed. You may now disconnect the call.'
  });
  return q;
}

const EXPECT = { ask: 'voice', confirm: 'voice', consent: 'voice', otp: 'voice', photo: 'photo', burst: 'burst', docs: 'docs', close: 'none' };
function phaseOf(step) {
  if (!step) return 'done';
  if (step.type === 'close') return 'done';
  if (step.shot === 'face' || step.shot === 'blink') return 'face';
  if (step.shot === 'stand' || step.shot === 'sit') return 'body';
  if (step.type === 'docs' || step.type === 'otp') return 'documents';
  if (step.section === 'chatHistory') return 'chats';
  if (step.id.startsWith('q_') || step.id.endsWith('_fu') || step.id === 'name_explain') return 'questions';
  return 'details';
}

function turnFor(c, preface, override, silent) {
  const a = c.aiCall;
  const step = a.queue[a.i];
  const text = override || step.text;
  const say = [preface, text].filter(Boolean).join(' ');
  if (!silent) transcript(c, 'AI Agent', say, say, 'English');
  return {
    say, expect: EXPECT[step.type], stage: step.id, doc: step.doc || null,
    shot: step.shot || null, countdown: step.countdown || null, phase: phaseOf(step), keywords: step.keywords || null,
    done: step.type === 'close', progress: { step: a.i, total: a.queue.length }
  };
}

const peekTurn = c => turnFor(c, '', null, true);
function advanceStep(a) { a.i = Math.min(a.i + 1, a.queue.length - 1); }

// ---------- session start ----------
function startSession(c, { language, location, deviceInfo, ip, resume }) {
  if (!c.aiCall) c.aiCall = {};
  const a = c.aiCall;
  if (a.status === 'in_progress' && a.queue && resume !== false) {
    if (language) a.language = language;
    record(c, 'Customer re-joined the AI verification call');
    return turnFor(c, 'Welcome back. Let us continue.');
  }
  Object.assign(a, {
    status: 'in_progress', language: language || 'English', startedAt: now(), completedAt: null,
    queue: buildQueue(c), i: 0, answers: [], checks: [], flags: [], tries: {},
    docs: { aadhaar: {}, pan: {}, chats: { count: 0, entries: [], evidenceIds: [] }, other: [], unreadable: 0 }, captured: {}, photos: {}, locations: []
  });
  record(c, `AI verification call started (${typeLabel(c)}), language: ${a.language}`);
  if (location && location.latitude != null) {
    record(c, `Participant location captured: ${Number(location.latitude).toFixed(5)}, ${Number(location.longitude).toFixed(5)} (±${Math.round(location.accuracy || 0)}m) from IP ${ip || 'unknown'}`, 'participant');
    c.lastKnownLocation = { latitude: location.latitude, longitude: location.longitude, accuracy: location.accuracy, capturedAt: now() };
    a.startLocation = { latitude: Number(location.latitude), longitude: Number(location.longitude), accuracy: location.accuracy || null, at: now() };
    a.locations.push({ what: 'call start', ...a.startLocation });
  } else {
    record(c, `Participant location was not available (permission denied or unsupported device) — IP ${ip || 'unknown'}`, 'participant');
  }
  if (deviceInfo) {
    record(c, `Device recorded: ${deviceInfo.platform || 'unknown OS'}, ${deviceInfo.screen || ''}, ${deviceInfo.timezone || ''}, IP ${ip || 'unknown'}`, 'participant');
  }
  const vendor = (db.data.users || []).find(u => u.id === c.vendorId);
  const firm = vendor && vendor.vendorName ? vendor.vendorName : '';
  const welcome = `Hello, and welcome. Please note, this is an AI-assisted verification call. You are speaking with an automated AI assistant${firm ? ' on behalf of ' + firm : ''}, not a human. ` +
    `Thank you for connecting this call to process your ${typeLabel(c)} for case number ${spell(c.claimNo)}. ` +
    `This video call is being recorded for verification. If you would like to speak to a person at any time, tap the button that says talk to a person. Let us begin.`;
  record(c, 'Customer was informed that this is an AI-assisted call with an automated assistant, and that it is recorded');
  return turnFor(c, welcome);
}

// ---------- async preparation (no db mutation) ----------
async function gridlinesCreds() {
  const apiKey = await getSetting('gridlinesApiKey', 'GRIDLINES_API_KEY');
  if (!apiKey) return null;
  return { apiKey, authType: (await getSetting('gridlinesAuthType', 'GRIDLINES_AUTH_TYPE')) || 'API-Key' };
}

const looksFailed = res => /invalid|not\s*valid|mismatch|not\s*match|failed|not\s*found/i.test(JSON.stringify(res || {}));

function docsReady(a, doc, done) {
  const d = a.docs[doc] || {};
  if (doc === 'chats') return (d.count || 0) >= 1 && !!(done || d.done);
  return doc === 'aadhaar' ? !!(d.front && d.back) : !!d.received;
}

// input: { english, original, language, empty } for voice, { photoB64 } for photo, {} for docs
async function prepare(c, input) {
  const a = c.aiCall;
  const step = a.queue[a.i];
  const prep = {};
  if (!step) return prep;

  if (step.type === 'photo') {
    const s = sec(c.id);
    if (step.shot === 'stand' || step.shot === 'sit') {
      prep.body = await gemini.checkBodyPhoto(input.photoB64, step.shot === 'sit' ? 'sitting' : 'standing', s.selfieB64 || null);
      return prep;
    }
    s.selfieB64 = input.photoB64 && input.photoB64.length < 2_000_000 ? input.photoB64 : s.selfieB64;
    prep.face = await gemini.checkFacePhoto(input.photoB64, null);
    return prep;
  }

  if (step.type === 'burst') {
    const frames = (input.framesB64 || []).filter(Boolean).slice(0, 16);
    prep.blink = frames.length >= 4 ? await gemini.checkBlink(frames) : { faceVisible: false, possibleSpoof: 'Not enough frames received' };
    return prep;
  }

  if (step.type === 'ask' || step.type === 'confirm') {
    if (input.empty) { prep.judge = { intent: 'unclear', value: '', clear: false, followUp: '', concern: '' }; return prep; }
    prep.judge = await gemini.judgeAnswer({
      kind: step.type === 'confirm' ? 'confirm' : step.kind, question: step.text,
      answerEnglish: input.english, expected: step.type === 'confirm' ? step.value : undefined
    });
    return prep;
  }

  if (step.type === 'otp') {
    if (input.empty) { prep.otpDigits = ''; return prep; }
    const j = await gemini.judgeAnswer({ kind: 'otp', question: step.text, answerEnglish: input.english });
    const digits = String(j.value || input.english || '').replace(/\D/g, '');
    prep.otpDigits = digits;
    const s = sec(c.id, false);
    const creds = await gridlinesCreds();
    if (digits.length >= 4 && s && s.aadhaarRef && creds) {
      try { prep.otpResult = await kyc.verifyAadhaarOtp(s.aadhaarRef, digits, creds); }
      catch (e) { prep.otpError = true; }
    }
    return prep;
  }

  if (step.type === 'consent') {
    if (input.empty) { prep.judge = { intent: 'unclear' }; return prep; }
    prep.judge = await gemini.judgeAnswer({ kind: 'confirm', question: step.text, answerEnglish: input.english });
    return prep;
  }

  if (step.type === 'docs' && step.doc === 'chats') {
    if (!input.skip && docsReady(a, 'chats', input.done)) {
      const incident = (a.answers || []).filter(x => ['lossDetails', 'police'].includes(x.section)).map(x => ({ q: x.question, a: x.english || x.value || '' }));
      try {
        prep.chatReview = await gemini.assessChatHistory({
          caseInfo: { claimNo: c.claimNo, insuredName: c.insuredName, vehicleNo: c.vehicleNo, district: c.district },
          incident, entries: (a.docs.chats || {}).entries || []
        });
      } catch (e) { prep.chatReview = null; }
    }
    return prep;
  }

  if (step.type === 'docs' && !input.skip && docsReady(a, step.doc)) {
    const s = sec(c.id, false) || {};
    const creds = await gridlinesCreds();
    if (step.doc === 'aadhaar') {
      if (s.selfieB64 && s.aadhaarFrontB64) {
        try { prep.faceMatch = await gemini.checkFacePhoto(s.selfieB64, s.aadhaarFrontB64); } catch { /* optional */ }
      }
      if (creds && s.aadhaarNumber && !a.otpTried) {
        try {
          const r = await kyc.generateAadhaarOtp(s.aadhaarNumber, creds);
          prep.aadhaarRef = r.data?.reference_id || r.reference_id || null;
        } catch (e) { prep.aadhaarApiError = true; }
      } else if (!creds) prep.noApi = true;
    }
    if (step.doc === 'pan') {
      if (creds && s.panNumber && a.docs.pan.name) {
        try {
          const dob = normDob(a.docs.pan.dob);
          const dobStr = dob && dob.d ? `${dob.d}/${dob.m}/${dob.y}` : '';
          prep.panApi = await kyc.verifyPan(s.panNumber, a.docs.pan.name, dobStr, creds);
        } catch (e) { prep.panApiError = true; }
      } else if (!creds) prep.noApi = true;
    }
  }
  return prep;
}

// ---------- apply (sync, on a fresh case) ----------
function retryOrSkip(a, step, retryText, maxTries = 1) {
  a.tries[step.id] = (a.tries[step.id] || 0) + 1;
  return a.tries[step.id] <= maxTries ? retryText : null;
}

function saveAnswer(c, step, input, extra = {}) {
  const a = c.aiCall;
  a.answers.push({
    key: step.key, section: step.section, question: step.text,
    original: input.original || '', english: input.english || '', language: input.language || a.language,
    at: now(), ...extra
  });
  transcript(c, 'Customer', input.original, input.english, input.language);
}

function apply(c, input, prep) {
  const a = c.aiCall;
  const step = a.queue[a.i];
  if (!step || a.status !== 'in_progress') return turnFor(c, '');
  a.photos = a.photos || {};

  // ---- name ----
  if (step.type === 'ask' && step.kind === 'name') {
    const name = (prep.judge && prep.judge.value || '').trim();
    if (!name || input.empty) {
      const retry = retryOrSkip(a, step, 'Sorry, I could not hear that clearly. Please tell me your full name.');
      if (retry) return turnFor(c, '', retry);
      a.flags.push('Customer did not state their name'); advanceStep(a);
      return turnFor(c, 'Okay, let us continue.');
    }
    a.captured.spokenName = name;
    saveAnswer(c, step, input, { value: name });
    if (c.insuredName) {
      const m = nameMatch(name, c.insuredName);
      setCheck(a, 'name_spoken', 'Name stated by customer vs case record', m === 'match' ? 'match' : m === 'partial' ? 'partial' : m === 'mismatch' ? 'mismatch' : 'unknown', `Said: ${name}`);
    }
    record(c, `Customer stated name: ${name}`);
    advanceStep(a);
    return turnFor(c, `Thank you, ${name.split(/\s+/)[0]}.`);
  }

  // ---- confirm record details ----
  if (step.type === 'confirm') {
    const j = prep.judge || {};
    if (j.intent === 'yes') {
      saveAnswer(c, step, input, { intent: 'confirmed', value: step.value });
      record(c, `Customer confirmed ${step.label}`);
      advanceStep(a);
      return turnFor(c, 'Thank you.');
    }
    if (j.intent === 'no') {
      if (j.value) {
        saveAnswer(c, step, input, { intent: 'denied', value: j.value, concern: `Record says ${step.label} is ${step.value}` });
        a.flags.push(`Customer says ${step.label} is "${j.value}" but case record has "${step.value}"`);
        setCheck(a, 'confirm_' + step.key, `${step.label} confirmed`, 'mismatch', `Customer said: ${j.value}`);
        advanceStep(a);
        return turnFor(c, 'Understood, I have noted that.');
      }
      a.queue.splice(a.i + 1, 0, { id: 'fix_' + step.key, type: 'ask', kind: 'capture', key: 'correct_' + step.key, section: 'identity', text: `Okay. Please tell me the correct ${step.label}.` });
      saveAnswer(c, step, input, { intent: 'denied' });
      advanceStep(a);
      return turnFor(c, '');
    }
    const retry = retryOrSkip(a, step, 'Sorry, I did not catch that. Please say yes or no. ' + step.text);
    if (retry) return turnFor(c, '', retry);
    saveAnswer(c, step, input, { intent: 'unclear' });
    setCheck(a, 'confirm_' + step.key, `${step.label} confirmed`, 'unknown', 'No clear answer');
    advanceStep(a);
    return turnFor(c, 'Okay, let us move on.');
  }

  // ---- free / capture questions ----
  if (step.type === 'ask') {
    const j = prep.judge || {};
    if (input.empty || (j.intent === 'unclear' && !j.value && !j.clear)) {
      const retry = retryOrSkip(a, step, 'Sorry, I could not hear you. ' + step.text);
      if (retry) return turnFor(c, '', retry);
      saveAnswer(c, step, input, { intent: 'no_answer' });
      a.flags.push(`No answer to: ${step.text}`);
      advanceStep(a);
      return turnFor(c, 'Okay, let us continue.');
    }
    saveAnswer(c, step, input, { value: j.value || '', concern: j.concern || '' });
    if (step.kind === 'capture') {
      setCheck(a, 'confirm_' + step.key.replace('correct_', ''), 'Corrected detail', 'mismatch', `Customer gave: ${j.value || input.english}`);
      a.flags.push(`Customer corrected a record detail: ${j.value || input.english}`);
    }
    if (j.concern && !a.flags.includes(j.concern)) a.flags.push(j.concern);
    if (!j.clear && j.followUp && !step.isFollowUp) {
      a.queue.splice(a.i + 1, 0, { id: step.id + '_fu', type: 'ask', kind: 'free', key: step.key + '_fu', section: step.section, text: j.followUp, isFollowUp: true });
    }
    advanceStep(a);
    return turnFor(c, 'Thank you.');
  }

  // ---- face photo ----
  if (step.type === 'photo' && step.shot !== 'stand' && step.shot !== 'sit') {
    const f = prep.face || {};
    const ok = f.faceVisible && f.singleFace && !f.possibleSpoof;
    if (!ok) {
      const retry = retryOrSkip(a, step, 'I could not see your face clearly. Please hold the phone steady in front of your face, with good light, and stay alone in the frame. I will take the photo again in three seconds.', 2);
      if (retry) return turnFor(c, '', retry);
      setCheck(a, 'face_photo', 'Live face photo', 'fail', f.possibleSpoof || (f.faceVisible ? 'More than one face or unclear' : 'Face not visible'));
      a.flags.push('Live face photo could not be captured clearly');
    } else {
      setCheck(a, 'face_photo', 'Live face photo', 'pass', 'Single face visible, facing camera');
    }
    record(c, ok ? 'Live face photo captured by AI' : 'Live face photo failed after retries');
    a.facePhotoCaptured = !!ok;
    a.photos.face = !!ok;
    advanceStep(a);
    return turnFor(c, ok ? 'Thank you, I have your photo.' : 'Okay, we will continue.');
  }

  // ---- eye blink liveness ----
  if (step.type === 'burst') {
    const b = prep.blink || {};
    const ok = b.faceVisible && b.sameFaceAllFrames !== false && b.eyesClosedInSomeFrame && b.eyesOpenInSomeFrame && !b.possibleSpoof;
    if (!ok) {
      const why = !b.faceVisible ? 'I could not see your face clearly.' : !b.eyesClosedInSomeFrame ? 'I could not see your eyes close.' : 'I could not confirm the blink.';
      const retry = retryOrSkip(a, step, `${why} Please look straight at the camera, and slowly close your eyes for one second, then open them. Do this two times.`, 2);
      if (retry) return turnFor(c, '', retry);
      setCheck(a, 'blink', 'Eye blink liveness check', 'fail', b.possibleSpoof || why);
      a.flags.push('Eye blink liveness could not be confirmed');
    } else {
      setCheck(a, 'blink', 'Eye blink liveness check', 'pass', 'Eyes seen closed and open in live frames');
    }
    a.photos.blink = !!ok;
    record(c, ok ? 'Eye blink liveness confirmed by AI' : 'Eye blink liveness failed after retries');
    advanceStep(a);
    return turnFor(c, ok ? 'Thank you, that is done.' : 'Okay, we will continue.');
  }

  // ---- full body photo: standing / sitting ----
  if (step.type === 'photo') {
    const b = prep.body || {};
    const want = step.shot === 'sit' ? 'sitting' : 'standing';
    const label = step.shot === 'sit' ? 'Full body photo — sitting' : 'Full body photo — standing';
    const poseOk = b.pose === want;
    const ok = b.personVisible && b.singlePerson && b.fullBodyVisible && poseOk && !b.possibleSpoof;
    if (!ok) {
      const tip = b.guidance || (!b.personVisible ? 'I could not see you in the photo.' : !b.singlePerson ? 'Please make sure only you are in the frame.' : !b.fullBodyVisible ? 'Please step back so that your full body, from head to feet, is visible.' : `Please make sure you are ${want}.`);
      const retry = retryOrSkip(a, step, `${tip} I will take the photo again in ${step.countdown || 8} seconds.`, 2);
      if (retry) return turnFor(c, '', retry);
      const partial = b.personVisible && b.singlePerson && poseOk && !b.possibleSpoof;
      setCheck(a, 'body_' + step.shot, label, partial ? 'partial' : 'fail', b.possibleSpoof || (partial ? 'Pose correct but full body not visible' : `Expected ${want}, AI saw ${b.pose || 'unclear'}`));
      if (!partial) a.flags.push(`${label} could not be captured`);
    } else {
      setCheck(a, 'body_' + step.shot, label, 'pass', `${want}, full body visible${b.apparentAgeRange ? ', apparent age ' + b.apparentAgeRange : ''}`);
    }
    if (b.samePersonOpinion === 'likely_different') {
      setCheck(a, 'body_same_person_' + step.shot, `${label}: same person as face photo`, 'mismatch', 'AI thinks this may be a different person');
    }
    if (b.visibleHealthIndicators) {
      const note = `Visible in ${want} photo: ${b.visibleHealthIndicators} — compare with health disclosure`;
      if (!a.flags.includes(note)) a.flags.push(note);
    }
    a.photos[step.shot] = !!ok;
    if (b.apparentAgeRange) a.captured.apparentAgeRange = b.apparentAgeRange;
    record(c, `${label} ${ok ? 'captured by AI' : 'not clear after retries'}`);
    advanceStep(a);
    return turnFor(c, ok ? 'Thank you.' : 'Okay, we will continue.');
  }

  // ---- consent for the WhatsApp history check ----
  if (step.type === 'consent') {
    const j = prep.judge || {};
    if (j.intent !== 'yes' && j.intent !== 'no') {
      const retry = retryOrSkip(a, step, 'Sorry, I did not catch that. Please say yes or no. ' + step.text);
      if (retry) return turnFor(c, '', retry);
    }
    saveAnswer(c, step, input, { intent: j.intent === 'yes' ? 'confirmed' : j.intent === 'no' ? 'declined' : 'unclear' });
    if (j.intent === 'yes') {
      a.chatConsent = 'given';
      record(c, 'Customer agreed to search their WhatsApp and send screenshots of the results');
      advanceStep(a);
      return turnFor(c, '');
    }
    a.chatConsent = j.intent === 'no' ? 'declined' : 'unclear';
    setCheck(a, 'chat_history', 'WhatsApp history vs customer account', 'skipped', j.intent === 'no' ? 'Customer did not agree to the WhatsApp history check' : 'No clear answer to the request');
    a.flags.push(j.intent === 'no' ? 'Customer declined the WhatsApp history check' : 'WhatsApp history check not done (no clear consent)');
    record(c, j.intent === 'no' ? 'Customer declined the WhatsApp history check' : 'WhatsApp history check skipped — no clear consent');
    if (a.queue[a.i + 1] && a.queue[a.i + 1].id === 'chats') a.queue.splice(a.i + 1, 1);
    advanceStep(a);
    return turnFor(c, 'That is fine. We will skip this step.');
  }

  // ---- WhatsApp history screenshots ----
  if (step.type === 'docs' && step.doc === 'chats') {
    const d = a.docs.chats = a.docs.chats || { count: 0, entries: [], evidenceIds: [] };
    if (input.nudge) return turnFor(c, '', 'I could not read the last screenshot. Please take the screenshot again so that the chat names and dates are clearly visible, and send it.');
    if (input.done) d.done = true;
    if (input.skip || !docsReady(a, 'chats')) {
      setCheck(a, 'chat_history', 'WhatsApp history vs customer account', d.count ? 'unknown' : 'skipped', d.count ? 'Screenshots received but the customer did not finish' : 'No screenshots were sent');
      if (!d.count) a.flags.push('WhatsApp history check: no screenshots were sent');
      record(c, `WhatsApp history check ended — ${d.count} screenshot(s) received`);
      advanceStep(a);
      return turnFor(c, 'Okay, we will continue.');
    }
    const r = prep.chatReview;
    a.chatReview = r || null;
    if (r) {
      const res = r.consistent === true ? 'pass' : r.consistent === false ? 'mismatch' : 'unknown';
      setCheck(a, 'chat_history', 'WhatsApp history vs customer account', res, r.assessment || '');
      for (const x of r.concerns || []) { const f = 'WhatsApp history: ' + x; if (!a.flags.includes(f)) a.flags.push(f); }
    } else {
      setCheck(a, 'chat_history', 'WhatsApp history vs customer account', 'unknown', 'Screenshots saved; AI could not assess them — please review');
    }
    record(c, `WhatsApp history check — ${d.count} screenshot(s), ${d.entries.length} message(s) read by AI`);
    advanceStep(a);
    return turnFor(c, `Thank you, I have received ${d.count} screenshot${d.count === 1 ? '' : 's'}.`);
  }

  // ---- documents received on WhatsApp ----
  if (step.type === 'docs') {
    const label = step.doc === 'aadhaar' ? 'Aadhaar card' : 'PAN card';
    if (input.nudge) {
      return turnFor(c, '', `I could not read the last photo clearly. Please send a clearer photo of your ${label}, with all four corners visible and no glare.`);
    }
    if (!docsReady(a, step.doc) || input.skip) {
      a.flags.push(`${label} was not received during the call`);
      setCheck(a, step.doc + '_received', `${label} received`, 'fail', 'Not sent during the call');
      record(c, `${label} not received (customer skipped or timed out)`);
      advanceStep(a);
      return turnFor(c, 'Okay, we will continue without it.');
    }
    const d = a.docs[step.doc];
    setCheck(a, step.doc + '_received', `${label} received`, 'pass', 'Received on WhatsApp');
    let inject = null;
    let preface = `I have received your ${label}.`;

    if (step.doc === 'aadhaar') {
      if (d.name) preface += ` The name on it reads ${d.name}.`;
      if (prep.faceMatch) {
        const op = prep.faceMatch.samePersonOpinion;
        setCheck(a, 'face_vs_aadhaar', 'Live face vs Aadhaar photo', op === 'likely_same' ? 'match' : op === 'likely_different' ? 'mismatch' : 'unknown', { likely_same: 'AI opinion: likely the same person', likely_different: 'AI opinion: may be a different person', uncertain: 'AI could not decide' }[op] || '');
      }
      if (c.insuredName && d.name) {
        const m = nameMatch(d.name, c.insuredName);
        setCheck(a, 'name_aadhaar', 'Name on Aadhaar vs case record', m, `Aadhaar: ${d.name}`);
        if (m === 'mismatch' || m === 'partial') {
          inject = { id: 'name_explain', type: 'ask', kind: 'free', key: 'name_explain', section: 'identity', text: 'The name on your Aadhaar looks a little different from our record. Please tell me your name exactly as written in your policy application.' };
        }
      }
      if (prep.aadhaarRef) {
        const s = sec(c.id); s.aadhaarRef = prep.aadhaarRef; a.otpTried = true;
        a.queue.splice(a.i + 1, 0, { id: 'aadhaar_otp', type: 'otp', section: 'identity', text: 'I have sent a six digit OTP to the mobile number linked with your Aadhaar. Please read the OTP aloud now.' });
      } else if (prep.aadhaarApiError) {
        setCheck(a, 'aadhaar_api', 'Aadhaar verified with government record (API)', 'skipped', 'Verification service was not available');
      } else if (prep.noApi) {
        setCheck(a, 'aadhaar_api', 'Aadhaar verified with government record (API)', 'skipped', 'Verification service is not configured');
      }
    }

    if (step.doc === 'pan') {
      if (d.name) preface += ` The name on it reads ${d.name}.`;
      if (c.insuredName && d.name) setCheck(a, 'name_pan', 'Name on PAN vs case record', nameMatch(d.name, c.insuredName), `PAN: ${d.name}`);
      const aad = a.docs.aadhaar;
      if (aad.name && d.name) setCheck(a, 'name_aadhaar_pan', 'Name on Aadhaar vs PAN', nameMatch(aad.name, d.name), '');
      if (aad.dob && d.dob) setCheck(a, 'dob_aadhaar_pan', 'Date of birth on Aadhaar vs PAN', dobMatch(aad.dob, d.dob), '');
      if (prep.panApi) {
        const bad = looksFailed(prep.panApi);
        setCheck(a, 'pan_api', 'PAN verified with Income Tax record (API)', bad ? 'fail' : 'pass', bad ? 'Record did not match' : 'Name and date of birth accepted');
        if (bad) a.flags.push('PAN did not verify against the official record');
      } else if (prep.panApiError) {
        setCheck(a, 'pan_api', 'PAN verified with Income Tax record (API)', 'skipped', 'Verification service was not available');
      } else if (prep.noApi) {
        setCheck(a, 'pan_api', 'PAN verified with Income Tax record (API)', 'skipped', 'Verification service is not configured');
      }
    }
    record(c, `${label} read by AI and cross-checked`);
    if (inject) a.queue.splice(a.i + 1, 0, inject);
    advanceStep(a);
    return turnFor(c, preface + ' Thank you.');
  }

  // ---- Aadhaar OTP spoken by the customer ----
  if (step.type === 'otp') {
    const ok = prep.otpResult && !looksFailed(prep.otpResult);
    if (ok) {
      const dd = prep.otpResult.data || prep.otpResult;
      const apiName = dd.name || dd.full_name || '';
      const apiDob = dd.date_of_birth || dd.dob || '';
      setCheck(a, 'aadhaar_api', 'Aadhaar verified with government record (API)', 'pass', 'OTP verified');
      if (apiName && a.docs.aadhaar.name) setCheck(a, 'name_aadhaar_api', 'Name on Aadhaar card vs official record', nameMatch(apiName, a.docs.aadhaar.name), '');
      if (apiDob && a.docs.aadhaar.dob) setCheck(a, 'dob_aadhaar_api', 'DOB on Aadhaar card vs official record', dobMatch(apiDob, a.docs.aadhaar.dob), '');
      const mob = String(dd.mobile_number || dd.mobile || dd.masked_mobile || '').match(/(\d{4})\D*$/);
      if (mob && c.whatsappNumber && mob[1] !== c.whatsappNumber.slice(-4)) {
        setCheck(a, 'aadhaar_mobile', 'Aadhaar-linked mobile vs WhatsApp number', 'mismatch', `Aadhaar mobile ends ${mob[1]}, WhatsApp ends ${c.whatsappNumber.slice(-4)}`);
        a.flags.push('Aadhaar-linked mobile does not match the WhatsApp number used');
      }
      record(c, 'Aadhaar OTP verified through API');
      advanceStep(a);
      return turnFor(c, 'Thank you, your Aadhaar is verified.');
    }
    const retry = retryOrSkip(a, step, 'That OTP did not work. Please read the OTP again, slowly, digit by digit.');
    if (retry && !prep.otpError) return turnFor(c, '', retry);
    setCheck(a, 'aadhaar_api', 'Aadhaar verified with government record (API)', 'fail', 'OTP could not be verified');
    a.flags.push('Aadhaar OTP verification failed');
    advanceStep(a);
    return turnFor(c, 'Okay, we will continue.');
  }

  return turnFor(c, '');
}

// ---------- WhatsApp document ingestion (called from the webhook) ----------
async function prepareIdMedia(buffer, mimeType) {
  return gemini.extractIdDocument(buffer.toString('base64'), mimeType || 'image/jpeg');
}

// Sync, on a fresh case. Returns a short event string or null.
function applyIdMedia(c, ex, buffer, meta = {}) {
  const a = c.aiCall;
  if (!a || a.status !== 'in_progress') return null;
  const step = a.queue && a.queue[a.i];
  const shot = meta.analysis && meta.analysis.chatScreenshot;
  if (step && step.doc === 'chats' && (shot || (ex && ex.documentType === 'screenshot'))) {
    const d = a.docs.chats = a.docs.chats || { count: 0, entries: [], evidenceIds: [] };
    d.count += 1;
    if (meta.evidenceId) d.evidenceIds.push(meta.evidenceId);
    for (const e of (shot && shot.entries) || []) d.entries.push({ ...e, searchTerm: shot.searchTerm || '', evidenceId: meta.evidenceId || null });
    record(c, `WhatsApp search screenshot received${shot && shot.searchTerm ? ' (search: "' + shot.searchTerm + '")' : ''} — ${(shot && shot.entries || []).length} result(s) read`, 'ai_agent');
    return 'chats';
  }
  const s = sec(c.id);
  if (!ex || !ex.readable) { a.docs.unreadable = (a.docs.unreadable || 0) + 1; record(c, 'A WhatsApp photo could not be read by AI', 'ai_agent'); return 'unreadable'; }

  const num = String(ex.idNumber || '').replace(/\s/g, '').toUpperCase();
  if (ex.documentType === 'aadhaar') {
    const d = a.docs.aadhaar;
    const isFront = ex.side === 'front' || (ex.side === 'unknown' && !!num);
    const isBack = ex.side === 'back' || (ex.side === 'unknown' && !!ex.address && !num);
    if (isFront) {
      d.front = true;
      if (ex.name) d.name = ex.name;
      if (ex.dob) d.dob = ex.dob;
      if (ex.gender) d.gender = ex.gender;
      if (/^\d{12}$/.test(num)) { s.aadhaarNumber = num; d.last4 = num.slice(-4); d.masked = maskId(num); }
      if (buffer && buffer.length < 1_500_000) s.aadhaarFrontB64 = buffer.toString('base64');
    }
    if (isBack || ex.address) { d.back = d.back || isBack || !!ex.address; if (ex.address) d.address = ex.address; }
    if (isFront && ex.address) d.back = true; // some scans show both sides together
    d.received = true;
    record(c, `Aadhaar ${isFront ? 'front' : ''}${isFront && isBack ? ' + ' : ''}${isBack ? 'back' : ''} received and read (number ${d.masked || 'not visible'})`, 'ai_agent');
    return 'aadhaar';
  }
  if (ex.documentType === 'pan') {
    const d = a.docs.pan;
    d.received = true;
    if (ex.name) d.name = ex.name;
    if (ex.dob) d.dob = ex.dob;
    if (ex.fatherName) d.fatherName = ex.fatherName;
    if (/^[A-Z]{5}\d{4}[A-Z]$/.test(num)) { s.panNumber = num; d.masked = maskId(num); }
    record(c, `PAN card received and read (number ${d.masked || 'not visible'})`, 'ai_agent');
    return 'pan';
  }
  a.docs.other.push({ type: ex.documentType, name: ex.name || '', at: now() });
  record(c, `Other document received on WhatsApp (${ex.documentType})`, 'ai_agent');
  return 'other';
}

// ---------- completion ----------
async function prepareFinish(c) {
  const a = c.aiCall;
  runDerivedChecks(c);
  const caseInfo = { claimNo: c.claimNo, insuredName: c.insuredName, policyNo: c.policyNo, vehicleNo: c.vehicleNo, district: c.district, policyValue: c.policyValue };
  try {
    return await gemini.summarizeAiCall({ caseType: typeLabel(c), caseInfo, answers: a.answers, checks: a.checks, flags: a.flags });
  } catch (e) {
    return { summary: '', sections: {}, concerns: [] };
  }
}

function runDerivedChecks(c) {
  const a = c.aiCall;
  const dobAnswer = a.answers.find(x => x.key === 'dob');
  const aadDob = a.docs.aadhaar.dob;
  if (dobAnswer && (dobAnswer.value || dobAnswer.english) && aadDob) {
    setCheck(a, 'dob_spoken_aadhaar', 'Date of birth stated vs Aadhaar', dobMatch(dobAnswer.value || dobAnswer.english, aadDob), `Said: ${dobAnswer.value || dobAnswer.english}`);
  }
  const addr = a.docs.aadhaar.address;
  if (c.district && addr) {
    const hit = addr.toLowerCase().includes(String(c.district).toLowerCase());
    setCheck(a, 'district_aadhaar', 'Case district appears in Aadhaar address', hit ? 'match' : 'unknown', hit ? '' : 'District not found in the printed address');
  }
}

function applyFinish(c, summary) {
  const a = c.aiCall;
  runDerivedChecks(c);
  const bad = a.checks.filter(x => x.result === 'mismatch' || x.result === 'fail');
  const partial = a.checks.filter(x => x.result === 'partial');
  for (const b of bad) {
    if (b.id === 'chat_history' && a.flags.some(x => x.startsWith('WhatsApp history:'))) continue; // its points are already listed
    const f = `${b.label}: ${b.detail || b.result}`;
    if (!a.flags.includes(f)) a.flags.push(f);
  }
  for (const p of partial) a.flags.push(`${p.label}: partial match${p.detail ? ' (' + p.detail + ')' : ''}`);

  const photos = a.photos || {};
  const bodyMissing = isPolicy(c) && (!photos.stand || !photos.sit);
  const incomplete = !a.docs.aadhaar.received || !a.docs.pan.received || !a.facePhotoCaptured || !photos.blink || bodyMissing || a.answers.length < 3;
  const decision = bad.length ? 'found_discrepancy' : ((incomplete || a.flags.length) ? 'partially_verified' : 'verified');
  a.decision = decision;
  a.summary = summary.summary || '';
  a.concerns = summary.concerns || [];
  a.status = 'completed';
  a.completedAt = now();

  if (c.caseType === 'policy_verification') {
    c.pivcChecklist = c.pivcChecklist || {};
    for (const key of ['identity', 'healthDisclosure', 'incomeOccupation', 'nominee', 'policyDetails']) {
      const sec_ = (summary.sections || {})[key];
      if (sec_) c.pivcChecklist[key] = { status: ['confirmed', 'discrepancy'].includes(sec_.status) ? sec_.status : 'pending', notes: sec_.notes || '' };
    }
    if (bad.length && c.pivcChecklist.identity && c.pivcChecklist.identity.status !== 'discrepancy') c.pivcChecklist.identity.status = 'discrepancy';
    c.pivcResult = decision;
  }

  const spot = Math.random() < (1 / 15);
  c.spotCheckRequired = spot;
  c.verificationFlags = [...a.flags, ...(spot ? ['Randomly selected for executive spot-check'] : [])];
  c.status = (decision === 'verified' && !spot) ? 'completed' : c.status;
  record(c, `AI verification call completed — result: ${decision}${a.flags.length ? '; flags: ' + a.flags.join('; ') : ''}`, 'system_check');
  secrets.delete(c.id); // drop full ID numbers and photos from memory
}

// Lat/long captured with each photo. Returns a short text for the evidence caption.
function notePhotoLocation(c, loc, what) {
  const a = c.aiCall;
  if (!validLoc(loc)) {
    record(c, `${what}: location not available from the device`, 'participant');
    return 'location not available';
  }
  const l = { latitude: Number(loc.latitude), longitude: Number(loc.longitude), accuracy: loc.accuracy ? Math.round(loc.accuracy) : null };
  (a.locations = a.locations || []).push({ what, ...l, at: now() });
  c.lastKnownLocation = { ...l, capturedAt: now() };
  const txt = `${l.latitude.toFixed(5)}, ${l.longitude.toFixed(5)}${l.accuracy ? ' (±' + l.accuracy + 'm)' : ''}`;
  record(c, `${what} — location ${txt}`, 'participant');
  if (a.startLocation) {
    const km = distanceKm(a.startLocation, l);
    if (km > 2) {
      const f = `Location changed by ${km.toFixed(1)} km during the call (${what})`;
      if (!a.flags.includes(f)) a.flags.push(f);
    }
  } else {
    a.startLocation = { ...l, at: now() };
  }
  return txt;
}

// Customer tapped "Talk to a person" — stop the AI and hand over to the team.
function requestHuman(c, reason) {
  const a = c.aiCall;
  if (!a || a.status !== 'in_progress') return false;
  a.status = 'handoff';
  a.handoffAt = now();
  a.flags = a.flags || [];
  a.flags.push('Customer asked to speak to a person — executive call needed');
  c.needsExecutive = true;
  c.verificationFlags = [...(c.verificationFlags || []), 'Customer asked for a human executive during the AI call'];
  record(c, `Customer asked to talk to a person${reason ? ' (' + reason + ')' : ''} — AI call stopped, handed over to the team`, 'participant');
  secrets.delete(c.id);
  return true;
}

// Customer closed the page / dropped before the end.
function markAbandoned(c) {
  if (c.aiCall && c.aiCall.status === 'in_progress') {
    record(c, 'Customer left the AI call before it finished (can rejoin with the same link)', 'participant');
  }
}

function publicStatus(c) {
  const a = c.aiCall || {};
  const docs = a.docs || {};
  const step = a.queue && a.queue[a.i];
  return {
    status: a.status || 'not_started',
    stage: step ? step.id : null,
    aadhaar: { front: !!(docs.aadhaar || {}).front, back: !!(docs.aadhaar || {}).back },
    pan: { received: !!(docs.pan || {}).received },
    chats: { count: (docs.chats || {}).count || 0 },
    unreadable: docs.unreadable || 0,
    ready: step && step.type === 'docs' ? docsReady(a, step.doc) : false
  };
}

module.exports = {
  startSession, prepare, apply, prepareIdMedia, applyIdMedia, prepareFinish, applyFinish,
  markAbandoned, publicStatus, turnFor, peekTurn, nameMatch, dobMatch, typeLabel, buildQueue, docsReady,
  notePhotoLocation, requestHuman, distanceKm
};
