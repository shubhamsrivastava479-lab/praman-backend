const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function hoursBetween(a, b) {
  return (new Date(b) - new Date(a)) / (1000 * 60 * 60);
}

function summarizeCases(cases) {
  const byStatus = {};
  const byType = {};
  let resolvedHoursSum = 0, resolvedCount = 0;
  for (const c of cases) {
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    byType[c.caseType || 'claim_investigation'] = (byType[c.caseType || 'claim_investigation'] || 0) + 1;
    if (c.status === 'completed' && c.completedAt) {
      resolvedHoursSum += hoursBetween(c.createdAt, c.completedAt);
      resolvedCount++;
    }
  }
  return {
    total: cases.length,
    byStatus,
    byType,
    avgResolutionHours: resolvedCount ? +(resolvedHoursSum / resolvedCount).toFixed(1) : null
  };
}

function last7DaysTrend(cases) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const count = cases.filter(c => c.createdAt?.slice(0, 10) === key).length;
    days.push({ date: key, count });
  }
  return days;
}

// ---------- Company-wide (Admin view — also visible to agents, since it's their team's own data) ----------
router.get('/company', async (req, res) => {
  await db.read();
  const vendorId = req.user.vendorRootId;
  const cases = db.data.cases.filter(c => c.vendorId === vendorId);
  const caseIds = new Set(cases.map(c => c.id));
  const evidence = db.data.evidence.filter(e => caseIds.has(e.caseId));
  const custody = db.data.custody.filter(x => caseIds.has(x.caseId));
  const agents = db.data.users.filter(u => u.role === 'agent' && u.parentVendorId === vendorId);

  const callsCount = custody.filter(x => x.event.includes('Screen share started')).length;
  const kycChecksCount = custody.filter(x => x.actor === 'kyc_check' || x.actor === 'participant').length;
  const recordingsCount = evidence.filter(e => e.type === 'call_recording').length;

  const perAgent = agents.map(a => {
    const mine = cases.filter(c => c.assignedAgentId === a.id);
    const completed = mine.filter(c => c.status === 'completed');
    return {
      name: a.agentName,
      email: a.email,
      assigned: mine.length,
      completed: completed.length,
      avgResolutionHours: completed.length
        ? +(completed.reduce((s, c) => s + (c.completedAt ? hoursBetween(c.createdAt, c.completedAt) : 0), 0) / completed.length).toFixed(1)
        : null
    };
  });

  res.json({
    cases: summarizeCases(cases),
    trend7Days: last7DaysTrend(cases),
    evidenceCollected: evidence.length,
    callsCount,
    kycChecksCount,
    recordingsCount,
    agentCount: agents.length,
    perAgent
  });
});

// ---------- Personal (Agent's own view, or a vendor_admin checking their own activity) ----------
router.get('/mine', async (req, res) => {
  await db.read();
  const vendorId = req.user.vendorRootId;
  const myCases = db.data.cases.filter(c => c.vendorId === vendorId && c.assignedAgentId === req.user.id);
  const caseIds = new Set(myCases.map(c => c.id));
  const myCustody = db.data.custody.filter(x => caseIds.has(x.caseId) && x.actor === req.user.email);

  res.json({
    cases: summarizeCases(myCases),
    trend7Days: last7DaysTrend(myCases),
    recentActivity: myCustody
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 15)
      .map(x => ({ event: x.event, timestamp: x.timestamp }))
  });
});

module.exports = router;
