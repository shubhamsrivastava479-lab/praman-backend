// Settings page API for the firm admin: API key + webhook for the insurer's own system.
const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const webhooks = require('../services/webhooks');
const plans = require('../services/plans');

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => require('../services/roles').isTeam(req.user.role) ? res.status(403).json({ error: 'Only the company admin account can change this.' }) : next());
router.use((req, res, next) => req.user.role === 'super_admin' ? res.status(403).json({ error: 'Open this from a vendor account.' }) : next());

const firmOf = req => plans.firmOf(db.data, req.user);
const view = f => {
  const i = f.integration || {};
  return {
    hasKey: !!i.apiKeyHash, keyPrefix: i.apiKeyPrefix || null, keyCreatedAt: i.createdAt || null, keyLastUsedAt: i.lastUsedAt || null,
    webhookUrl: i.webhookUrl || '', hasSecret: !!i.webhookSecret, events: Array.isArray(i.events) ? i.events : [],
    allEvents: webhooks.EVENTS
  };
};

router.get('/', async (req, res) => {
  await db.read();
  const f = firmOf(req);
  if (!f) return res.status(404).json({ error: 'Company not found' });
  res.json(view(f));
});

// New API key (the old one stops working). The key is shown ONCE.
const audit = require('../services/audit');
router.post('/key', async (req, res) => {
  await db.read();
  const f = firmOf(req);
  if (!f) return res.status(404).json({ error: 'Company not found' });
  const key = webhooks.newApiKey();
  f.integration = { ...(f.integration || {}), apiKeyHash: webhooks.sha256(key), apiKeyPrefix: key.slice(0, 12), createdAt: new Date().toISOString(), lastUsedAt: null };
  audit.log(req.user, 'api_key_created', f.integration.apiKeyPrefix);
  await db.write();
  res.json({ ok: true, apiKey: key, ...view(f) });
});
router.delete('/key', async (req, res) => {
  await db.read();
  const f = firmOf(req);
  if (f && f.integration) { f.integration.apiKeyHash = null; f.integration.apiKeyPrefix = null; audit.log(req.user, 'api_key_revoked', ''); await db.write(); }
  res.json({ ok: true });
});

// Webhook address + which events to send. The signing secret is shown once when first created.
router.put('/webhook', async (req, res) => {
  await db.read();
  const f = firmOf(req);
  if (!f) return res.status(404).json({ error: 'Company not found' });
  const url = String(req.body.webhookUrl || '').trim();
  const i = (f.integration ||= {});
  if (!url) { i.webhookUrl = ''; await db.write(); return res.json({ ok: true, ...view(f) }); }
  try { await webhooks.assertPublicUrl(url); } catch (e) { return res.status(400).json({ error: e.message }); }
  i.webhookUrl = url; audit.log(req.user, 'webhook_changed', url.replace(/[?#].*$/, ''));
  i.events = (Array.isArray(req.body.events) ? req.body.events : []).filter(e => webhooks.EVENTS.includes(e));
  let secret = null;
  if (!i.webhookSecret || req.body.rotateSecret) { secret = webhooks.newSecret(); i.webhookSecret = secret; }
  await db.write();
  res.json({ ok: true, signingSecret: secret, ...view(f) });
});

router.post('/test', async (req, res) => {
  await db.read();
  const f = firmOf(req);
  if (!f) return res.status(404).json({ error: 'Company not found' });
  try { res.json(await webhooks.sendTest(f)); } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/deliveries', async (req, res) => {
  await db.read();
  const list = (db.data.webhookDeliveries || []).filter(d => d.vendorId === req.user.vendorRootId).slice(-50).reverse()
    .map(d => ({ id: d.id, event: d.event, caseId: d.caseId, status: d.status, attempts: d.attempts, lastCode: d.lastCode || null, lastError: d.lastError || null, nextAt: d.nextAt || null, createdAt: d.createdAt, deliveredAt: d.deliveredAt || null }));
  res.json(list);
});
router.post('/deliveries/:id/retry', async (req, res) => {
  await db.read();
  const d = (db.data.webhookDeliveries || []).find(x => x.id === req.params.id && x.vendorId === req.user.vendorRootId);
  if (!d) return res.status(404).json({ error: 'Not found' });
  d.status = 'pending'; d.nextAt = new Date().toISOString(); d.attempts = Math.min(d.attempts, 5);
  await db.write();
  res.json({ ok: true });
});

module.exports = router;
