const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const gl = require('../services/gridlines');

const router = express.Router();
router.use(requireAuth);

// What checks exist and which are switched on.
router.get('/catalog', (req, res) => res.json({ checks: gl.catalog().filter(c => c.ready).map(({ confirmed, ...c }) => c) }));

// Run one check. body: { input:{...}, caseId?, consent? }
router.post('/run/:api', async (req, res) => {
  if (!gl.APIS[req.params.api]) return res.status(404).json({ error: 'Unknown check.' });
  const b = req.body || {};
  await db.read();
  if (b.caseId && !db.data.cases.find(c => c.id === b.caseId && c.vendorId === req.user.vendorRootId)) return res.status(404).json({ error: 'Case not found' });
  try {
    const { txn, result } = await gl.call({ api: req.params.api, input: b.input, user: req.user, vendorId: req.user.vendorRootId, caseId: b.caseId || null, consent: b.consent === true });
    res.json({ ok: true, transactionId: txn.id, data: result.data });
  } catch (e) {
    const code = e.code || 'ERROR';
    const msg = code === 'INVALID' || code === 'WALLET_LOW' ? e.message : gl.vendorReason(code);
    res.status(code === 'WALLET_LOW' ? 402 : code === 'INVALID' ? 400 : code === 'NOT_CONFIGURED' ? 503 : 502).json({ error: msg, code, transactionId: e.txn ? e.txn.id : undefined });
  }
});

// This firm's own history (no provider error text).
router.get('/transactions', async (req, res) => {
  await db.read();
  const q = req.query || {};
  let list = (db.data.apiTransactions || []).filter(t => t.vendorId === req.user.vendorRootId);
  if (q.caseId) list = list.filter(t => t.caseId === q.caseId);
  if (q.api) list = list.filter(t => t.api === q.api);
  list = list.slice(-Math.min(+q.limit || 100, 500)).reverse();
  res.json({ transactions: list.map(t => ({ id: t.id, at: t.at, api: t.api, label: t.label, caseRef: t.caseRef, caseId: t.caseId, status: t.status, input: t.input, ms: t.ms, resultId: t.resultId || null, refunded: !!t.refunded, by: t.userEmail })) });
});

// The stored data of one check.
router.get('/transactions/:id/result', async (req, res) => {
  await db.read();
  const t = (db.data.apiTransactions || []).find(x => x.id === req.params.id && x.vendorId === req.user.vendorRootId);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const r = (db.data.apiResults || []).find(x => x.txnId === t.id);
  if (!r) return res.status(404).json({ error: 'No stored data for this check (it failed or was cleared).' });
  res.json({ transaction: { id: t.id, at: t.at, label: t.label, status: t.status, input: t.input }, data: r.data });
});

module.exports = router;
