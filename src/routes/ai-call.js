// Public routes for the full-automation AI verification call (customer side).
// Identified by an unguessable per-case token sent on WhatsApp — no login.
const express = require('express');
const multer = require('multer');
const { db, uid } = require('../db');
const gemini = require('../services/gemini');
const storage = require('../services/storage');
const engine = require('../services/ai-call-engine');
const { caseFileKey } = require('../services/ids');
const { pcmToWav } = require('../services/wav');
const { rateLimit } = require('../services/security');
const webhooks = require('../services/webhooks');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const fs = require('fs');
const os = require('os');
// recordings go to a temp file and are streamed to storage (no big buffers in memory)
const uploadVideo = multer({ storage: multer.diskStorage({ destination: os.tmpdir() }), limits: { fileSize: 1024 * 1024 * 1024 } });
const router = express.Router();
// deletes the temp upload file once the response is done (success or error)
const cleanTmp = (req, res, next) => { res.on('close', () => { if (req.file && req.file.path) fs.promises.unlink(req.file.path).catch(() => {}); }); next(); };

router.use(rateLimit({ windowMs: 60_000, max: 120 }));
// AI cost is counted against this case and firm (usage.js).
router.use('/:token', (req, res, next) => {
  const c = (db.data.cases || []).find(x => x.aiCall && x.aiCall.token === req.params.token);
  if (!c) return next();
  require('../services/usage').run({ caseId: c.id, firmId: c.vendorId }, next);
});

async function load(token) {
  await db.read();
  return db.data.cases.find(c => c.aiCall && c.aiCall.token === token);
}

// Turns the AI's English line into the customer's language + Gemini voice.
// Translation and voice are remembered (same question, same language = no new Gemini cost), and
// the Super Admin can switch the AI voice off: then the customer's phone reads the text aloud (free).
const speechCache = require('../services/speech-cache');
const speakInflight = new Map();
function speak(text, language) { // same line asked twice at once (prefetch + real turn) = one Gemini job
  const k = (language || '') + '|' + text;
  if (speakInflight.has(k)) return speakInflight.get(k);
  const p = speakInner(text, language).finally(() => speakInflight.delete(k));
  speakInflight.set(k, p);
  return p;
}
async function speakInner(text, language) {
  let displayText = text, problem = null;
  const lang = language && language !== 'English' ? language : '';
  try {
    if (lang) {
      displayText = speechCache.get('t', lang, text);
      if (displayText === undefined) { displayText = await gemini.translateText(text, lang); speechCache.set('t', lang, text, displayText); }
    }
  } catch (e) { displayText = text; console.warn('AI call translate failed:', e.message); problem = 'translation: ' + shortErr(e); }
  let audio = null;
  const voiceOff = (await require('../services/platform-settings').getSetting('aiVoice', 'AI_VOICE')) === 'phone';
  if (!voiceOff) {
    audio = speechCache.get('a', lang, displayText) || null;
    if (!audio) {
      try {
        const { base64Audio, mimeType } = await gemini.generateSpeech(displayText);
        audio = pcmToWav(Buffer.from(base64Audio, 'base64'), mimeType).toString('base64');
        speechCache.set('a', lang, displayText, audio);
      } catch (e) { console.warn('AI call TTS failed:', e.message); problem = (problem ? problem + '; ' : '') + 'voice: ' + shortErr(e); }
    }
  }
  return { displayText, audio, problem };
}
// After each answer, translate + voice the next few questions in the background, so the next turn
// finds them ready (cache) instead of making the customer wait for Gemini.
async function warmAhead(token) {
  try {
    const c = await load(token);
    const a = c && c.aiCall;
    if (!a || a.status !== 'in_progress' || !Array.isArray(a.queue)) return;
    await require('../services/usage').run({ caseId: c.id, firmId: c.vendorId }, async () => {
      for (const st of a.queue.slice(a.i, a.i + 4)) {
        if (st && st.text && st.type !== 'close') await speak(st.text, a.language);
      }
    });
  } catch { /* best effort */ }
}
router.use((req, res, next) => {
  const m = req.method === 'POST' && req.path.match(/^\/([^/]+)\/(start|turn|advance|photo|burst)$/);
  if (m) res.on('finish', () => setTimeout(() => warmAhead(m[1]), 50));
  next();
});
async function withVoice(turn, language, c) {
  const v = await speak(turn.say, language);
  // First time the AI voice or translation fails in a call, note it in the case history.
  if (v.problem && c && c.aiCall && !c.aiCall.voiceProblemLogged) {
    try {
      await db.read();
      const fresh = db.data.cases.find(x => x.id === c.id);
      if (fresh && fresh.aiCall && !fresh.aiCall.voiceProblemLogged) {
        fresh.aiCall.voiceProblemLogged = true;
        custody(fresh, `AI voice/translation problem (${v.problem}) — the phone's own voice was used`);
        await db.write();
      }
    } catch {}
  }
  return { ...turn, displayText: v.displayText, audio: v.audio };
}
function wrongStage(c, stage) {
  const a = c.aiCall;
  const step = a.queue && a.queue[a.i];
  return !step || (stage && step.id !== stage);
}
const notFound = res => res.status(404).json({ error: 'This verification link is invalid.' });
const now = () => new Date().toISOString();
const custody = (c, event) => db.data.custody.push({ id: uid('cust'), caseId: c.id, event, actor: 'ai_agent', timestamp: now() });
const shortErr = e => String((e && e.message) || e || 'error').replace(/key=[^&\s]+/gi, 'key=…').replace(/\s+/g, ' ').slice(0, 160);

