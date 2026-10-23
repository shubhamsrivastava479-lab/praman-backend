// Live two-way video call between an executive (logged in) and the customer
// (joins from a link, no login). The customer's link carries an unguessable
// per-case token; the executive uses their dashboard login.
//
//   Executive:  POST /api/live/case/:caseId/start      -> link (+ optional WhatsApp send)
//               GET  /api/live/case/:caseId/ice
//               POST /api/live/case/:caseId/photo      -> photo with time + lat/long
//   Customer:   GET  /api/live/join/:token/info
//               GET  /api/live/join/:token/ice
//               POST /api/live/join/:token/joined     -> consent, location, device
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { db, uid } = require('../db');
const { requireAuth } = require('../middleware/auth');
const storage = require('../services/storage');
const wa = require('../services/whatsapp');
const { getIceServers } = require('../services/ice');
const { caseFileKey } = require('../services/ids');
const { rateLimit } = require('../services/security');
const { LANGUAGES, textsFor } = require('../services/live-texts');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
const now = () => new Date().toISOString();
const custody = (caseId, event, actor) => db.data.custody.push({ id: uid('cust'), caseId, event, actor, timestamp: now() });

function baseUrl(req) {
  const p = process.env.PUBLIC_BASE_URL;
  if (p && !/your-deployed/i.test(p)) return p.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}
const caseByToken = token => db.data.cases.find(c => c.liveCall && c.liveCall.token && c.liveCall.token === token);
const fmtLoc = l => `${Number(l.latitude).toFixed(5)}, ${Number(l.longitude).toFixed(5)}${l.accuracy ? ' (±' + Math.round(l.accuracy) + 'm)' : ''}`;
const validLoc = l => l && isFinite(Number(l.latitude)) && isFinite(Number(l.longitude));

// ---------------- executive ----------------
function ownCase(req) {
  return db.data.cases.find(x => x.id === req.params.caseId && x.vendorId === req.user.vendorRootId);
}

router.post('/case/:caseId/start', requireAuth, async (req, res) => {
  await db.read();
  const c = ownCase(req);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  if (!c.liveCall || !c.liveCall.token || req.body.newLink) {
    c.liveCall = { token: crypto.randomBytes(16).toString('hex'), createdAt: now(), createdBy: req.user.email };
    custody(c.id, 'Live video call link created', req.user.email || 'agent');
  }
  const joinUrl = `${baseUrl(req)}/live-join.html?t=${c.liveCall.token}`;
  let sent = false, sendError = null;
  if (req.body.sendWhatsApp) {
    const account = db.data.whatsappAccounts.find(a => a.id === c.whatsappAccountId);
    if (!account) sendError = 'This case has no WhatsApp number linked.';
    else {
      try {
        await wa.sendTextMessage(c.whatsappNumber,
          `नमस्ते${c.insuredName ? ' ' + c.insuredName : ''}। आपके केस (${c.claimNo}) के लिए हमारे जाँच अधिकारी आपसे वीडियो कॉल पर बात करना चाहते हैं। जुड़ने के लिए यह लिंक खोलें:\n${joinUrl}\n\nYour investigator would like to speak with you on a video call for case ${c.claimNo}. Open this link to join.`,
          account);
        sent = true;
        c.lastContactAt = now();
        custody(c.id, 'Live video call link sent to the customer on WhatsApp', req.user.email || 'agent');
      } catch (e) {
        sendError = /24|window|re-engage|131047/i.test(e.message)
          ? 'WhatsApp allows a normal message only within 24 hours of the customer\'s last message. Copy the link and send it from your phone, or ask the customer to message you first.'
          : e.message;
      }
    }
  }
  await db.write();
  res.json({ token: c.liveCall.token, joinUrl, sent, sendError, insuredName: c.insuredName || '', claimNo: c.claimNo, caseRef: c.caseRef || '', language: c.liveCall.language || null });
});

