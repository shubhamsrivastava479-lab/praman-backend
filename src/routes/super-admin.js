const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const plans = require('../services/plans');
const monthKey = (d = new Date(), back = 0) => { const x = new Date(d.getTime() + 5.5 * 3600e3); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() - back); return x.toISOString().slice(0, 7); };

const router = express.Router();
router.use(requireAuth);

function requireSuperAdmin(req, res, next) {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Super Admin access required' });
  next();
}
router.use(requireSuperAdmin);
router.use('/billing', require('./billing-admin'));


// "Request a demo" form of the website.
router.get('/demo-requests', async (req, res) => {
  await db.read();
  res.json((db.data.demoRequests || []).slice().reverse());
});
router.post('/demo-requests/:id', async (req, res) => {
  await db.read();
  const r = (db.data.demoRequests || []).find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const { status, note } = req.body || {};
  if (status !== undefined) { if (!['new', 'contacted', 'demo_done', 'closed'].includes(status)) return res.status(400).json({ error: 'Bad status' }); r.status = status; }
  if (note !== undefined) r.note = String(note).slice(0, 500);
  await db.write();
  res.json(r);
});

// List every vendor company with quick stats, for the Super Admin overview.
router.get('/vendors', async (req, res) => {
  await db.read();
  const vendors = db.data.users.filter(u => u.role === 'vendor_admin');
  const result = vendors.map(v => ({
    id: v.id,
    email: v.email,
    vendorName: v.vendorName,
    approved: v.approved !== false,
    status: v.approved !== false ? 'approved' : (v.status || 'pending'),
    profile: v.profile || null,
    signupMethod: v.signupMethod || 'password',
    createdAt: v.createdAt,
    caseCount: db.data.cases.filter(c => c.vendorId === v.id).length,
    agentCount: db.data.users.filter(u => u.role === 'agent' && u.parentVendorId === v.id).length,
    whatsappConnected: db.data.whatsappAccounts.some(a => a.vendorId === v.id),
    services: Array.isArray(v.services) ? v.services : null, // null = all (older account, not set yet)
    servicePrices: v.servicePrices || {},
    retentionDays: v.retentionDays || null,
    requestedServices: v.requestedServices || null,
    usage: { thisMonth: { month: monthKey(), cases: plans.usage(db.data, v.id, monthKey()) }, lastMonth: { month: monthKey(new Date(), 1), cases: plans.usage(db.data, v.id, monthKey(new Date(), 1)) } }
  }));
  res.json(result);
});

// Service catalog (what can be sold).
router.get('/services', (req, res) => {
  res.json(plans.ALL.map(k => ({ key: k, ...plans.SERVICES[k] })));
});

// Which services a vendor has bought, and the price per case for each.
router.post('/vendors/:id/plan', async (req, res) => {
  await db.read();
  const v = db.data.users.find(u => u.id === req.params.id && u.role === 'vendor_admin');
  if (!v) return res.status(404).json({ error: 'Vendor not found' });
  const services = [...new Set((req.body.services || []).filter(s => plans.SERVICES[s]))];
  const prices = {};
  for (const [k, val] of Object.entries(req.body.prices || {})) {
    if (!plans.SERVICES[k] || val === '' || val == null) continue;
    const n = Number(val);
    if (!isFinite(n) || n < 0 || n > 1e6) return res.status(400).json({ error: `Price for ${plans.SERVICES[k].short} is not valid.` });
    prices[k] = Math.round(n * 100) / 100;
  }
  const rd = req.body.retentionDays;
  if (rd !== undefined) {
    if (rd === '' || rd === null || Number(rd) === 0) v.retentionDays = null;
    else if (!isFinite(Number(rd)) || Number(rd) < 30 || Number(rd) > 3650) return res.status(400).json({ error: 'Keep-files period must be between 30 and 3650 days (or empty to keep forever).' });
    else v.retentionDays = Math.round(Number(rd));
  }
  v.services = services;
  v.servicePrices = prices;
  v.planUpdatedAt = new Date().toISOString();
  require('../services/audit').log(req.user, 'plan_changed', services.join(','), v.id);
  await db.write();
  res.json({ ok: true, services, servicePrices: prices });
});