// File storage (R2) failed: keep the call going, and tell the team why.
function noteStorageProblem(c, err) {
  const a = c.aiCall;
  const note = 'Some photos could not be saved to file storage — check Super Admin → Storage settings';
  if (!a.flags.includes(note)) a.flags.push(note);
  if (!a.storageProblemLogged) { a.storageProblemLogged = true; custody(c, `Photo could not be saved to file storage (${err}) — check the R2 settings in Super Admin`); }
}

// Only one screen may run the call. Each page load sends its own id in the
// X-Call-Client header; the latest /start wins, older screens get 409 and stop
// (otherwise two tabs = two AI voices talking over each other).
router.use('/:token', async (req, res, next) => {
  if (req.method !== 'POST' || /^\/(start|left|handoff)$/.test(req.path)) return next();
  const cid = req.get('X-Call-Client');
  if (!cid) return next();
  const c = await load(req.params.token);
  if (c && c.aiCall) c.aiCall.lastActivityAt = now(); // reminders are not sent while the customer is on the call
  if (c && c.aiCall && c.aiCall.clientId && c.aiCall.clientId !== cid) return res.status(409).json({ error: 'This call continued on another screen.', replaced: true });
  next();
});

router.get('/:token/info', async (req, res) => {
  const c = await load(req.params.token);
  if (!c) return notFound(res);
  // The case's own number first; otherwise any number the vendor has connected,
  // so the customer's WhatsApp button never ends up dead.
  const acct = db.data.whatsappAccounts.find(a => a.id === c.whatsappAccountId)
    || db.data.whatsappAccounts.find(a => a.vendorId === c.vendorId && a.displayPhoneNumber)
    || null;
  const vendor = (db.data.users || []).find(u => u.id === c.vendorId);
  res.json({
    status: c.aiCall.status || 'not_started',
    caseTypeLabel: engine.typeLabel(c),
    isPolicy: c.caseType === 'policy_verification',
    service: require('../services/plans').serviceOfCase(c),
    policyType: c.policyType || null,
    firm: vendor && vendor.vendorName ? vendor.vendorName : '',
    caseRef: '••••' + String(c.claimNo).slice(-4),
    businessNumber: acct ? String(acct.displayPhoneNumber || '').replace(/\D/g, '') : null
  });
});

router.post('/:token/start', async (req, res) => {
  const { language, consent, location, deviceInfo } = req.body || {};
  if (!consent) return res.status(400).json({ error: 'Consent is required to start the call.' });
  const c = await load(req.params.token);
  if (!c) return notFound(res);
  if (c.aiCall.status === 'completed') return res.json({ done: true, message: 'This verification is already complete. Thank you.' });
  if (c.aiCall.status === 'handoff') return res.json({ done: true, message: 'You asked to speak to a person. Our team will call you soon. Thank you.' });
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const attempt = String((req.body || {}).attempt || '').slice(0, 40);
  const clientId = String(req.get('X-Call-Client') || '').slice(0, 40);
  try {
    // Same tap sent again (slow network retry): answer with the same welcome, do not "re-join".
    if (attempt && c.aiCall.status === 'in_progress' && c.aiCall.startAttempt === attempt) {
      if (clientId) c.aiCall.clientId = clientId;
      await db.write();
      const turn = c.aiCall.i === 0 && !(c.aiCall.answers || []).length ? engine.turnFor(c, engine.welcomeText(c), null, true) : engine.peekTurn(c);
      return res.json({ turn: await withVoice(turn, c.aiCall.language, c) });
    }
    const firmRow = (db.data.users || []).find(u => u.id === c.vendorId);
    const turn = engine.startSession(c, { language: language || 'English', location, deviceInfo, ip, config: require('../services/checklist-config').forCase(firmRow, c) });
    c.aiCall.startAttempt = attempt || null;
    if (clientId) c.aiCall.clientId = clientId;
    await db.write();
    res.json({ turn: await withVoice(turn, c.aiCall.language, c) });
  } catch (err) {
    console.error('AI call start error:', err.message);
    res.status(500).json({ error: 'Could not start the call. Please try again.' });
  }
});

