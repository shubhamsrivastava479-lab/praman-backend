const express = require('express');
const { db, uid } = require('../db');
const { requireAuth } = require('../middleware/auth');
const kyc = require('../services/kyc');
const otpService = require('../services/otp');
const { getSetting } = require('../services/platform-settings');
const { maskId, redactIdsInText, rateLimit } = require('../services/security');

const router = express.Router();
router.use(requireAuth);

// KYC credentials are platform-level — vendors and agents never see or
// manage them. Super Admin can set/rotate them from the dashboard (stored
// in the DB); falls back to .env if not set there. Never exposed in any
// response to a vendor/agent.
async function getPlatformCreds() {
  const apiKey = await getSetting('gridlinesApiKey', 'GRIDLINES_API_KEY');
  if (!apiKey) throw new Error('KYC verification is not available right now. Please contact support.');
  const authType = await getSetting('gridlinesAuthType', 'GRIDLINES_AUTH_TYPE') || 'API-Key';
  return { apiKey, authType };
}

// Generic, vendor-safe error message — never leak the underlying provider's
// name or raw error text to the dashboard.
function safeFail(res, err) {
  console.error('KYC verification error:', err.message); // full detail stays in server logs only
  res.status(400).json({ error: 'Verification could not be completed. Please check the details and try again.' });
}

// ---------- DL verification ----------

router.post('/dl-verify/:caseId', async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.id === req.params.caseId && x.vendorId === req.user.vendorRootId);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const { dlNumber, dateOfBirth } = req.body;
  if (!dlNumber || !dateOfBirth) return res.status(400).json({ error: 'dlNumber and dateOfBirth are required' });

  try {
    const creds = await getPlatformCreds();
    const result = await kyc.verifyDrivingLicence(dlNumber, dateOfBirth, creds);
    db.data.custody.push({
      id: uid('cust'), caseId: c.id, event: `Driving licence ${maskId(dlNumber)} verified`,
      actor: 'kyc_check', timestamp: new Date().toISOString()
    });
    db.data.evidence.push({
      id: uid('ev'), caseId: c.id, source: 'kyc_check', type: 'dl_verification',
      caption: `DL verification result for ${maskId(dlNumber)}`,
      analysis: { documentType: 'dl', visibleText: redactIdsInText(JSON.stringify(result.data || result)), notableDetails: '' },
      receivedAt: new Date().toISOString()
    });
    await db.write();
    res.json({ verified: true, details: result.data || result });
  } catch (err) {
    safeFail(res, err);
  }
});

// ---------- Aadhaar OTP verification ----------

router.post('/aadhaar-otp/generate/:caseId', async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.id === req.params.caseId && x.vendorId === req.user.vendorRootId);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const { aadhaarNumber } = req.body;
  if (!aadhaarNumber) return res.status(400).json({ error: 'aadhaarNumber is required' });

  try {
    const creds = await getPlatformCreds();
    const result = await kyc.generateAadhaarOtp(aadhaarNumber, creds);
    res.json({ referenceId: result.data?.reference_id || result.reference_id });
  } catch (err) {
    safeFail(res, err);
  }
});

router.post('/aadhaar-otp/verify/:caseId', async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.id === req.params.caseId && x.vendorId === req.user.vendorRootId);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const { referenceId, otp } = req.body;
  if (!referenceId || !otp) return res.status(400).json({ error: 'referenceId and otp are required' });

  try {
    const creds = await getPlatformCreds();
    const result = await kyc.verifyAadhaarOtp(referenceId, otp, creds);
    db.data.custody.push({
      id: uid('cust'), caseId: c.id, event: 'Aadhaar verified', actor: 'kyc_check', timestamp: new Date().toISOString()
    });
    db.data.evidence.push({
      id: uid('ev'), caseId: c.id, source: 'kyc_check', type: 'aadhaar_verification',
      caption: 'Aadhaar OTP verification result',
      analysis: { documentType: 'aadhaar', visibleText: redactIdsInText(JSON.stringify(result.data || result)), notableDetails: '' },
      receivedAt: new Date().toISOString()
    });
    await db.write();
    res.json({ verified: true, details: result.data || result });
  } catch (err) {
    safeFail(res, err);
  }
});

// ---------- PAN verification ----------

router.post('/pan-verify/:caseId', async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.id === req.params.caseId && x.vendorId === req.user.vendorRootId);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const { panNumber, nameOnPan, dateOfBirth } = req.body;
  if (!panNumber || !nameOnPan || !dateOfBirth) {
    return res.status(400).json({ error: 'panNumber, nameOnPan and dateOfBirth are required' });
  }

  try {
    const creds = await getPlatformCreds();
    const result = await kyc.verifyPan(panNumber, nameOnPan, dateOfBirth, creds);
    db.data.custody.push({
      id: uid('cust'), caseId: c.id, event: `PAN ${maskId(panNumber)} verified`,
      actor: 'kyc_check', timestamp: new Date().toISOString()
    });
    db.data.evidence.push({
      id: uid('ev'), caseId: c.id, source: 'kyc_check', type: 'pan_verification',
      caption: `PAN verification result for ${maskId(panNumber)}`,
      analysis: { documentType: 'pan', visibleText: redactIdsInText(JSON.stringify(result.data || result)), notableDetails: '' },
      receivedAt: new Date().toISOString()
    });
    await db.write();
    res.json({ verified: true, details: result.data || result });
  } catch (err) {
    safeFail(res, err);
  }
});

// ---------- Phone number OTP (via the case's own connected WhatsApp) ----------

router.post('/phone-otp/send/:caseId', async (req, res) => {
  await db.read();
  const c = db.data.cases.find(x => x.id === req.params.caseId && x.vendorId === req.user.vendorRootId);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const account = db.data.whatsappAccounts.find(a => a.id === c.whatsappAccountId);
  if (!account) return res.status(400).json({ error: 'This case has no WhatsApp account linked' });

  try {
    const { code, expiresAt } = await otpService.sendPhoneOtp(c.whatsappNumber, account);
    db.data.phoneOtps = db.data.phoneOtps || [];
    db.data.phoneOtps = db.data.phoneOtps.filter(o => o.caseId !== c.id);
    db.data.phoneOtps.push({ caseId: c.id, code, expiresAt });
    await db.write();
    res.json({ ok: true, sentTo: c.whatsappNumber });
  } catch (err) {
    console.error('OTP send error:', err.message);
    res.status(400).json({ error: 'Could not send verification code. Please try again.' });
  }
});

router.post('/phone-otp/verify/:caseId', async (req, res) => {
  await db.read();
  const { otp } = req.body;
  const record = (db.data.phoneOtps || []).find(o => o.caseId === req.params.caseId);
  if (!record) return res.status(400).json({ error: 'No code was sent for this case, or it already expired' });
  if (Date.now() > record.expiresAt) return res.status(400).json({ error: 'Code expired, send a new one' });
  if (record.code !== otp) return res.status(400).json({ error: 'Incorrect code' });

  db.data.custody.push({
    id: uid('cust'), caseId: req.params.caseId, event: 'Field contact phone number verified via OTP',
    actor: 'otp_check', timestamp: new Date().toISOString()
  });
  db.data.phoneOtps = db.data.phoneOtps.filter(o => o.caseId !== req.params.caseId);
  await db.write();
  res.json({ ok: true, verified: true });
});

module.exports = router;