router.post('/vendors/:id/approve', async (req, res) => {
  await db.read();
  const v = db.data.users.find(u => u.id === req.params.id && u.role === 'vendor_admin');
  if (!v) return res.status(404).json({ error: 'Vendor not found' });
  v.approved = true;
  v.status = 'approved';
  // First approval: start with the services the firm asked for.
  if (!Array.isArray(v.services) && Array.isArray(v.requestedServices) && v.requestedServices.length) v.services = v.requestedServices.filter(s => plans.SERVICES[s]);
  v.approvedAt = new Date().toISOString();
  require('../services/audit').log(req.user, 'vendor_approved', v.vendorName, v.id);
  await db.write();
  res.json({ ok: true });
});

router.post('/vendors/:id/suspend', async (req, res) => {
  await db.read();
  const v = db.data.users.find(u => u.id === req.params.id && u.role === 'vendor_admin');
  if (!v) return res.status(404).json({ error: 'Vendor not found' });
  v.approved = false;
  v.status = 'suspended';
  require('../services/audit').log(req.user, 'vendor_suspended', v.vendorName, v.id);
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
    aiVoice: s.aiVoice || process.env.AI_VOICE || 'gemini',
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
    storageSource: s.s3Endpoint ? 'dashboard' : (process.env.S3_ENDPOINT ? 'env' : 'local disk (not configured)'),
    // TURN relay for live video calls on mobile networks
    cfTurnKeyId: s.cfTurnKeyId || process.env.CF_TURN_KEY_ID || null,
    cfTurnApiToken: mask(s.cfTurnApiToken || process.env.CF_TURN_API_TOKEN),
    turnUrl: s.turnUrl || process.env.TURN_URL || null,
    turnUsername: s.turnUsername || process.env.TURN_USERNAME || null,
    turnCredential: mask(s.turnCredential || process.env.TURN_CREDENTIAL),
    turnSource: s.cfTurnKeyId ? 'Cloudflare (dashboard)' : s.turnUrl ? 'custom (dashboard)' : (process.env.CF_TURN_KEY_ID || process.env.TURN_URL) ? 'env' : 'not set — STUN only'
  });
});

router.post('/settings', async (req, res) => {
  const {
    geminiApiKey, gridlinesApiKey, gridlinesAuthType,
    s3Endpoint, s3Bucket, s3AccessKeyId, s3SecretAccessKey, s3Region, s3PublicBaseUrl,
    cfTurnKeyId, cfTurnApiToken, turnUrl, turnUsername, turnCredential, aiVoice
  } = req.body;
  await db.read();
  db.data.platformSettings = db.data.platformSettings || {};
  const s = db.data.platformSettings;
  if (geminiApiKey) s.geminiApiKey = geminiApiKey;
  if (aiVoice === 'gemini' || aiVoice === 'phone') s.aiVoice = aiVoice;
  if (gridlinesApiKey) s.gridlinesApiKey = gridlinesApiKey;
  if (gridlinesAuthType) s.gridlinesAuthType = gridlinesAuthType;
  if (s3Endpoint) s.s3Endpoint = s3Endpoint;
  if (s3Bucket) s.s3Bucket = s3Bucket;
  if (s3AccessKeyId) s.s3AccessKeyId = s3AccessKeyId;
  if (s3SecretAccessKey) s.s3SecretAccessKey = s3SecretAccessKey;
  if (s3Region) s.s3Region = s3Region;
  if (s3PublicBaseUrl) s.s3PublicBaseUrl = s3PublicBaseUrl;
  if (cfTurnKeyId !== undefined) s.cfTurnKeyId = String(cfTurnKeyId || '').trim() || undefined;
  if (cfTurnApiToken) s.cfTurnApiToken = String(cfTurnApiToken).trim();
  if (turnUrl !== undefined) s.turnUrl = String(turnUrl || '').trim() || undefined;
  if (turnUsername !== undefined) s.turnUsername = String(turnUsername || '').trim() || undefined;
  if (turnCredential) s.turnCredential = String(turnCredential).trim();
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
    topVendors,
    aiUsage: require('../services/usage').summary(30),
    aiCallsByFirm: vendors.map(v => ({ vendorName: v.vendorName, aiCalls: cases.filter(c => c.vendorId === v.id && c.aiCall && c.aiCall.status === 'completed').length })).filter(x => x.aiCalls).sort((a, b) => b.aiCalls - a.aiCalls).slice(0, 10)
  });
});

