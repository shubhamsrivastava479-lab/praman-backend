// Runs the Gridlines checks (PAN, driving licence, RC, chassis, FASTag, e-challan, CIBIL, digital footprint).
//
// Every call is written down:
//   db.data.apiTransactions  one line per call: who, which case, which check, masked input, result (success / failed /
//                            blocked), time taken, price charged, the provider's own reference.
//   db.data.apiResults       the data that came back (full), linked to the line above.
// Each API has its own key (Super Admin > Gridlines checks). The wallet is charged first and refunded if the call fails.
const { db, uid } = require('../db');
const { APIS } = require('./gridlines-apis');
const { maskId, redactIdsInText } = require('./security');

const BASE = 'https://api.gridlines.io';
const TIMEOUT_MS = 30000;
const MAX_TXNS = 20000;

const ps = () => (db.data.platformSettings ||= {});
const clean = v => String(v == null ? '' : v).replace(/(key|token|secret|password|authorization)=([^&\s"']+)/gi, '$1=…').slice(0, 300);
const fail = (code, message) => Object.assign(new Error(message), { code });

// ---- settings ----
function configOf(id) {
  const api = APIS[id], mine = (ps().gridlinesApis || {})[id] || {};
  let body = api.body;
  if (mine.body) { try { const b = JSON.parse(mine.body); if (b && typeof b === 'object' && !Array.isArray(b)) body = b; } catch { /* keep default */ } }
  return { path: mine.path || api.path, body, confirmed: api.confirmed || !!mine.path || !!mine.body };
}
function keyOf(id) {
  const own = (ps().gridlinesKeys || {})[id];
  if (own) return { key: own, source: 'dashboard' };
  const env = process.env['GRIDLINES_KEY_' + id.toUpperCase()];
  if (env) return { key: env, source: 'env' };
  // PAN and driving licence worked with one shared key before; keep that working.
  if (id === 'pan' || id === 'dl') {
    const shared = ps().gridlinesApiKey || process.env.GRIDLINES_API_KEY;
    if (shared) return { key: shared, source: 'shared' };
  }
  return { key: null, source: null };
}
const authType = () => ps().gridlinesAuthType || process.env.GRIDLINES_AUTH_TYPE || 'API-Key';

// What the screens need: every check, whether it can run, and what to type.
function catalog() {
  return Object.entries(APIS).map(([id, a]) => {
    const k = keyOf(id), c = configOf(id);
    return { id, label: a.label, short: a.short, ready: !!k.key, needsConsent: !!a.needsConsent, confirmed: c.confirmed,
      inputs: a.inputs.map(i => ({ key: i.key, label: i.label, required: !!i.required, hint: i.hint || '' })) };
  });
}

// ---- input ----
function validate(id, input) {
  const api = APIS[id], out = {}, src = input || {};
  for (const f of api.inputs) {
    let v = String(src[f.key] == null ? '' : src[f.key]).replace(/\s+/g, ' ').trim().slice(0, 120);
    if (/^(panNumber|dlNumber|rcNumber|chassisNumber|vehicleNumber|engineNumber)$/.test(f.key)) { v = v.toUpperCase(); if (f.key !== 'dlNumber') v = v.replace(/\s|-/g, ''); }
    if (!v) { if (f.required) throw fail('INVALID', `${f.label} is required.`); continue; }
    if (f.pattern && !f.pattern.test(v)) throw fail('INVALID', `${f.label} does not look right.${f.hint ? ' ' + f.hint + '.' : ''}`);
    out[f.key] = v;
  }
  return out;
}
function fill(template, values) {
  const out = {};
  for (const [k, t] of Object.entries(template || {})) {
    if (typeof t !== 'string') { out[k] = t; continue; }
    const m = /^\{\{(\w+)\}\}$/.exec(t);
    if (m) { if (values[m[1]] != null && values[m[1]] !== '') out[k] = values[m[1]]; continue; }
    out[k] = t.replace(/\{\{(\w+)\}\}/g, (_, n) => values[n] == null ? '' : values[n]);
  }
  return out;
}
const maskedInput = (id, values) => {
  const ids = new Set(APIS[id].inputs.filter(i => i.id).map(i => i.key));
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, ids.has(k) ? maskId(v) : v]));
};

// Why it failed, in words a vendor may see (the provider's own text stays with the Super Admin).
function vendorReason(code) {
  return ({
    NOT_CONFIGURED: 'This check is not switched on yet. Please contact the platform admin.',
    WALLET_LOW: 'Your wallet balance is too low for this check.',
    INVALID: 'Please check the details and try again.',
    PROVIDER_REJECTED: 'The details were not accepted. Please check them and try again.',
    PROVIDER_DOWN: 'The service did not answer. Please try again in a few minutes.'
  })[code] || 'The check could not be completed.';
}

