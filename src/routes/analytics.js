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
// Quality and speed of the AI calls for this firm (last 30 days by default).
router.get('/insights', async (req, res) => {
  await db.read();
  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
  const since = Date.now() - days * 864e5;
  const cases = db.data.cases.filter(c => c.vendorId === req.user.vendorRootId && c.aiCall && new Date(c.createdAt).getTime() >= since);
  const ai = cases.filter(c => c.verificationMode === 'full_automation');
  const st = c => c.aiCall.status || 'not_started';
  const finished = ai.filter(c => st(c) === 'completed');
  const med = a => { const x = a.filter(Number.isFinite).sort((p, q) => p - q); return x.length ? x[Math.floor(x.length / 2)] : null; };
  const mins = (a, b) => (new Date(b) - new Date(a)) / 60000;
  const dur = finished.map(c => c.aiCall.startedAt && c.aiCall.completedAt ? mins(c.aiCall.startedAt, c.aiCall.completedAt) : NaN);
  const wait = finished.map(c => c.aiCall.completedAt && c.aiReview && c.aiReview.reviewedAt ? mins(c.aiCall.completedAt, c.aiReview.reviewedAt) / 60 : NaN);
  const decisions = {}, flagCount = {}, reviewers = {};
  for (const c of finished) {
    const d = (c.aiReview && c.aiReview.finalVerdict && c.aiReview.finalVerdict !== 'pending_verification') ? c.aiReview.finalVerdict : (c.aiCall.decision || 'unknown');
    decisions[d] = (decisions[d] || 0) + 1;
    for (const f of c.aiCall.flags || []) { const k = String(f).replace(/[0-9]+/g, '#').slice(0, 90); flagCount[k] = (flagCount[k] || 0) + 1; }
    const who = c.aiReview && (c.aiReview.reviewedByLogin || c.aiReview.reviewerName);
    if (who) reviewers[who] = (reviewers[who] || 0) + 1;
  }
  const aiOverridden = finished.filter(c => c.aiReview && c.aiCall.decision && c.aiReview.finalVerdict !== 'pending_verification' && c.aiReview.finalVerdict !== c.aiCall.decision).length;
  const perDay = {};
  for (const c of ai) { const k = String(c.createdAt).slice(0, 10); perDay[k] = (perDay[k] || 0) + 1; }
  res.json({
    days,
    totals: { aiCases: ai.length, linkSentNotStarted: ai.filter(c => st(c) === 'not_started').length, inProgress: ai.filter(c => st(c) === 'in_progress').length, completed: finished.length, handoff: ai.filter(c => st(c) === 'handoff').length, awaitingReview: ai.filter(c => ['awaiting_review', 'awaiting_second_review'].includes(c.reviewState)).length },
    completionRate: ai.length ? Math.round(finished.length / ai.length * 100) : null,
    handoffRate: ai.length ? Math.round(ai.filter(c => st(c) === 'handoff').length / ai.length * 100) : null,
    medianCallMinutes: med(dur) == null ? null : +med(dur).toFixed(1),
    medianReviewWaitHours: med(wait) == null ? null : +med(wait).toFixed(1),
    aiChangedByReviewer: aiOverridden,
    decisions,
    topFlags: Object.entries(flagCount).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([flag, count]) => ({ flag, count })),
    reviewers: Object.entries(reviewers).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    perDay: Object.entries(perDay).sort().slice(-30).map(([date, count]) => ({ date, count }))
  });
});

// Fraud dashboard: exact rules only (record-rules.js, service-profiles.js), counted for the firm.
router.get('/fraud', async (req, res) => {
  await db.read();
  const days = Math.min(730, Math.max(1, parseInt(req.query.days, 10) || 90));
  res.json(require('../services/fraud-stats').build(db.data, req.user.vendorRootId, { days }));
});

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