router.post('/:token/turn', upload.single('audio'), async (req, res) => {
  const c0 = await load(req.params.token);
  if (!c0) return notFound(res);
  if (c0.aiCall.status !== 'in_progress') return res.status(409).json({ error: 'The call is not active.' });
  const stage = req.body.stage;
  try {
    let input = { empty: true }, sttError = null, noisy = false;
    const typed = String(req.body.text || '').trim().slice(0, 500);
    if (typed) {
      // Customer typed the answer (voice not working / noisy place).
      let english = typed;
      if (c0.aiCall.language && c0.aiCall.language !== 'English') {
        try { english = (await gemini.translateText(typed, 'English')).replace(/^"|"$/g, '').trim() || typed; } catch { english = typed; }
      }
      input = { english, original: typed, language: c0.aiCall.language, typed: true };
    } else if (req.file && req.file.size > 3000 && req.body.silence !== '1') {
      try {
        const t = await gemini.transcribeAndTranslateAudio(req.file.buffer.toString('base64'), 'audio/wav');
        const english = String(t.english || '').trim();
        if (english && t.clear !== false) input = { english, original: t.original, language: t.language, otherVoice: t.otherVoiceHeard === true };
        else noisy = true; // only noise / too faint: treated as "not heard", never as an answer
      } catch (e) {
        sttError = shortErr(e);
        console.error('AI call speech-to-text failed:', sttError);
      }
    }

    if (sttError) {
      // Do not count this as the customer's answer: ask again, and offer typing.
      await db.read();
      const c = db.data.cases.find(x => x.id === c0.id);
      const a = c.aiCall;
      a.sttErrors = (a.sttErrors || 0) + 1;
      a.lastSttError = { at: now(), message: sttError };
      if (a.sttErrors === 1 || a.sttErrors % 5 === 0) custody(c, `AI could not process the customer's voice (${sttError}) — asked again; typing offered`);
      await db.write();
      const step = a.queue[a.i];
      const turn = engine.turnFor(c, 'Sorry, I could not understand that.', a.sttErrors >= 2 ? `${step.text} You can also type your answer in the box below.` : step.text, true);
      return res.json({ turn: { ...(await withVoice(turn, a.language, c)), typeHint: a.sttErrors >= 2 }, heard: null });
    }

    const prep = wrongStage(c0, stage) ? {} : await engine.prepare(c0, input);

    await db.read();
    const c = db.data.cases.find(x => x.id === c0.id);
    if (input.otherVoice && c && c.aiCall) c.aiCall.otherVoice = (c.aiCall.otherVoice || 0) + 1;
    let turn;
    if (wrongStage(c, stage)) turn = engine.peekTurn(c);
    else {
      if (prep.aiDown && !c.aiCall.aiDownLogged) { c.aiCall.aiDownLogged = true; custody(c, `AI answer check could not run (${prep.aiDown}) — simple rules used; please review the answers`); }
      // Also a red flag, so the call can never end as plain "verified" when the AI did not really check the answers.
      const stepNow = c.aiCall.queue[c.aiCall.i];
      if (prep.aiDown && stepNow && !['photo', 'burst'].includes(stepNow.type)) {
        const note = 'AI could not check some answers (service busy) — answers were judged by simple rules; please read them yourself';
        if (!c.aiCall.flags.includes(note)) c.aiCall.flags.push(note);
      }
      if (input.typed) custody(c, 'Customer typed the answer instead of speaking');
      if (noisy) c.aiCall.noisy = (c.aiCall.noisy || 0) + 1;
      turn = engine.apply(c, input, prep); await db.write();
    }
    // Many failed attempts in a row: offer the customer a person (the page highlights the "Talk to a person" button).
    const aq = c.aiCall;
    const trouble = (aq.noisy || 0) + (aq.sttErrors || 0);
    const offerHuman = trouble >= 4 && !aq.humanOffered;
    if (offerHuman) { aq.humanOffered = true; custody(c, 'The AI offered the customer a call with a person because of repeated audio problems'); await db.write(); }
    res.json({ turn: { ...(await withVoice(turn, c.aiCall.language, c)), offerHuman }, heard: input.english || null, noisy });
  } catch (err) {
    console.error('AI call turn error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

const readLoc = b => (b && b.lat != null && b.lat !== '') ? { latitude: Number(b.lat), longitude: Number(b.lng), accuracy: Number(b.acc) || null } : null;
const SHOT_INFO = {
  face:  { type: 'liveness_selfie', caption: 'Live face photo taken by AI', what: 'Face photo' },
  stand: { type: 'body_standing', caption: 'Full body photo (standing) taken by AI', what: 'Full body photo — standing' },
  sit:   { type: 'body_sitting', caption: 'Full body photo (sitting) taken by AI', what: 'Full body photo — sitting' }
};

router.post('/:token/photo', upload.single('photo'), async (req, res) => {
  const c0 = await load(req.params.token);
  if (!c0) return notFound(res);
  if (c0.aiCall.status !== 'in_progress' || !req.file) return res.status(400).json({ error: 'No photo received.' });
  try {
    const photoB64 = req.file.buffer.toString('base64');
    const step0 = c0.aiCall.queue[c0.aiCall.i];
    const prep = wrongStage(c0, req.body.stage) ? {} : await engine.prepare(c0, { photoB64 });
    const evId = uid('ev');
    let fileUrl = null, storeErr = null;
    try { fileUrl = await storage.saveFile(req.file.buffer, caseFileKey(c0.id, evId, 'jpg'), 'image/jpeg'); }
    catch (e) { storeErr = shortErr(e); console.error('AI call photo could not be stored:', storeErr); }

    await db.read();
    const c = db.data.cases.find(x => x.id === c0.id);
    let turn;
    if (wrongStage(c, req.body.stage)) turn = engine.peekTurn(c);
    else {
      const info = SHOT_INFO[step0.shot] || SHOT_INFO.face;
      const loc = readLoc(req.body);
      const locText = engine.notePhotoLocation(c, loc, info.what);
      const at = new Date();
      turn = engine.apply(c, {}, prep);
      const result = prep.body || prep.face || {};
      if (!fileUrl) noteStorageProblem(c, storeErr);
      else db.data.evidence.push({
        id: evId, caseId: c.id, vendorId: c.vendorId, source: 'ai_call', type: info.type,
        caption: `${info.caption} — ${at.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} — ${locText}`,
        fileUrl, mimeType: 'image/jpeg',
        location: loc && isFinite(loc.latitude) ? loc : null,
        analysis: { documentType: info.type, visibleText: JSON.stringify(result), notableDetails: result.possibleSpoof || result.visibleHealthIndicators || '' },
        receivedAt: at.toISOString()
      });
      await db.write();
    }
    res.json({ turn: await withVoice(turn, c.aiCall.language, c) });
  } catch (err) {
    console.error('AI call photo error:', err.message);
    res.status(500).json({ error: 'Could not process the photo. Please try again.' });
  }
});

// Eye-blink liveness: a short burst of frames.
router.post('/:token/burst', upload.array('frames', 16), async (req, res) => {
  const c0 = await load(req.params.token);
  if (!c0) return notFound(res);
  const files = req.files || [];
  if (c0.aiCall.status !== 'in_progress' || !files.length) return res.status(400).json({ error: 'No frames received.' });
  try {
    const framesB64 = files.map(f => f.buffer.toString('base64'));
    const prep = wrongStage(c0, req.body.stage) ? {} : await engine.prepare(c0, { framesB64 });
    const b = prep.blink || {};
    const pick = [b.openFrameIndex, b.closedFrameIndex].filter(i => Number.isInteger(i) && i >= 0 && i < files.length);
    if (!pick.length) pick.push(0, files.length - 1);
    const urls = []; let storeErr = null;
    for (const i of [...new Set(pick)]) {
      const evId = uid('ev');
      try { urls.push({ evId, url: await storage.saveFile(files[i].buffer, caseFileKey(c0.id, evId, 'jpg'), 'image/jpeg') }); }
      catch (e) { storeErr = shortErr(e); console.error('AI call blink frame could not be stored:', storeErr); }
    }

    await db.read();
    const c = db.data.cases.find(x => x.id === c0.id);
    let turn;
    if (wrongStage(c, req.body.stage)) turn = engine.peekTurn(c);
    else {
      const loc = readLoc(req.body);
      const locText = engine.notePhotoLocation(c, loc, 'Eye blink check');
      const at = new Date();
      turn = engine.apply(c, {}, prep);
      if (storeErr) noteStorageProblem(c, storeErr);
      urls.forEach(({ evId, url: fileUrl }, n) => db.data.evidence.push({
        id: evId, caseId: c.id, vendorId: c.vendorId, source: 'ai_call', type: 'liveness_blink',
        caption: `Eye blink check frame ${n + 1} (${n === 0 ? 'eyes open' : 'eyes closed'}) — ${at.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} — ${locText}`,
        fileUrl, mimeType: 'image/jpeg', location: loc && isFinite(loc.latitude) ? loc : null,
        analysis: { documentType: 'liveness_blink', visibleText: JSON.stringify(b), notableDetails: b.possibleSpoof || '' },
        receivedAt: at.toISOString()
      }));
      await db.write();
    }
    res.json({ turn: await withVoice(turn, c.aiCall.language, c) });
  } catch (err) {
    console.error('AI call burst error:', err.message);
    res.status(500).json({ error: 'Could not check the blink. Please try again.' });
  }
});

// "Talk to a person" button.
router.post('/:token/handoff', async (req, res) => {
  const c = await load(req.params.token);
  if (!c) return notFound(res);
  const ok = engine.requestHuman(c, String((req.body || {}).reason || '').slice(0, 200));
  if (ok) { webhooks.emit('ai_call.handoff', c); require('../services/notifications').notify(c.vendorId, { type: 'handoff', caseId: c.id, text: `Customer asked to speak to a person — case ${c.caseRef}` }); await db.write(); }
  const msg = 'No problem. Our team will call you soon. Thank you for your time.';
  res.json({ ok: true, message: msg, ...(ok ? await speak(msg, c.aiCall.language) : {}) });
});

router.get('/:token/status', async (req, res) => {
  const c = await load(req.params.token);
  if (!c) return notFound(res);
  res.json(engine.publicStatus(c));
});

router.post('/:token/advance', async (req, res) => {
  const c0 = await load(req.params.token);
  if (!c0) return notFound(res);
  if (c0.aiCall.status !== 'in_progress') return res.status(409).json({ error: 'The call is not active.' });
  const { stage, skip, nudge, done } = req.body || {};
  try {
    const input = { skip: !!skip, nudge: !!nudge, done: !!done };
    const prep = (wrongStage(c0, stage) || nudge) ? {} : await engine.prepare(c0, input);
    await db.read();
    const c = db.data.cases.find(x => x.id === c0.id);
    let turn;
    if (wrongStage(c, stage)) turn = engine.peekTurn(c);
    else {
      const step = c.aiCall.queue[c.aiCall.i];
      if (step.type === 'docs' && !skip && !nudge && !engine.docsReady(c.aiCall, step.doc, !!done)) turn = engine.peekTurn(c); // not ready yet
      else { turn = engine.apply(c, input, prep); await db.write(); }
    }
    res.json({ turn: await withVoice(turn, c.aiCall.language, c) });
  } catch (err) {
    console.error('AI call advance error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// WhatsApp thank-you after the call (free-form text works because the customer messaged us during the call).
// Never blocks or fails the call; one message per case.
function thankCustomer(c, firmRow) {
  try {
    if (!require('../services/followup').settingsOf(firmRow).completionMessage || c.aiCall.thankSentAt || !c.whatsappNumber) return;
    const account = (db.data.whatsappAccounts || []).find(a => a.id === c.whatsappAccountId);
    if (!account) return;
    const hi = ['Hindi', 'Marathi'].includes(c.aiCall.language);
    const name = c.insuredName ? ' ' + c.insuredName : '';
    const text = hi
      ? `धन्यवाद${name}। आपकी वेरिफिकेशन कॉल पूरी हो गई है (केस ${c.caseRef}). हमारी टीम इसे देखेगी। अभी आपको कुछ करने की ज़रूरत नहीं है।`
      : `Thank you${name}. Your verification call is complete (case ${c.caseRef}). Our team will review it. You do not need to do anything now.`;
    c.aiCall.thankSentAt = new Date().toISOString();
    require('../services/whatsapp').sendTextMessage(c.whatsappNumber, text, account)
      .then(() => { db.data.custody.push({ id: uid('cust'), caseId: c.id, event: 'Thank-you message sent to the customer on WhatsApp', actor: 'system', timestamp: new Date().toISOString() }); })
      .catch(e => console.error('Thank-you message not sent:', e.message));
  } catch (e) { console.error('Thank-you message error:', e.message); }
}

// The customer asks for their personal data to be erased (DPDP). One open request per case.
router.post('/:token/data-request', rateLimit({ windowMs: 3600_000, max: 5, name: 'data-request' }), async (req, res) => {
  const c = await load(req.params.token);
  if (!c) return notFound(res);
  const open = (db.data.dataRequests || []).find(r => r.caseId === c.id && r.status === 'open');
  if (!open) {
    (db.data.dataRequests ||= []).push({ id: uid('dreq'), vendorId: c.vendorId, caseId: c.id, caseRef: c.caseRef, claimNo: c.claimNo, status: 'open', reason: String((req.body || {}).reason || '').slice(0, 500), createdAt: new Date().toISOString() });
    db.data.custody.push({ id: uid('cust'), caseId: c.id, event: 'Customer asked for their personal data to be erased', actor: 'customer', timestamp: new Date().toISOString() });
    require('../services/notifications').notify(c.vendorId, { type: 'data_request', caseId: c.id, text: `Customer asked to erase their data — case ${c.caseRef}` });
    await db.write();
  }
  res.json({ ok: true });
});

router.post('/:token/complete', async (req, res) => {
  const c0 = await load(req.params.token);
  if (!c0) return notFound(res);
  if (c0.aiCall.status === 'completed') return res.json({ ok: true, decision: c0.aiCall.decision });
  if (c0.aiCall.status !== 'in_progress') return res.status(409).json({ error: 'The call is not active.' });
  try {
    const summary = await engine.prepareFinish(c0);
    await db.read();
    const c = db.data.cases.find(x => x.id === c0.id);
    if (c.aiCall.status === 'completed') return res.json({ ok: true, decision: c.aiCall.decision });
    const firmRow = (db.data.users || []).find(u => u.id === c.vendorId);
    engine.applyFinish(c, summary, { requireReview: require('../services/followup').settingsOf(firmRow).requireReview, otherCases: db.data.cases.filter(x => x.vendorId === c.vendorId && x.id !== c.id) });
    webhooks.emit('ai_call.completed', c);
    thankCustomer(c, firmRow);
    if (c.reviewState === 'awaiting_review') require('../services/notifications').notify(c.vendorId, { type: 'ai_review', caseId: c.id, text: `AI call finished — case ${c.caseRef} is waiting for your review` });
    await db.write();
    res.json({ ok: true, decision: c.aiCall.decision });
  } catch (err) {
    console.error('AI call complete error:', err.message);
    res.status(500).json({ error: 'Could not finish the call. Please try again.' });
  }
});

router.post('/:token/left', async (req, res) => {
  const c = await load(req.params.token);
  if (!c) return notFound(res);
  engine.markAbandoned(c);
  await db.write();
  res.json({ ok: true });
});

router.post('/:token/recording', cleanTmp, uploadVideo.single('recording'), async (req, res) => {
  const c = await load(req.params.token);
  if (!c) return notFound(res);
  if (!req.file) return res.status(400).json({ error: 'No recording received.' });
  try {
    const mime = req.file.mimetype || 'video/webm';
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    const evId = uid('ev');
    const fileUrl = await storage.saveFileFromPath(req.file.path, caseFileKey(c.id, evId, ext), mime);
    fs.promises.unlink(req.file.path).catch(() => {});
    await db.read();
    const c2 = db.data.cases.find(x => x.id === c.id);
    db.data.evidence.push({
      id: evId, caseId: c2.id, vendorId: c2.vendorId, source: 'ai_call', type: 'call_recording', size: req.file.size,
      caption: `AI verification call recording — ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
      fileUrl, mimeType: mime, receivedAt: new Date().toISOString()
    });
    db.data.custody.push({ id: uid('cust'), caseId: c2.id, event: 'AI verification call recording saved', actor: 'ai_agent', timestamp: new Date().toISOString() });
    await db.write();
    res.json({ ok: true });
  } catch (err) {
    console.error('AI call recording error:', err.message);
    res.status(500).json({ error: 'Could not save the recording.' });
  }
});

module.exports = router;
