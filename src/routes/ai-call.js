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

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const fs = require('fs');
const os = require('os');
// recordings go to a temp file and are streamed to storage (no big buffers in memory)
const uploadVideo = multer({ storage: multer.diskStorage({ destination: os.tmpdir() }), limits: { fileSize: 1024 * 1024 * 1024 } });
const router = express.Router();
// deletes the temp upload file once the response is done (success or error)
const cleanTmp = (req, res, next) => { res.on('close', () => { if (req.file && req.file.path) fs.promises.unlink(req.file.path).catch(() => {}); }); next(); };

router.use(rateLimit({ windowMs: 60_000, max: 120 }));

async function load(token) {
  await db.read();
  return db.data.cases.find(c => c.aiCall && c.aiCall.token === token);
}

// Turns the AI's English line into the customer's language + Gemini voice.
async function speak(text, language) {
  let displayText = text;
  try { if (language && language !== 'English') displayText = await gemini.translateText(text, language); }
  catch (e) { console.warn('AI call translate failed:', e.message); }
  let audio = null;
  try {
    const { base64Audio, mimeType } = await gemini.generateSpeech(displayText);
    audio = pcmToWav(Buffer.from(base64Audio, 'base64'), mimeType).toString('base64');
  } catch (e) { console.warn('AI call TTS failed:', e.message); }
  return { displayText, audio };
}
async function withVoice(turn, language) {
  const v = await speak(turn.say, language);
  return { ...turn, displayText: v.displayText, audio: v.audio };
}
function wrongStage(c, stage) {
  const a = c.aiCall;
  const step = a.queue && a.queue[a.i];
  return !step || (stage && step.id !== stage);
}
const notFound = res => res.status(404).json({ error: 'This verification link is invalid.' });

router.get('/:token/info', async (req, res) => {
  const c = await load(req.params.token);
  if (!c) return notFound(res);
  const acct = db.data.whatsappAccounts.find(a => a.id === c.whatsappAccountId);
  const vendor = (db.data.users || []).find(u => u.id === c.vendorId);
  res.json({
    status: c.aiCall.status || 'not_started',
    caseTypeLabel: engine.typeLabel(c),
    isPolicy: c.caseType === 'policy_verification',
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
  try {
    const turn = engine.startSession(c, { language: language || 'English', location, deviceInfo, ip });
    await db.write();
    res.json({ turn: await withVoice(turn, c.aiCall.language) });
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
    let input = { empty: true };
    if (req.file && req.file.size > 3000 && req.body.silence !== '1') {
      const t = await gemini.transcribeAndTranslateAudio(req.file.buffer.toString('base64'), 'audio/wav');
      const english = String(t.english || '').trim();
      if (english) input = { english, original: t.original, language: t.language };
    }
    const prep = wrongStage(c0, stage) ? {} : await engine.prepare(c0, input);

    await db.read();
    const c = db.data.cases.find(x => x.id === c0.id);
    let turn;
    if (wrongStage(c, stage)) turn = engine.peekTurn(c);
    else { turn = engine.apply(c, input, prep); await db.write(); }
    res.json({ turn: await withVoice(turn, c.aiCall.language), heard: input.english || null });
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
    const fileUrl = await storage.saveFile(req.file.buffer, caseFileKey(c0.id, evId, 'jpg'), 'image/jpeg');

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
      db.data.evidence.push({
        id: evId, caseId: c.id, vendorId: c.vendorId, source: 'ai_call', type: info.type,
        caption: `${info.caption} — ${at.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} — ${locText}`,
        fileUrl, mimeType: 'image/jpeg',
        location: loc && isFinite(loc.latitude) ? loc : null,
        analysis: { documentType: info.type, visibleText: JSON.stringify(result), notableDetails: result.possibleSpoof || result.visibleHealthIndicators || '' },
        receivedAt: at.toISOString()
      });
      await db.write();
    }
    res.json({ turn: await withVoice(turn, c.aiCall.language) });
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
    const urls = [];
    for (const i of [...new Set(pick)]) { const evId = uid('ev'); urls.push({ evId, url: await storage.saveFile(files[i].buffer, caseFileKey(c0.id, evId, 'jpg'), 'image/jpeg') }); }

    await db.read();
    const c = db.data.cases.find(x => x.id === c0.id);
    let turn;
    if (wrongStage(c, req.body.stage)) turn = engine.peekTurn(c);
    else {
      const loc = readLoc(req.body);
      const locText = engine.notePhotoLocation(c, loc, 'Eye blink check');
      const at = new Date();
      turn = engine.apply(c, {}, prep);
      urls.forEach(({ evId, url: fileUrl }, n) => db.data.evidence.push({
        id: evId, caseId: c.id, vendorId: c.vendorId, source: 'ai_call', type: 'liveness_blink',
        caption: `Eye blink check frame ${n + 1} (${n === 0 ? 'eyes open' : 'eyes closed'}) — ${at.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} — ${locText}`,
        fileUrl, mimeType: 'image/jpeg', location: loc && isFinite(loc.latitude) ? loc : null,
        analysis: { documentType: 'liveness_blink', visibleText: JSON.stringify(b), notableDetails: b.possibleSpoof || '' },
        receivedAt: at.toISOString()
      }));
      await db.write();
    }
    res.json({ turn: await withVoice(turn, c.aiCall.language) });
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
  if (ok) await db.write();
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
    res.json({ turn: await withVoice(turn, c.aiCall.language) });
  } catch (err) {
    console.error('AI call advance error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
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
    engine.applyFinish(c, summary);
    await db.write();
    res.json({ ok: true });
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
      caption: `AI verification call recording — ${new Date().toLocaleString()}`,
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