router.get('/case/:caseId/ice', requireAuth, async (req, res) => {
  await db.read();
  if (!ownCase(req)) return res.status(404).json({ error: 'Case not found' });
  res.json(await getIceServers());
});

// Photo taken by the executive from the live video, with the customer's
// latest location (sent by the customer's phone during the call).
router.post('/case/:caseId/photo', requireAuth, upload.single('photo'), async (req, res) => {
  await db.read();
  const c0 = ownCase(req);
  if (!c0) return res.status(404).json({ error: 'Case not found' });
  if (!req.file) return res.status(400).json({ error: 'No photo received' });
  try {
    const evidenceId = uid('ev');
    const fileUrl = await storage.saveFile(req.file.buffer, caseFileKey(c0.id, evidenceId, 'jpg'), 'image/jpeg');
    await db.read();
    const c = db.data.cases.find(x => x.id === c0.id);
    const b = req.body || {};
    const loc = b.lat ? { latitude: Number(b.lat), longitude: Number(b.lng), accuracy: Number(b.acc) || null } : null;
    const label = String(b.label || 'Photo from live video call').slice(0, 120);
    const at = b.takenAt && !isNaN(Date.parse(b.takenAt)) ? new Date(b.takenAt).toISOString() : now();
    const locText = validLoc(loc) ? fmtLoc(loc) : 'customer location not available';
    db.data.evidence.push({
      id: evidenceId, caseId: c.id, vendorId: c.vendorId, source: 'live_call', type: 'live_photo',
      caption: `${label} — ${new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} — ${locText}`,
      fileUrl, mimeType: 'image/jpeg', location: validLoc(loc) ? loc : null,
      takenBy: req.user.email || 'agent',
      analysis: { documentType: 'photo', title: label, extractedText: '', keyDetails: '', observations: '' },
      receivedAt: at
    });
    if (validLoc(loc)) c.lastKnownLocation = { ...loc, capturedAt: at };
    custody(c.id, `Photo taken during live video call: "${label}" — location ${locText}`, req.user.email || 'agent');
    await db.write();
    res.json({ ok: true, evidenceId, caption: label, location: validLoc(loc) ? loc : null });
  } catch (e) {
    console.error('Live photo error:', e.message);
    res.status(500).json({ error: 'Could not save the photo. Please try again.' });
  }
});

// A call the executive held OUTSIDE Praman (e.g. a WhatsApp video call where
// the customer shared their screen) and recorded on the laptop (OBS etc.).
// The file is streamed from a temp file to storage, never held in memory.
const os = require('os');
const fsx = require('fs');
const pathx = require('path');
const bigUpload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir(), filename: (req, f, cb) => cb(null, 'praman-up-' + crypto.randomBytes(8).toString('hex')) }),
  limits: { fileSize: 1536 * 1024 * 1024 }
});
const OK_TYPES = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.aac': 'audio/aac' };
// What the executive asks a claimant to show on screen (claim investigations). Labels are fixed here, the page only sends key + status.
const SCREEN_ITEMS = {
  whatsapp_chats: 'WhatsApp chats with the garage, surveyor or other party',
  fir: 'Police complaint / FIR / receipt',
  photos: 'Accident photos and videos in the gallery (date and place visible)',
  calls: 'Call log around the time of the incident',
  vehicle_docs: 'RC, driving licence and policy on the phone',
  bills: 'Repair estimate, bills or messages about the claim',
  // policy verification (PIVC / term)
  agent_chats: 'WhatsApp chats with the agent or sales person who sold the policy',
  payment_proof: 'Premium payment receipt / bank or UPI message for the first premium',
  policy_docs: 'Policy document, proposal form copy or welcome email on the phone',
  id_originals: 'Aadhaar and PAN seen on the phone (or the physical cards held to the camera)',
  health_records: 'Medical reports, prescriptions or test reports mentioned in the health answers',
  promises: 'Any message promising guaranteed returns, bonus or cash payment'
};
const SCREEN_STATUS = { shown: 'Shown', refused: 'Customer refused', na: 'Not applicable' };
const CALL_TYPES = { google_meet: 'Google Meet video call', whatsapp_video: 'WhatsApp video call', whatsapp_audio: 'WhatsApp voice call', phone: 'Phone call', other: 'Other call' };