// ---------- AI cost ----------
router.get('/ai-cost', async (req, res) => {
  await db.read();
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
  res.json(require('../services/usage').summary(days));
});
router.put('/ai-prices', async (req, res) => {
  await db.read();
  const prices = require('../services/usage').setPrices((req.body || {}).prices);
  await db.write();
  require('../services/audit').log(req.user, 'ai_prices_set', Object.keys(prices).join(', '), null);
  res.json({ ok: true, prices });
});

// ---------- Backups (daily, automatic) ----------
router.get('/backups', async (req, res) => {
  await db.read();
  res.json({ items: (db.data.backupLog || []).slice().reverse().map(({ id, name, at, bytes, counts, label, verifiedAt }) => ({ id, name, at, bytes, counts, label, verifiedAt })), cloud: await require('../services/storage').isS3Configured() });
});
router.post('/backups/run', async (req, res) => {
  try { const e = await require('../services/backup').run({ label: 'daily' }); require('../services/audit').log(req.user, 'backup_run', e.name, null); res.json({ ok: true, id: e.id }); }
  catch (e) { res.status(500).json({ error: 'The backup failed: ' + String(e.message).slice(0, 200) }); }
});
router.post('/backups/:id/verify', async (req, res) => {
  await db.read();
  const e = (db.data.backupLog || []).find(b => b.id === req.params.id);
  if (!e) return res.status(404).json({ error: 'Backup not found' });
  try { res.json(await require('../services/backup').verify(e)); }
  catch (err) { res.status(422).json({ error: 'This backup could not be verified: ' + String(err.message).slice(0, 200) }); }
});
// Replaces ALL current data with the backup. Needs the word RESTORE typed in. A safety backup of the current data is made first.
router.post('/backups/:id/restore', async (req, res) => {
  if (!req.body || req.body.confirm !== 'RESTORE') return res.status(400).json({ error: 'Type RESTORE to confirm.' });
  await db.read();
  const e = (db.data.backupLog || []).find(b => b.id === req.params.id);
  if (!e) return res.status(404).json({ error: 'Backup not found' });
  try { const r = await require('../services/backup').restore(e); require('../services/audit').log(req.user, 'backup_restored', e.name, null); res.json({ ok: true, ...r }); }
  catch (err) { res.status(500).json({ error: 'Restore failed: ' + String(err.message).slice(0, 200) }); }
});

// "Test" buttons: check the storage and Gemini keys right after saving them.
const errText = e => String((e && e.message) || e).replace(/key=[^&\s]+/gi, 'key=…').replace(/\s+/g, ' ').slice(0, 400);
router.post('/test-storage', async (req, res) => {
  const storage = require('../services/storage');
  if (!(await storage.isS3Configured())) return res.json({ ok: false, error: 'Cloud storage is not set. Fill in the Storage settings and save first.' });
  try {
    const url = await storage.saveFile(Buffer.from('Praman storage test ' + new Date().toISOString()), 'healthcheck/storage-test.txt', 'text/plain');
    const signed = await storage.signedUrl(url);
    const r = await fetch(signed);
    if (!r.ok) return res.json({ ok: false, error: `File was uploaded but could not be read back (HTTP ${r.status}).` });
    res.json({ ok: true, message: 'Upload and download both work.' });
  } catch (e) {
    const m = errText(e);
    let hint = '';
    if (/SignatureDoesNotMatch|InvalidAccessKeyId|Unauthorized|403/i.test(m)) hint = 'Access was refused. Check three things: the Bucket name (the bucket\'s own name from Cloudflare R2, NOT the Account ID), the Access Key ID, and the Secret Access Key (64 characters — copy it again fully).';
    else if (/NoSuchBucket|404/i.test(m)) hint = 'Bucket name is wrong. Use the bucket\'s name from Cloudflare R2 (not the Account ID).';
    else if (/ENOTFOUND|getaddrinfo|Invalid URL/i.test(m)) hint = 'Endpoint is wrong. It should look like https://<account-id>.r2.cloudflarestorage.com';
    res.json({ ok: false, error: m, hint });
  }
});
router.post('/test-gemini', async (req, res) => {
  const gemini = require('../services/gemini');
  const out = {};
  try { out.text = { ok: true, sample: (await gemini.translateText('Please tell me your full name.', 'Hindi')).slice(0, 80) }; }
  catch (e) { out.text = { ok: false, error: errText(e) }; }
  try { const v = await gemini.generateSpeech('Hello'); out.voice = { ok: !!v.base64Audio }; }
  catch (e) { out.voice = { ok: false, error: errText(e) }; }
  const all = [out.text.error, out.voice.error].filter(Boolean).join(' ');
  out.hint = /429|quota|RESOURCE_EXHAUSTED/i.test(all) ? 'Quota exceeded: enable billing for this API key in Google AI Studio (aistudio.google.com → API keys → set up billing), then test again.'
    : /API key not valid|API_KEY_INVALID|PERMISSION_DENIED|403/i.test(all) ? 'The Gemini API key is not valid. Create a new key in Google AI Studio and save it here.'
    : /503|overloaded|high demand/i.test(all) ? 'Gemini is busy right now. Try again in a few minutes.' : '';
  out.ok = out.text.ok && out.voice.ok;
  res.json(out);
});