// ---- the call ----
async function call({ api, input, user = {}, vendorId, caseId = null, consent = false }) {
  const def = APIS[api];
  if (!def) throw fail('INVALID', 'Unknown check.');
  await db.read();
  const c = caseId ? db.data.cases.find(x => x.id === caseId) : null;
  const txns = (db.data.apiTransactions ||= []);
  const t0 = Date.now();
  const txn = { id: uid('atx'), at: new Date().toISOString(), api, label: def.label, vendorId, userId: user.id || null, userEmail: user.email || null,
    caseId: c ? c.id : null, caseRef: c ? (c.caseRef || c.claimNo || null) : null, status: 'started', input: {}, ms: null };
  txns.push(txn);
  if (txns.length > MAX_TXNS) txns.splice(0, txns.length - MAX_TXNS);
  const finish = async (status, extra = {}) => { Object.assign(txn, { status, ms: Date.now() - t0, finishedAt: new Date().toISOString() }, extra); await db.write().catch(() => {}); };
  const stop = async (e) => { await finish('blocked', { reasonCode: e.code || 'ERROR', error: clean(e.message) }); throw e; };

  let values;
  try {
    values = validate(api, input);
    txn.input = maskedInput(api, values);
    if (def.needsConsent) {
      if (consent !== true) throw fail('INVALID', 'The person\'s consent is required for this check.');
      txn.consentAt = txn.at;
    }
  } catch (e) { return stop(e); }

  const k = keyOf(api);
  if (!k.key) return stop(fail('NOT_CONFIGURED', 'No API key is set for ' + def.label + '.'));

  let row = null;
  try {
    row = require('./wallet').chargeKyc(db.data, vendorId, api, { caseId: txn.caseId });
    if (row) txn.walletTxnId = row.id;
  } catch (e) { return stop(fail(e.code === 'WALLET_LOW' ? 'WALLET_LOW' : 'ERROR', e.message)); }

  const cfg = configOf(api);
  let res, json, httpStatus = null;
  try {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      res = await fetch(BASE + cfg.path, { method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', 'X-API-Key': k.key, 'X-Auth-Type': authType() },
        body: JSON.stringify(fill(cfg.body, values)) });
    } finally { clearTimeout(timer); }
    httpStatus = res.status;
    json = await res.json().catch(() => ({}));
    if (!res.ok) throw fail(res.status >= 500 ? 'PROVIDER_DOWN' : 'PROVIDER_REJECTED', (json && (json.message || json.error)) || `Gridlines API error ${res.status}`);
  } catch (e) {
    if (row) { require('./wallet').refund(db.data, row.id, 'Refund (check failed)'); txn.refunded = true; }
    const code = e.code === 'PROVIDER_REJECTED' || e.code === 'PROVIDER_DOWN' ? e.code : 'PROVIDER_DOWN';
    await finish('failed', { httpStatus, reasonCode: code, error: clean(e.name === 'AbortError' ? 'Timed out after 30 s' : e.message) });
    throw Object.assign(fail(code, vendorReason(code)), { txn });
  }

  const data = (json && json.data !== undefined) ? json.data : json;
  const result = { id: uid('ares'), txnId: txn.id, api, label: def.label, vendorId, caseId: txn.caseId, at: new Date().toISOString(), request: values, data, raw: json && json.data !== undefined ? { request_id: json.request_id, status: json.status } : undefined };
  (db.data.apiResults ||= []).push(result);
  if (c) {
    db.data.custody.push({ id: uid('cust'), caseId: c.id, event: `${def.label} done (${Object.values(txn.input).slice(0, 1).join('')})`, actor: 'kyc_check', timestamp: result.at });
    db.data.evidence.push({ id: uid('ev'), caseId: c.id, source: 'kyc_check', type: api + '_lookup', caption: `${def.label} result`, apiResultId: result.id,
      analysis: { documentType: api, visibleText: redactIdsInText(JSON.stringify(data)).slice(0, 6000), notableDetails: '' }, receivedAt: result.at });
  }
  await finish('success', { httpStatus, resultId: result.id, providerRef: clean((json && (json.request_id || (json.data && json.data.request_id) || json.transaction_id)) || ''), providerCode: clean((data && (data.code || data.status)) || '') });
  return { txn, result };
}

module.exports = { call, catalog, configOf, keyOf, validate, fill, vendorReason, APIS };