router.post('/case/:caseId/external-recording', requireAuth, bigUpload.single('recording'), async (req, res) => {
  const tmp = req.file && req.file.path;
  const cleanup = () => { if (tmp) fsx.promises.unlink(tmp).catch(() => {}); };
  try {
    await db.read();
    const c0 = ownCase(req);
    if (!c0) { cleanup(); return res.status(404).json({ error: 'Case not found' }); }
    if (!req.file) return res.status(400).json({ error: 'No recording file received.' });
    const b = req.body || {};
    if (b.consent !== '1') { cleanup(); return res.status(400).json({ error: 'Tick the box confirming the customer agreed to the recording.' }); }
    const ext = pathx.extname(req.file.originalname || '').toLowerCase();
    if (ext === '.mkv' || ext === '.flv') { cleanup(); return res.status(400).json({ error: 'MKV/FLV files do not play in browsers. In OBS use File → Remux Recordings to make an MP4, or set Recording Format to MP4.' }); }
    const mime = OK_TYPES[ext] || (/^(video|audio)\//.test(req.file.mimetype || '') ? req.file.mimetype : null);
    if (!mime) { cleanup(); return res.status(400).json({ error: 'Upload a video or audio file (MP4, WebM, MOV, M4A, MP3).' }); }

    // integrity hash of the file exactly as uploaded
    const sha256 = await new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      fsx.createReadStream(tmp).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
    const evidenceId = uid('ev');
    const fileUrl = await storage.saveFileFromPath(tmp, caseFileKey(c0.id, evidenceId, ext || (mime.startsWith('audio') ? 'm4a' : 'mp4')), mime);
    cleanup();

    await db.read();
    const c = db.data.cases.find(x => x.id === c0.id);
    const callType = CALL_TYPES[b.callType] || CALL_TYPES.other;
    const callAt = b.callAt && !isNaN(Date.parse(b.callAt)) ? new Date(b.callAt).toISOString() : now();
    const screen = b.screenShared === '1';
    let notes = String(b.notes || '').slice(0, 3000);
    // Screen-share checklist (claim investigations): what the customer showed, what they refused.
    let check = null;
    if (b.checklist && c.caseType !== 'policy_verification') {
      try {
        const raw = JSON.parse(b.checklist);
        const items = (Array.isArray(raw) ? raw : []).filter(i => SCREEN_ITEMS[i.key] && SCREEN_STATUS[i.status]).map(i => ({ key: i.key, label: SCREEN_ITEMS[i.key], status: i.status }));
        if (items.length) {
          check = { at: now(), by: req.user.email || 'executive', items };
          notes = (notes ? notes + '\n\n' : '') + 'Screen-share checklist:\n' + items.map(i => `- ${SCREEN_STATUS[i.status]}: ${i.label}`).join('\n');
        }
      } catch { /* ignore a malformed checklist */ }
    }
    const dur = Math.max(0, Math.min(600, parseInt(b.durationMin, 10) || 0));
    db.data.evidence.push({
      id: evidenceId, caseId: c.id, vendorId: c.vendorId, source: 'external_call', type: 'call_recording',
      caption: `${callType}${screen ? ' with screen share' : ''} — recorded by ${req.user.email || 'executive'} — ${new Date(callAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}${dur ? ' — ' + dur + ' min' : ''}`,
      fileUrl, mimeType: mime, fileName: String(req.file.originalname || '').slice(0, 120), size: req.file.size, sha256,
      callType: b.callType || 'other', screenShared: screen, screenCheck: check ? check.items : undefined, takenBy: req.user.email || 'agent',
      analysis: { documentType: 'call_recording', title: callType, keyDetails: notes, extractedText: '', observations: '' },
      receivedAt: callAt
    });
    custody(c.id, `Customer consent confirmed by ${req.user.email || 'executive'} for the recorded ${callType.toLowerCase()}${screen ? ' and screen sharing' : ''}`, req.user.email || 'agent');
    db.data.custody.push({ id: uid('cust'), caseId: c.id, event: `${callType} recording uploaded (${(req.file.size / 1048576).toFixed(1)} MB)`, actor: req.user.email || 'agent', hash: sha256, timestamp: now() });
    if (check) {
      const refused = check.items.filter(i => i.status === 'refused');
      c.screenCheck = { at: check.at, by: check.by, evidenceId, shown: check.items.filter(i => i.status === 'shown').length, refused: refused.length, total: check.items.length };
      custody(c.id, `Screen-share check done by ${check.by}: ${c.screenCheck.shown} shown, ${refused.length} refused, ${check.items.length - c.screenCheck.shown - refused.length} not applicable`, check.by);
      if (refused.length) {
        const flag = `Customer declined to show on screen: ${refused.map(i => i.label.toLowerCase()).join('; ')}`;
        c.verificationFlags = [...(c.verificationFlags || []).filter(f => !/^Customer declined to show on screen/.test(f)), flag];
      }
    }
    await db.write();
    res.json({ ok: true, evidenceId });
  } catch (e) {
    cleanup();
    console.error('External recording upload error:', e.message);
    res.status(500).json({ error: 'Could not save the recording: ' + e.message });
  }
});

// ---------------- customer ----------------
const pub = express.Router();
pub.use(rateLimit({ windowMs: 60_000, max: 60 }));

pub.get('/:token/info', async (req, res) => {
  await db.read();
  const c = caseByToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'This video call link is not valid.' });
  const vendor = db.data.users.find(u => u.id === c.vendorId);
  res.json({ caseRef: '••••' + String(c.claimNo).slice(-4), firm: vendor ? vendor.vendorName || '' : '', languages: LANGUAGES.map(([value, label]) => ({ value, label })), language: c.liveCall.language || null });
});

