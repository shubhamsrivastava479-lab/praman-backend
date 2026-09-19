const express = require('express');
const multer = require('multer');
const { db, uid } = require('../db');
const gemini = require('../services/gemini');
const kyc = require('../services/kyc');
const storage = require('../services/storage');
const { pcmToWav } = require('../services/wav');
const { getSetting } = require('../services/platform-settings');
const { redactIdsInText, rateLimit } = require('../services/security');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const router = express.Router();
router.use(rateLimit({ windowMs: 60_000, max: 15 })); // protects against case-ID brute-forcing and API-cost abuse

async function getPlatformCreds() {
  const apiKey = await getSetting('gridlinesApiKey', 'GRIDLINES_API_KEY');
  if (!apiKey) throw new Error('Verification is not available right now. Please contact support.');
  const authType = await getSetting('gridlinesAuthType', 'GRIDLINES_AUTH_TYPE') || 'API-Key';
  return { apiKey, authType };
}
function safeFail(res, err) {
  console.error('Participant KYC error:', err.message);
  res.status(400).json({ error: 'Verification could not be completed. Please check the details and try again.' });
}
async function findCase(caseId) {
  await db.read();
  return db.data.cases.find(c => c.id === caseId);
}

// Minimal, safe info the verify.html entry page needs before the
// participant picks a path — just whether self-verification is allowed for
// this case (disabled above the high-value threshold). No PII returned.
router.get('/:caseId/info', async (req, res) => {
  const c = await findCase(req.params.caseId);
  if (!c) return res.status(404).json({ error: 'This verification link is invalid.' });
  res.json({ requiresMandatoryCall: !!c.requiresMandatoryCall });
});

// Speaks a wizard prompt in whichever language the participant picked.
// The prompt text is written in English in verify.html; if the participant
// chose a different language, it's translated first, then sent to Gemini's
// speech-generation model. Returns a playable WAV file.
router.post('/:caseId/speak', async (req, res) => {
  const c = await findCase(req.params.caseId);
  if (!c) return res.status(404).json({ error: 'This verification link is invalid.' });
  const { text, language } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  try {
    const spokenText = (language && language !== 'English')
      ? await gemini.translateText(text, language)
      : text;
    const { base64Audio, mimeType } = await gemini.generateSpeech(spokenText);
    const wav = pcmToWav(Buffer.from(base64Audio, 'base64'), mimeType);
    res.set('Content-Type', 'audio/wav');
    res.send(wav);
  } catch (err) {
    console.error('Speak error:', err.message);
    res.status(500).json({ error: 'Could not generate voice prompt.' });
  }
});

// Captures date/time + GPS coordinates at the moment of a video call or
// verification session — used for both motor claim investigation calls and
// PIVC, so there's an evidentiary record of when and roughly where the
// participant was during the interaction. Best-effort: the participant's
// browser may deny location permission, which is handled gracefully by the
// frontend (the call/wizard still proceeds either way).
router.post('/:caseId/location', async (req, res) => {
  const c = await findCase(req.params.caseId);
  if (!c) return res.status(404).json({ error: 'This verification link is invalid.' });
  const { latitude, longitude, accuracy, deviceInfo } = req.body;
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;

  db.data.custody.push({
    id: uid('cust'), caseId: c.id,
    event: (latitude != null && longitude != null)
      ? `Participant location captured: ${latitude.toFixed(5)}, ${longitude.toFixed(5)} (±${Math.round(accuracy || 0)}m) from IP ${ip}`
      : `Participant location was not available (permission denied or unsupported device) — IP ${ip}`,
    actor: 'participant', timestamp: new Date().toISOString()
  });
  if (deviceInfo) {
    db.data.custody.push({
      id: uid('cust'), caseId: c.id,
      event: `Device fingerprint recorded: ${deviceInfo.platform || 'unknown OS'}, ${deviceInfo.screen || ''}, ${deviceInfo.timezone || ''}, IP ${ip}`,
      actor: 'participant', timestamp: new Date().toISOString()
    });
    // Flag if this exact device+IP combination has already been used on a
    // DIFFERENT case for this vendor — a pattern seen when one person
    // completes verification on behalf of multiple different applicants.
    const priorMatches = db.data.custody.filter(x =>
      x.caseId !== c.id && x.event.includes(`Device fingerprint recorded:`) && x.event.includes(`IP ${ip}`) && ip !== undefined
    );
    if (priorMatches.length) {
      db.data.custody.push({
        id: uid('cust'), caseId: c.id,
        event: `⚠️ Same IP address (${ip}) was also used on ${priorMatches.length} other case(s) — possible shared-device/proxy-verification pattern`,
        actor: 'system_check', timestamp: new Date().toISOString()
      });
    }
  }
  if (latitude != null && longitude != null) {
    c.lastKnownLocation = { latitude, longitude, accuracy, capturedAt: new Date().toISOString() };
  }
  await db.write();
  res.json({ ok: true });
});

