const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function requireSuperAdmin(req, res, next) {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Super Admin access required' });
  next();
}
router.use(requireSuperAdmin);

// List every vendor company with quick stats, for the Super Admin overview.
router.get('/vendors', async (req, res) => {
  await db.read();
  const vendors = db.data.users.filter(u => u.role === 'vendor_admin');
  const result = vendors.map(v => ({
    id: v.id,
    email: v.email,
    vendorName: v.vendorName,
    approved: v.approved !== false,
    createdAt: v.createdAt,
    caseCount: db.data.cases.filter(c => c.vendorId === v.id).length,
    agentCount: db.data.users.filter(u => u.role === 'agent' && u.parentVendorId === v.id).length,
    whatsappConnected: db.data.whatsappAccounts.some(a => a.vendorId === v.id)
  }));
  res.json(result);
});

router.post('/vendors/:id/approve', async (req, res) => {
  await db.read();
  const v = db.data.users.find(u => u.id === req.params.id && u.role === 'vendor_admin');
  if (!v) return res.status(404).json({ error: 'Vendor not found' });
  v.approved = true;
  await db.write();
  res.json({ ok: true });
});

router.post('/vendors/:id/suspend', async (req, res) => {
  await db.read();
  const v = db.data.users.find(u => u.id === req.params.id && u.role === 'vendor_admin');
  if (!v) return res.status(404).json({ error: 'Vendor not found' });
  v.approved = false;
  await db.write();
  res.json({ ok: true });
});

// ---------- Platform settings (Gemini / Gridlines keys) ----------
// Returned masked (never the full key) — Super Admin can see a key is set
// and its last few characters, but re-enters the full value to change it.

function mask(key) {
  if (!key) return null;
  return key.length <= 6 ? '••••' : `••••${key.slice(-4)}`;
}

router.get('/settings', async (req, res) => {
  await db.read();
  const s = db.data.platformSettings || {};
  res.json({
    geminiApiKey: mask(s.geminiApiKey || process.env.GEMINI_API_KEY),
    geminiSource: s.geminiApiKey ? 'dashboard' : (process.env.GEMINI_API_KEY ? 'env' : 'not set'),
    gridlinesApiKey: mask(s.gridlinesApiKey || process.env.GRIDLINES_API_KEY),
    gridlinesSource: s.gridlinesApiKey ? 'dashboard' : (process.env.GRIDLINES_API_KEY ? 'env' : 'not set'),
    gridlinesAuthType: s.gridlinesAuthType || process.env.GRIDLINES_AUTH_TYPE || 'API-Key',
    // Object storage (S3/R2/B2) — when unset, evidence/recordings save to
    // local disk, which most hosts wipe on redeploy/restart.
    s3Endpoint: s.s3Endpoint || process.env.S3_ENDPOINT || null,
    s3Bucket: s.s3Bucket || process.env.S3_BUCKET || null,
    s3AccessKeyId: mask(s.s3AccessKeyId || process.env.S3_ACCESS_KEY_ID),
    s3Region: s.s3Region || process.env.S3_REGION || 'auto',
    s3PublicBaseUrl: s.s3PublicBaseUrl || process.env.S3_PUBLIC_BASE_URL || null,
    storageSource: s.s3Endpoint ? 'dashboard' : (process.env.S3_ENDPOINT ? 'env' : 'local disk (not configured)')
  });
});

router.post('/settings', async (req, res) => {
  const {
    geminiApiKey, gridlinesApiKey, gridlinesAuthType,
    s3Endpoint, s3Bucket, s3AccessKeyId, s3SecretAccessKey, s3Region, s3PublicBaseUrl
  } = req.body;
  await db.read();
  db.data.platformSettings = db.data.platformSettings || {};
  const s = db.data.platformSettings;
  if (geminiApiKey) s.geminiApiKey = geminiApiKey;
  if (gridlinesApiKey) s.gridlinesApiKey = gridlinesApiKey;
  if (gridlinesAuthType) s.gridlinesAuthType = gridlinesAuthType;
  if (s3Endpoint) s.s3Endpoint = s3Endpoint;
  if (s3Bucket) s.s3Bucket = s3Bucket;
  if (s3AccessKeyId) s.s3AccessKeyId = s3AccessKeyId;
  if (s3SecretAccessKey) s.s3SecretAccessKey = s3SecretAccessKey;
  if (s3Region) s.s3Region = s3Region;
  if (s3PublicBaseUrl) s.s3PublicBaseUrl = s3PublicBaseUrl;
  await db.write();
  res.json({ ok: true });
});

// ---------- Platform-wide analytics ----------
router.get('/analytics', async (req, res) => {
  await db.read();
  const vendors = db.data.users.filter(u => u.role === 'vendor_admin');
  const agents = db.data.users.filter(u => u.role === 'agent');
  const cases = db.data.cases;
  const evidence = db.data.evidence;
  const custody = db.data.custody;
  const storage = require('../services/storage');

  const byStatus = {};
  const byType = {};
  for (const c of cases) {
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    byType[c.caseType || 'claim_investigation'] = (byType[c.caseType || 'claim_investigation'] || 0) + 1;
  }

  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    trend.push({ date: key, count: cases.filter(c => c.createdAt?.slice(0, 10) === key).length });
  }

  const topVendors = vendors
    .map(v => ({ vendorName: v.vendorName, caseCount: cases.filter(c => c.vendorId === v.id).length }))
    .sort((a, b) => b.caseCount - a.caseCount)
    .slice(0, 5);

  const fs = require('fs');
  const path = require('path');
  let localDiskMB = 0;
  try {
    const files = fs.readdirSync(storage.mediaDir);
    localDiskMB = +(files.reduce((sum, f) => sum + fs.statSync(path.join(storage.mediaDir, f)).size, 0) / (1024 * 1024)).toFixed(1);
  } catch { /* dir may not exist yet */ }

  res.json({
    vendors: { total: vendors.length, approved: vendors.filter(v => v.approved !== false).length, pending: vendors.filter(v => v.approved === false).length },
    agentCount: agents.length,
    cases: { total: cases.length, byStatus, byType },
    evidenceCollected: evidence.length,
    callsCount: custody.filter(x => x.event.includes('Screen share started')).length,
    kycChecksCount: custody.filter(x => x.actor === 'kyc_check' || x.actor === 'participant').length,
    recordingsCount: evidence.filter(e => e.type === 'call_recording').length,
    storage: { usingCloud: await storage.isS3Configured(), localDiskMB },
    trend7Days: trend,
    topVendors
  });
});

module.exports = router;