// Storage status + a full backup download (JSON) for the Super Admin.
router.get('/system', async (req, res) => {
  const counts = {};
  for (const [k, v] of Object.entries(db.data)) if (Array.isArray(v)) counts[k] = v.length;
  const { checkIntegrity } = require('../services/integrity');
  res.json({
    database: db.mode === 'postgres' ? 'PostgreSQL (Supabase)' : 'Local file — data is lost on every deploy. Set DATABASE_URL.',
    persistent: db.mode === 'postgres', counts,
    lastSaveError: db.lastWriteError || null, lastSavedAt: db.lastWriteAt || null,
    integrity: checkIntegrity(db.data),
    mirror: db.mode === 'postgres' ? { lastCopy: require('../services/mirror').state.last, error: require('../services/mirror').state.error } : null
  });
});
router.get('/backup', async (req, res) => {
  await db.read();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  res.set('Content-Disposition', `attachment; filename="praman-backup-${stamp}.json"`);
  res.json(db.data);
});

// ---------- System health, error log, retention ----------
router.get('/health', async (req, res) => {
  const errlog = require('../services/errlog');
  const scheduler = require('../services/scheduler');
  const followup = require('../services/followup');
  const storage = require('../services/storage');
  const { getSetting } = require('../services/platform-settings');
  await db.read();
  const now = new Date();
  const firmOf = new Map(db.data.users.map(u => [u.id, u]));
  let open = 0, overdue = 0;
  for (const c of db.data.cases) {
    if (!followup.isOpen(c)) continue;
    open++;
    if (followup.timeState(c, followup.settingsOf(firmOf.get(c.vendorId)), now) === 'overdue') overdue++;
  }
  const wh = db.data.webhookDeliveries || [];
  const mem = process.memoryUsage();
  res.json({
    time: now.toISOString(),
    uptimeMinutes: Math.round(process.uptime() / 60),
    memoryMb: Math.round(mem.rss / 1048576),
    database: { mode: db.mode, persistent: db.mode === 'postgres', lastSavedAt: db.lastWriteAt || null, lastSaveError: db.lastWriteError || null },
    records: Object.fromEntries(Object.entries(db.data).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length])),
    cases: { open, overdue },
    keys: {
      gemini: !!(await getSetting('geminiApiKey', 'GEMINI_API_KEY')),
      gridlines: !!(await getSetting('gridlinesApiKey', 'GRIDLINES_API_KEY')),
      storage: await storage.isS3Configured(),
      publicBaseUrl: !!process.env.PUBLIC_BASE_URL && !/your-deployed/i.test(process.env.PUBLIC_BASE_URL),
      alertWebhook: !!process.env.ALERT_WEBHOOK_URL
    },
    webhooks: { pending: wh.filter(d => d.status === 'pending').length, failed: wh.filter(d => d.status === 'failed').length },
    jobs: scheduler.status,
    errors24h: errlog.recent(24).reduce((n, e) => n + e.count, 0)
  });
});

router.get('/errors', (req, res) => {
  res.json((db.data.errorLog || []).slice(-100).reverse().map(({ key, ...e }) => e));
});
router.delete('/errors', async (req, res) => {
  db.data.errorLog = [];
  await db.write();
  res.json({ ok: true });
});

// Data retention: preview (dryRun) or run the clean-up now.
router.post('/retention/run', async (req, res) => {
  const retention = require('../services/retention');
  await db.read();
  try { res.json(await retention.run({ dryRun: req.body.dryRun !== false })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