// Liveness check: participant holds up a hand-written challenge code in a
// live selfie. Compared against their most recently uploaded ID photo (if
// any) for a same-person opinion. See services/gemini.js checkLiveness()
// for what this catches and its limits.
router.post('/:caseId/liveness-check', upload.single('selfie'), async (req, res) => {
  const c = await findCase(req.params.caseId);
  if (!c) return res.status(404).json({ error: 'This verification link is invalid.' });
  if (!req.file) return res.status(400).json({ error: 'No selfie received' });
  const { challengeCode } = req.body;
  if (!challengeCode) return res.status(400).json({ error: 'challengeCode is required' });

  try {
    await db.read();
    // Pull the most recent ID-document photo already on file for this case,
    // if any, to compare against.
    const lastIdPhoto = [...db.data.evidence]
      .reverse()
      .find(e => e.caseId === c.id && e.type === 'image' && e.fileUrl);
    let base64IdPhoto = null;
    if (lastIdPhoto?.fileUrl?.startsWith('/media/')) {
      const fs = require('fs');
      const path = require('path');
      try {
        const filePath = path.join(storage.mediaDir, lastIdPhoto.fileUrl.replace('/media/', ''));
        base64IdPhoto = fs.readFileSync(filePath).toString('base64');
      } catch { /* file not on local disk (e.g. already on S3) — skip comparison */ }
    }

    const base64Selfie = req.file.buffer.toString('base64');
    const result = await gemini.checkLiveness(base64Selfie, challengeCode, base64IdPhoto);
    const fileUrl = await storage.saveFile(req.file.buffer, `${uid('ev')}.jpg`, req.file.mimetype || 'image/jpeg');
    const passed = result.faceVisible && result.codeMatches && !result.possibleSpoof;

    db.data.evidence.push({
      id: uid('ev'), caseId: c.id, source: 'self_service_upload', type: 'liveness_selfie',
      caption: `Liveness check — ${passed ? 'passed' : 'needs review'}`,
      fileUrl, mimeType: req.file.mimetype,
      analysis: { documentType: 'liveness', visibleText: JSON.stringify(result), notableDetails: result.possibleSpoof || '' },
      receivedAt: new Date().toISOString()
    });
    db.data.custody.push({
      id: uid('cust'), caseId: c.id,
      event: `Liveness check ${passed ? 'passed' : 'flagged for review'} (face: ${result.faceVisible}, code match: ${result.codeMatches}${result.possibleSpoof ? ', spoof concern: ' + result.possibleSpoof : ''})`,
      actor: 'participant', timestamp: new Date().toISOString()
    });
    await db.write();
    res.json({ passed, ...result });
  } catch (err) {
    console.error('Liveness check error:', err.message);
    res.status(500).json({ error: 'Could not process the liveness check. Please try again.' });
  }
});

// Generic additional-document upload — for anything beyond Aadhaar/PAN
// (address proof, income proof, bank passbook, photograph, signature,
// etc.). Just OCR's and files it as evidence; no verification API call.
router.post('/:caseId/upload-document', upload.single('document'), async (req, res) => {
  const c = await findCase(req.params.caseId);
  if (!c) return res.status(404).json({ error: 'This verification link is invalid.' });
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  const label = req.body.label || 'Additional document';

  try {
    const base64 = req.file.buffer.toString('base64');
    const analysis = await gemini.analyzeImage(base64, req.file.mimetype || 'image/jpeg');
    const fileUrl = await storage.saveFile(req.file.buffer, `${uid('ev')}.jpg`, req.file.mimetype || 'image/jpeg');

    db.data.evidence.push({
      id: uid('ev'), caseId: c.id, source: 'self_service_upload', type: 'image',
      caption: `${label} (self-uploaded)`,
      fileUrl, mimeType: req.file.mimetype,
      analysis: { ...analysis, visibleText: redactIdsInText(analysis.visibleText) },
      receivedAt: new Date().toISOString()
    });
    db.data.custody.push({
      id: uid('cust'), caseId: c.id, event: `Participant uploaded: ${label}`,
      actor: 'participant', timestamp: new Date().toISOString()
    });
    await db.write();
    res.json({ ok: true, documentType: analysis.documentType });
  } catch (err) {
    console.error('Upload-document error:', err.message);
    res.status(500).json({ error: 'Could not read the document. Please try a clearer photo.' });
  }
});