// Screen text in the chosen language (Hindi/English built in, others translated once).
pub.get('/:token/texts', async (req, res) => {
  await db.read();
  if (!caseByToken(req.params.token)) return res.status(404).json({ error: 'Not found' });
  res.json(await textsFor(String(req.query.lang || 'Hindi')));
});

pub.get('/:token/ice', async (req, res) => {
  await db.read();
  if (!caseByToken(req.params.token)) return res.status(404).json({ error: 'Not found' });
  res.json(await getIceServers());
});

pub.post('/:token/joined', async (req, res) => {
  await db.read();
  const c = caseByToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'This video call link is not valid.' });
  const { consent, location, deviceInfo, language } = req.body || {};
  if (!consent) return res.status(400).json({ error: 'Consent is required.' });
  const lang = LANGUAGES.find(([v]) => v === language);
  if (lang) { c.liveCall.language = lang[0]; custody(c.id, `Customer chose ${lang[0]} for the live video call`, 'participant'); }
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  custody(c.id, 'Customer agreed to the recorded live video call (camera, microphone, location)', 'participant');
  if (validLoc(location)) {
    custody(c.id, `Customer location at the start of the live call: ${fmtLoc(location)} — IP ${ip}`, 'participant');
    c.lastKnownLocation = { latitude: Number(location.latitude), longitude: Number(location.longitude), accuracy: location.accuracy || null, capturedAt: now() };
  } else {
    custody(c.id, `Customer location not shared at the start of the live call — IP ${ip}`, 'participant');
  }
  if (deviceInfo) custody(c.id, `Live call device: ${String(deviceInfo.platform || '').slice(0, 40)}, ${String(deviceInfo.screen || '').slice(0, 20)}, ${String(deviceInfo.timezone || '').slice(0, 40)}`, 'participant');
  await db.write();
  res.json({ ok: true });
});

router.use('/join', pub);

module.exports = router;
module.exports.caseByToken = caseByToken;
