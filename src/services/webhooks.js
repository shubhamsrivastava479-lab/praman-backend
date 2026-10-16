// Tells the vendor's own system (insurer integration) when something happens to a case.
//
//   firm.integration = { apiKeyHash, apiKeyPrefix, webhookUrl, webhookSecret, events: [...], createdAt }
//
// Every event is saved as a delivery (db.data.webhookDeliveries) and sent by a small
// worker with retries (1 min, 5 min, 30 min, 2 h, 6 h, 24 h). A delivery is signed:
//   X-Praman-Signature: t=<unix seconds>,v1=<HMAC-SHA256 of "t.body" with the webhook secret>
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { db, uid } = require('../db');

const EVENTS = ['case.created', 'ai_call.completed', 'ai_call.handoff', 'case.reviewed', 'case.overdue'];
const RETRY_MINUTES = [1, 5, 30, 120, 360, 1440];
const MAX_KEEP = 2000;

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const newApiKey = () => 'pk_live_' + crypto.randomBytes(24).toString('hex');
const newSecret = () => 'whsec_' + crypto.randomBytes(24).toString('hex');

function sign(secret, body, ts = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return { header: `t=${ts},v1=${v1}`, ts, v1 };
}
function verifySignature(secret, body, header, toleranceSec = 300) {
  const m = /t=(\d+),v1=([a-f0-9]+)/.exec(String(header || ''));
  if (!m) return false;
  if (Math.abs(Date.now() / 1000 - Number(m[1])) > toleranceSec) return false;
  const want = sign(secret, body, Number(m[1])).v1;
  try { return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[2])); } catch { return false; }
}

// ---- address safety: a webhook must never reach our own network / metadata services ----
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::1' || x === '::' || x.startsWith('fe80') || x.startsWith('fc') || x.startsWith('fd')) return true;
    const m = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    return m ? isPrivateIp(m[1]) : false;
  }
  return true;
}
function checkUrlShape(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return 'The web address is not valid.'; }
  if (u.protocol !== 'https:' && !(process.env.ALLOW_HTTP_WEBHOOKS === '1' && u.protocol === 'http:')) return 'The webhook address must start with https://';
  if (u.username || u.password) return 'The web address must not contain a user name or password.';
  return null;
}
async function assertPublicUrl(raw) {
  const bad = checkUrlShape(raw);
  if (bad) throw new Error(bad);
  if (process.env.ALLOW_PRIVATE_WEBHOOKS === '1') return;
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('The webhook address points to a private network, which is not allowed.');
}

// ---- what the vendor receives ----
function caseSummary(c, extra = {}) {
  const a = c.aiCall || {};
  return {
    caseId: c.id,
    caseRef: c.caseRef,
    claimNo: c.claimNo,
    service: c.service || null,
    insuredName: c.insuredName || '',
    status: c.status,
    verificationMode: c.verificationMode,
    createdAt: c.createdAt,
    dueAt: c.dueAt || null,
    reviewState: c.reviewState || null,
    aiCall: a.status ? {
      status: a.status,
      decision: a.decision || null,
      summary: a.summary || null,
      flags: a.flags || [],
      checks: (a.checks || []).map(k => ({ id: k.id, label: k.label, result: k.result, detail: k.detail })),
      completedAt: a.completedAt || null,
      checklist: require('./checklist').buildChecklist(c).map(i => ({ item: i.label, group: i.group, status: i.status, detail: i.detail }))
    } : null,
    review: c.aiReview ? { finalVerdict: c.aiReview.finalVerdict, remarks: c.aiReview.remarks, reviewedAt: c.aiReview.reviewedAt, reviewer: c.aiReview.reviewerName } : null,
    ...extra
  };
}

// Queue an event for a case. Does nothing if the firm has no webhook or does not listen to this event.
// Must be followed by db.write() by the caller (it is part of the caller's save).
function emit(event, c, extra = {}) {
  try {
    const firm = (db.data.users || []).find(u => u.id === c.vendorId);
    const i = firm && firm.integration;
    if (!i || !i.webhookUrl || !i.webhookSecret) return null;
    if (Array.isArray(i.events) && i.events.length && !i.events.includes(event)) return null;
    const id = uid('wh');
    const payload = { id, event, createdAt: new Date().toISOString(), data: caseSummary(c, extra) };
    const list = (db.data.webhookDeliveries ||= []);
    list.push({ id, vendorId: firm.id, caseId: c.id, event, url: i.webhookUrl, payload: JSON.stringify(payload), attempts: 0, nextAt: new Date().toISOString(), status: 'pending', createdAt: payload.createdAt });
    if (list.length > MAX_KEEP) list.splice(0, list.length - MAX_KEEP);
    return id;
  } catch (e) { console.warn('Webhook queue failed:', e.message); return null; }
}

async function deliverOne(d, firm, fetchFn = fetch) {
  const secret = firm && firm.integration && firm.integration.webhookSecret;
  d.attempts += 1;
  d.lastAttemptAt = new Date().toISOString();
  try {
    if (!secret) throw new Error('No webhook secret');
    await assertPublicUrl(d.url);
    const sig = sign(secret, d.payload);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    let res;
    try {
      res = await fetchFn(d.url, {
        method: 'POST', redirect: 'manual', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Praman-Webhook/1', 'X-Praman-Event': d.event, 'X-Praman-Delivery': d.id, 'X-Praman-Signature': sig.header },
        body: d.payload
      });
    } finally { clearTimeout(timer); }
    d.lastCode = res.status;
    if (res.status >= 200 && res.status < 300) { d.status = 'delivered'; d.deliveredAt = new Date().toISOString(); d.lastError = null; return true; }
    throw new Error('Your server answered ' + res.status);
  } catch (e) {
    d.lastError = String(e.message || e).slice(0, 200);
    const wait = RETRY_MINUTES[d.attempts - 1];
    if (wait == null) { d.status = 'failed'; d.nextAt = null; }
    else d.nextAt = new Date(Date.now() + wait * 60e3).toISOString();
    return false;
  }
}

let running = false;
async function processDue(now = new Date(), fetchFn = fetch) {
  if (running) return 0;
  running = true;
  let n = 0;
  try {
    const due = (db.data.webhookDeliveries || []).filter(d => d.status === 'pending' && d.nextAt && new Date(d.nextAt) <= now).slice(0, 25);
    for (const d of due) {
      const firm = db.data.users.find(u => u.id === d.vendorId);
      await deliverOne(d, firm, fetchFn);
      n++;
    }
    if (n) await db.write();
  } finally { running = false; }
  return n;
}

// Sends one test event right now (from the settings page); returns the result to show.
async function sendTest(firm, fetchFn = fetch) {
  const i = firm.integration || {};
  if (!i.webhookUrl) throw new Error('Save a webhook address first.');
  const payload = { id: uid('wh'), event: 'test.ping', createdAt: new Date().toISOString(), data: { message: 'This is a test from Praman.' } };
  const d = { id: payload.id, vendorId: firm.id, event: 'test.ping', url: i.webhookUrl, payload: JSON.stringify(payload), attempts: 5, status: 'pending' };
  const ok = await deliverOne(d, firm, fetchFn);
  return { ok, code: d.lastCode || null, error: d.lastError || null };
}

module.exports = { EVENTS, RETRY_MINUTES, sha256, newApiKey, newSecret, sign, verifySignature, isPrivateIp, checkUrlShape, assertPublicUrl, caseSummary, emit, deliverOne, processDue, sendTest };