// Step 1: upload a photo of an ID document. Gemini Vision reads the visible
// fields (name, number, DOB) and the image is saved as evidence either way.
router.post('/:caseId/upload-id', upload.single('image'), async (req, res) => {
  const c = await findCase(req.params.caseId);
  if (!c) return res.status(404).json({ error: 'This verification link is invalid.' });
  if (!req.file) return res.status(400).json({ error: 'No image received' });

  try {
    const base64 = req.file.buffer.toString('base64');
    const analysis = await gemini.analyzeImage(base64, req.file.mimetype || 'image/jpeg');
    const fileUrl = await storage.saveFile(req.file.buffer, `${uid('ev')}.jpg`, req.file.mimetype || 'image/jpeg');

    // The full extracted number is shown back to the participant in this
    // one response so they can confirm their own document — but what gets
    // SAVED to the database (which agents/vendors later view) is redacted,
    // so the full Aadhaar/PAN number never sits in the case record.
    db.data.evidence.push({
      id: uid('ev'), caseId: c.id, source: 'self_service_upload', type: 'image',
      caption: `Self-uploaded document (${analysis.documentType})`,
      fileUrl, mimeType: req.file.mimetype,
      analysis: { ...analysis, visibleText: redactIdsInText(analysis.visibleText) },
      receivedAt: new Date().toISOString()
    });
    db.data.custody.push({
      id: uid('cust'), caseId: c.id, event: `Participant uploaded a document (detected as ${analysis.documentType})`,
      actor: 'participant', timestamp: new Date().toISOString()
    });
    await db.write();
    res.json({ documentType: analysis.documentType, extracted: analysis.visibleText });
  } catch (err) {
    console.error('Upload-ID error:', err.message);
    res.status(500).json({ error: 'Could not read the document. Please try a clearer photo.' });
  }
});

router.post('/:caseId/aadhaar-otp/generate', async (req, res) => {
  const c = await findCase(req.params.caseId);
  if (!c) return res.status(404).json({ error: 'This verification link is invalid.' });
  const { aadhaarNumber } = req.body;
  if (!aadhaarNumber) return res.status(400).json({ error: 'Aadhaar number is required' });
  try {
    const result = await kyc.generateAadhaarOtp(aadhaarNumber, await getPlatformCreds());
    res.json({ referenceId: result.data?.reference_id || result.reference_id });
  } catch (err) { safeFail(res, err); }
});

router.post('/:caseId/aadhaar-otp/verify', async (req, res) => {
  const c = await findCase(req.params.caseId);
  if (!c) return res.status(404).json({ error: 'This verification link is invalid.' });
  const { referenceId, otp } = req.body;
  if (!referenceId || !otp) return res.status(400).json({ error: 'referenceId and otp are required' });
  try {
    const result = await kyc.verifyAadhaarOtp(referenceId, otp, await getPlatformCreds());
    await db.read();
    db.data.custody.push({
      id: uid('cust'), caseId: c.id, event: 'Aadhaar self-verified by participant (OTP)',
      actor: 'participant', timestamp: new Date().toISOString()
    });
    db.data.evidence.push({
      id: uid('ev'), caseId: c.id, source: 'self_service_upload', type: 'aadhaar_verification',
      caption: 'Aadhaar OTP verification (self-service)',
      analysis: { documentType: 'aadhaar', visibleText: redactIdsInText(JSON.stringify(result.data || result)), notableDetails: '' },
      receivedAt: new Date().toISOString()
    });
    await db.write();
    res.json({ verified: true });
  } catch (err) { safeFail(res, err); }
});

router.post('/:caseId/pan-verify', async (req, res) => {
  const c = await findCase(req.params.caseId);
  if (!c) return res.status(404).json({ error: 'This verification link is invalid.' });
  const { panNumber, nameOnPan, dateOfBirth } = req.body;
  if (!panNumber || !nameOnPan || !dateOfBirth) return res.status(400).json({ error: 'All fields are required' });
  try {
    const result = await kyc.verifyPan(panNumber, nameOnPan, dateOfBirth, await getPlatformCreds());
    await db.read();
    db.data.custody.push({
      id: uid('cust'), caseId: c.id, event: 'PAN self-verified by participant',
      actor: 'participant', timestamp: new Date().toISOString()
    });
    db.data.evidence.push({
      id: uid('ev'), caseId: c.id, source: 'self_service_upload', type: 'pan_verification',
      caption: 'PAN verification (self-service)',
      analysis: { documentType: 'pan', visibleText: redactIdsInText(JSON.stringify(result.data || result)), notableDetails: '' },
      receivedAt: new Date().toISOString()
    });
    await db.write();
    res.json({ verified: true });
  } catch (err) { safeFail(res, err); }
});

