// Builds the data for the "AI-Assisted Verification Report" (ai-report.html).
// The same safe shape is returned to the vendor dashboard and to the public
// share link, so nothing secret (call token, WhatsApp number, full ID numbers,
// internal queue) can leak through either one.

const { typeLabel } = require('./ai-call-engine');
const { fileLink, documentRows, recordingRows, chatRows } = require('./report-files');

const SECTION_LABELS = {
  identity: 'Identity',
  policyDetails: 'Policy details and sales practice',
  healthDisclosure: 'Health disclosure',
  incomeOccupation: 'Income and occupation',
  nominee: 'Nominee',
  lossDetails: 'Loss details',
  police: 'Police / FIR',
  vehicle: 'Vehicle',
  witness: 'Witnesses',
  chatHistory: 'WhatsApp history check'
};
const PIVC_ORDER = ['identity', 'policyDetails', 'healthDisclosure', 'incomeOccupation', 'nominee'];
const CLAIM_ORDER = ['identity', 'lossDetails', 'police', 'vehicle', 'witness'];

const PHOTO_TYPES = {
  liveness_selfie: 'Live face photo',
  liveness_blink: 'Eye-blink check',
  body_standing: 'Full body — standing',
  body_sitting: 'Full body — sitting'
};

const maskPhone = p => (p ? '••••••' + String(p).slice(-4) : '');

function answerText(x) {
  if (x.section === 'chatHistory') return x.intent === 'confirmed' ? 'Agreed to search WhatsApp and send screenshots' : x.intent === 'declined' ? 'Did not agree' : (x.english || 'No clear answer');
  if (x.intent === 'confirmed') return 'Confirmed as correct';
  if (x.intent === 'denied') return `Said this is not correct${x.value ? ': ' + x.value : ''}`;
  if (x.intent === 'no_answer' || x.intent === 'unclear') return '';
  return x.english || x.value || '';
}

function buildAiReport(c, { evidence = [], custody = [], firm = '', publicView = false } = {}) {
  const a = c.aiCall || {};
  const isPolicy = c.caseType === 'policy_verification';
  const started = a.startedAt ? new Date(a.startedAt) : null;
  const ended = a.completedAt ? new Date(a.completedAt) : (a.handoffAt ? new Date(a.handoffAt) : null);

  const deviceEv = custody.find(x => /^Device recorded:/.test(x.event));
  const disclosed = custody.some(x => /AI-assisted call/.test(x.event));

  // Photos: keep every attempt (retries are part of the evidence), best last.
  const photos = evidence
    .filter(e => e.source === 'ai_call' && PHOTO_TYPES[e.type])
    .sort((x, y) => Object.keys(PHOTO_TYPES).indexOf(x.type) - Object.keys(PHOTO_TYPES).indexOf(y.type) || new Date(x.receivedAt) - new Date(y.receivedAt))
    .map(e => ({ type: e.type, label: PHOTO_TYPES[e.type], url: e.fileUrl, link: fileLink(c, e), at: e.receivedAt, location: e.location || null }));
  const recordings = recordingRows(c, evidence);
  const aiRecording = recordings.filter(x => x.kind === 'AI verification call').slice(-1)[0] || null;
  const received = documentRows(c, evidence);

  const order = isPolicy ? PIVC_ORDER : CLAIM_ORDER;
  const answers = a.answers || [];
  const checklist = c.pivcChecklist || {};
  const sections = order.map(key => ({
    key,
    label: SECTION_LABELS[key] || key,
    status: (checklist[key] || {}).status || null,
    notes: (checklist[key] || {}).notes || '',
    qa: answers.filter(x => (x.section || 'identity') === key).map(x => ({
      question: x.question,
      answer: answerText(x),
      original: x.original && x.original !== x.english ? x.original : '',
      language: x.language || '',
      concern: x.concern || '',
      at: x.at
    }))
  })).filter(s => s.qa.length || s.status);

  const docs = a.docs || {};
  const pick = (o, keys) => keys.reduce((r, k) => (o && o[k] ? { ...r, [k]: o[k] } : r), {});

  return {
    meta: {
      reportNo: `${c.caseRef || 'PR-' + String(c.claimNo || '').replace(/[^A-Za-z0-9]/g, '').slice(-10)}-R${(a.completedAt || a.startedAt || c.createdAt || '').slice(2, 10).replace(/-/g, '')}`,
      generatedAt: new Date().toISOString(),
      firm,
      caseTypeLabel: typeLabel(c),
      isPolicy,
      policyType: c.policyType || null
    },
    case: {
      caseRef: c.caseRef || '', caseId: c.id, claimNo: c.claimNo, policyNo: c.policyNo || '', insuredName: c.insuredName || '',
      whatsapp: maskPhone(c.whatsappNumber), district: c.district || '', vehicleNo: c.vehicleNo || '',
      policyValue: c.policyValue || null, createdAt: c.createdAt, status: c.status,
      spotCheckRequired: !!c.spotCheckRequired, needsExecutive: !!c.needsExecutive
    },
    call: {
      status: a.status || 'not_started',
      language: a.language || '',
      startedAt: a.startedAt || null,
      endedAt: ended ? ended.toISOString() : null,
      durationMin: started && ended ? Math.max(1, Math.round((ended - started) / 60000)) : null,
      startLocation: a.startLocation || null,
      device: deviceEv ? deviceEv.event.replace(/^Device recorded:\s*/, '').replace(/,?\s*IP\s+\S+$/, '') : '',
      aiDisclosed: disclosed,
      consent: !!a.startedAt,
      recordingUrl: aiRecording ? aiRecording.link : null
    },
    result: {
      decision: a.decision || (a.status === 'handoff' ? 'handoff' : null),
      pivcResult: c.pivcResult || null,
      summary: a.summary || '',
      concerns: a.concerns || [],
      flags: a.flags || [],
      apparentAge: (a.captured || {}).apparentAgeRange || ''
    },
    photos,
    documents: {
      aadhaar: pick(docs.aadhaar, ['name', 'dob', 'gender', 'masked', 'address']),
      pan: pick(docs.pan, ['name', 'dob', 'fatherName', 'masked'])
    },
    checks: (a.checks || []).map(k => ({ label: k.label, result: k.result, detail: k.detail || '' })),
    sections,
    locations: (a.locations || []).map(l => ({ what: l.what, latitude: l.latitude, longitude: l.longitude, accuracy: l.accuracy, at: l.at })),
    received,
    chatHistory: {
      consent: a.chatConsent || null,
      keywords: ((a.queue || []).find(x => x.id === 'chats') || {}).keywords || [],
      review: a.chatReview || null,
      rows: chatRows(c, evidence)
    },
    recordings,
    custody: custody.map(x => ({ at: x.timestamp, event: publicView ? x.event.replace(/,?\s*(from\s+)?IP\s+[0-9a-f:.]+/gi, '') : x.event, actor: x.actor })),
    review: c.aiReview || null
  };
}

module.exports = { buildAiReport };
