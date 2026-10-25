// Builds the data for the "AI-Assisted Verification Report" (ai-report.html).
// The same safe shape is returned to the vendor dashboard and to the public
// share link, so nothing secret (call token, WhatsApp number, full ID numbers,
// internal queue) can leak through either one.

const crypto = require('crypto');
const { typeLabel } = require('./ai-call-engine');
const ckl = require('./checklist');
const { fileLink, documentRows, recordingRows, chatRows } = require('./report-files');

const profiles = require('./service-profiles');
const SECTION_LABELS = profiles.SECTION_LABELS;
const PIVC_ORDER = ['identity', 'policyDetails', 'healthDisclosure', 'incomeOccupation', 'nominee', 'custom'];
const CLAIM_ORDER = ['identity', 'lossDetails', 'police', 'vehicle', 'witness', 'custom'];

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

  const svc = require('./plans').serviceOfCase(c);
  const order = profiles.profileOf(svc).order || (isPolicy ? PIVC_ORDER : CLAIM_ORDER);
  const answers = a.answers || [];
  const checklist = c.pivcChecklist || {};
  const sections = order.map(key => ({
    key,
    label: SECTION_LABELS[key] || key,
    status: (checklist[key] || {}).status || null,
    notes: (checklist[key] || {}).notes || '',
    qa: answers.filter(x => (x.section || 'identity') === key).map(x => ({
      key: x.key || '',
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

  const has = id => (a.checks || []).some(k => k.id === id && k.result !== 'unknown');
  const out = {
    meta: {
      reportNo: `${c.caseRef || 'PR-' + String(c.claimNo || '').replace(/[^A-Za-z0-9]/g, '').slice(-10)}-R${(a.completedAt || a.startedAt || c.createdAt || '').slice(2, 10).replace(/-/g, '')}`,
      generatedAt: new Date().toISOString(),
      firm,
      caseTypeLabel: typeLabel(c),
      isPolicy,
      service: svc,
      policyType: c.policyType || null
    },
    case: {
      caseRef: c.caseRef || '', caseId: c.id, claimNo: c.claimNo, policyNo: c.policyNo || '', insuredName: c.insuredName || '',
      whatsapp: maskPhone(c.whatsappNumber), district: c.district || '', vehicleNo: c.vehicleNo || '',
      policyValue: c.policyValue || null, createdAt: c.createdAt, status: c.status,
      spotCheckRequired: !!c.spotCheckRequired, needsExecutive: !!c.needsExecutive,
      ...(c.details ? { details: publicView ? { ...c.details, mobile: c.details.mobile ? maskPhone(c.details.mobile) : undefined } : c.details } : {})
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
      liveCallReasons: a.liveCallReasons || [],
      apparentAge: (a.captured || {}).apparentAgeRange || ''
    },
    photos,
    documents: {
      aadhaar: pick(docs.aadhaar, ['name', 'dob', 'gender', 'masked', 'address']),
      pan: pick(docs.pan, ['name', 'dob', 'fatherName', 'masked'])
    },
    checks: (a.checks || []).map(k => ({ id: k.id, label: k.label, result: k.result, detail: k.detail || '', ...(k.area ? { area: k.area } : {}), ...(/^rec_/.test(k.id || '') ? { expected: k.expected || '', said: k.said || '', type: k.type || '' } : {}) })),
    crossCase: (a.crossCase || []).map(x => x.text || String(x)),
    triggers: (() => {
      const data = require('../db').db.data, rules = require('./record-rules');
      const own = (data.evidence || []).filter(e => e.caseId === c.id);
      return [...profiles.triggers(svc, c).map(t => ({ source: 'record', ...t })), ...rules.crossCase(c, data), ...rules.fileRules(c, data, own)];
    })(),
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
    review: c.aiReview || null,
    reviewHistory: (c.aiReviewHistory || []).map(r => ({ finalVerdict: r.finalVerdict, remarks: r.remarks, reviewerName: r.reviewerName, reviewerDesignation: r.reviewerDesignation, reviewedAt: r.reviewedAt })),
    reviewState: c.reviewState || null,
    checklist: (() => { const items = ckl.buildChecklist(c); return { items, ...ckl.summarize(items) }; })(),
    recordingMissing: a.status === 'completed' && !aiRecording,
    idSources: {
      aadhaar: !(docs.aadhaar || {}).received ? 'Not received' : has('aadhaar_api') ? 'Checked with the official Aadhaar record (OTP verification)' : 'Read by AI from the photo only — not checked with the official record',
      pan: !(docs.pan || {}).received ? 'Not received' : has('pan_api') ? 'Checked with the official PAN record' : 'Read by AI from the photo only — not checked with the official record'
    }
  };
  // Fingerprint: changes if anything in the report is altered later. Same value on the dashboard and on the share link.
  const body = { r: out.meta.reportNo, case: out.case, call: { ...out.call, recordingUrl: !!out.call.recordingUrl }, result: out.result, photos: out.photos.map(p => [p.type, p.at]), documents: out.documents,
    checks: out.checks.map(k => ({ label: k.label, result: k.result, detail: k.detail })), sections: out.sections.map(x => ({ ...x, qa: x.qa.map(({ key, ...q }) => q) })), locations: out.locations, custody: custody.map(x => [x.timestamp, x.event, x.actor]), review: out.review, history: out.reviewHistory, checklist: out.checklist.items.map(i => [i.id, i.status]) };
  out.meta.fingerprint = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return out;
}

module.exports = { buildAiReport };