// Distance between two lat/long points in km (Haversine formula) — used
// for the geofencing check below.
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Called once the participant finishes the self-service wizard. Runs three
// automated checks (spot-check selection, Aadhaar-linked-mobile vs the
// WhatsApp number used to reach them, and geofencing against the vendor's
// expected location for this case) and records the outcome — the case
// isn't auto-approved or auto-rejected by any of this, it just surfaces
// findings for the agent to review.
router.post('/:caseId/finalize', async (req, res) => {
  const c = await findCase(req.params.caseId);
  if (!c) return res.status(404).json({ error: 'This verification link is invalid.' });
  const flags = [];

  // 1) Spot-check: send roughly 1 in every 15 self-verified cases to a
  // human agent for review, regardless of how clean the automated checks
  // looked — a standard fraud-control practice so self-service isn't a
  // rubber stamp.
  const spotCheckRequired = Math.random() < (1 / 15);
  if (spotCheckRequired) flags.push('Randomly selected for executive spot-check');

  // 2) Aadhaar-mobile cross-check: if Gridlines returned the last digits of
  // the mobile number linked to the Aadhaar, compare it against the
  // WhatsApp number this case's link was sent to. A mismatch is a known
  // fraud pattern (verifying using someone else's Aadhaar).
  const aadhaarEvidence = db.data.evidence.find(e => e.caseId === c.id && e.type === 'aadhaar_verification');
  if (aadhaarEvidence?.analysis?.visibleText) {
    const digits = aadhaarEvidence.analysis.visibleText.match(/(\d{4})(?=[^\d]*$)/);
    const whatsappLast4 = c.whatsappNumber?.slice(-4);
    if (digits && whatsappLast4 && digits[1] !== whatsappLast4) {
      flags.push(`Aadhaar-linked mobile (ends ${digits[1]}) does not match the WhatsApp number used (ends ${whatsappLast4})`);
    }
  }

  // 3) Geofencing: if the vendor set an expected location for this case
  // (e.g. the policy's registered address) and we captured the
  // participant's location, flag if they're implausibly far apart.
  if (c.expectedLocation && c.lastKnownLocation) {
    const km = distanceKm(
      c.expectedLocation.latitude, c.expectedLocation.longitude,
      c.lastKnownLocation.latitude, c.lastKnownLocation.longitude
    );
    if (km > (c.expectedLocation.radiusKm || 100)) {
      flags.push(`Verification location is ${Math.round(km)} km from the expected address`);
    }
  }

  await db.read();
  const liveCase = db.data.cases.find(x => x.id === c.id);
  liveCase.spotCheckRequired = spotCheckRequired;
  liveCase.verificationFlags = flags;
  db.data.custody.push({
    id: uid('cust'), caseId: c.id,
    event: flags.length ? `Verification completed with flags: ${flags.join('; ')}` : 'Verification completed — no automated flags raised',
    actor: 'system_check', timestamp: new Date().toISOString()
  });
  await db.write();
  res.json({ flags, spotCheckRequired });
});

// Uploads the full self-service session recording (liveness + any
// additional-document steps) as one evidence item — a fuller record than
// just the single liveness selfie.
router.post('/:caseId/session-recording', upload.single('recording'), async (req, res) => {
  const c = await findCase(req.params.caseId);
  if (!c) return res.status(404).json({ error: 'This verification link is invalid.' });
  if (!req.file) return res.status(400).json({ error: 'No recording received' });
  try {
    const fileUrl = await storage.saveFile(req.file.buffer, `${uid('ev')}.webm`, 'video/webm');
    db.data.evidence.push({
      id: uid('ev'), caseId: c.id, source: 'self_service_upload', type: 'session_recording',
      caption: `Self-verification session recording — ${new Date().toLocaleString()}`,
      fileUrl, mimeType: 'video/webm', receivedAt: new Date().toISOString()
    });
    db.data.custody.push({
      id: uid('cust'), caseId: c.id, event: 'Full self-verification session recording saved',
      actor: 'participant', timestamp: new Date().toISOString()
    });
    await db.write();
    res.json({ ok: true });
  } catch (err) {
    console.error('Session recording upload error:', err.message);
    res.status(500).json({ error: 'Could not save the recording.' });
  }
});

module.exports = router;
