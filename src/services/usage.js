// AI (Gemini) usage and cost, so the Super Admin can see WHAT costs the most.
//
// Every Gemini reply carries usageMetadata: the exact tokens Google bills (input, audio input,
// output incl. thinking). We record them per day, per task (speech-to-text, face check ...),
// per model, per firm and per case. Cost = tokens x the price per 1M tokens set for the model
// (Super Admin > AI cost > prices). A model with no price set shows tokens only, never a guess.
//
// Which case / firm / task a call belongs to comes from an AsyncLocalStorage context set by
// the routes (ai-call by token, WhatsApp media by case) and by the Gemini wrapper (task name).
const { AsyncLocalStorage } = require('async_hooks');
const { db } = require('../db');

const als = new AsyncLocalStorage();
const run = (ctx, fn) => als.run({ ...(als.getStore() || {}), ...ctx }, fn);
const context = () => als.getStore() || {};

const day = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); // India date

// USD per 1M tokens. Only prices we know are filled in; the rest are set in Super Admin.
// gemini-3.6-flash: $0.75 input / $3.75 output until 31 Dec 2026, then $1.50 / $7.50.
const DEFAULT_PRICES = {
  'gemini-3.6-flash': { in: 0.75, audioIn: null, out: 3.75, note: 'Until 31 Dec 2026; then 1.50 / 7.50' }
};
function prices() {
  const set = ((db.data.platformSettings || {}).aiPrices) || {};
  return { ...DEFAULT_PRICES, ...set };
}
function costOf(model, t) {
  const p = prices()[model];
  if (!p || p.in == null || p.out == null) return null;
  const audioIn = p.audioIn == null ? p.in : p.audioIn;
  return ((t.inTok - t.audioTok) * p.in + t.audioTok * audioIn + t.outTok * p.out) / 1e6;
}
function tokensOf(meta) {
  const m = meta || {};
  const audio = (m.promptTokensDetails || []).filter(d => d.modality === 'AUDIO').reduce((a, d) => a + (d.tokenCount || 0), 0);
  return {
    inTok: m.promptTokenCount || 0,
    audioTok: audio,
    outTok: (m.candidatesTokenCount || 0) + (m.thoughtsTokenCount || 0) // thinking tokens are billed as output
  };
}

const add = (o, t, ok) => {
  o.calls = (o.calls || 0) + (ok ? 1 : 0);
  if (!ok) o.errors = (o.errors || 0) + 1;
  o.inTok = (o.inTok || 0) + t.inTok; o.audioTok = (o.audioTok || 0) + t.audioTok; o.outTok = (o.outTok || 0) + t.outTok;
};
const SEP = '||';

// Called by gemini.generate after every attempt that ended (ok with its reply, or failed).
// Tokens are kept per task+model, firm+model and case task+model; cost is worked out when shown,
// from the current prices (so a price set later applies to past use too).
function record({ label, model, ok, reply }) {
  try {
    const ctx = context();
    const task = ctx.task || label || 'other';
    const mdl = model || '?';
    const t = tokensOf(reply && reply.usageMetadata);
    const u = (db.data.aiUsage ||= {});
    const d = (u[day()] ||= {});
    const kind = /TTS|speech/i.test(label + task) ? 'voice' : 'text';
    d[kind] = (d[kind] || 0) + (ok ? 1 : 0);
    if (!ok) d.errors = (d.errors || 0) + 1;
    add((d.tm ||= {})[task + SEP + mdl] ||= {}, t, ok);
    add((d.fm ||= {})[(ctx.firmId || 'none') + SEP + mdl] ||= {}, t, ok);
    const m = (d.models ||= {}); if (ok) m[mdl] = (m[mdl] || 0) + 1; // older counter, kept
    if (ctx.caseId) {
      const c = (db.data.cases || []).find(x => x.id === ctx.caseId);
      if (c) add(((c.aiCost ||= {}).tm ||= {})[task + SEP + mdl] ||= {}, t, ok);
    }
    const keys = Object.keys(u).sort();
    while (keys.length > 90) delete u[keys.shift()];
  } catch { /* never break a call because of counting */ }
}
// Older callers.
function bump(label, model, ok) { record({ label, model, ok, reply: null }); }

// Rows { key: { calls, errors, inTok, audioTok, outTok } } with key "<name>||<model>" -> grouped by name or by model, with cost.
function group(entries, by) {
  const out = {};
  for (const [key, v] of entries) {
    const [name, model] = key.split(SEP);
    const k = by === 'model' ? model : name;
    const o = out[k] ||= { name: k, calls: 0, errors: 0, inTok: 0, audioTok: 0, outTok: 0, usd: 0, unpriced: 0 };
    for (const f of ['calls', 'errors', 'inTok', 'audioTok', 'outTok']) o[f] += v[f] || 0;
    const usd = costOf(model, { inTok: v.inTok || 0, audioTok: v.audioTok || 0, outTok: v.outTok || 0 });
    if (usd == null) o.unpriced += v.calls || 0; else o.usd += usd;
  }
  return Object.values(out).sort((a, b) => b.usd - a.usd || (b.inTok + b.outTok) - (a.inTok + a.outTok));
}

function summary(days = 30) {
  const u = db.data.aiUsage || {};
  const keys = Object.keys(u).sort().slice(-days);
  const sum = k => keys.reduce((a, d) => a + (u[d][k] || 0), 0);
  const all = field => keys.flatMap(d => Object.entries(u[d][field] || {}));
  const users = db.data.users || [];
  const firms = group(all('fm'), 'name').map(f => ({ ...f, name: f.name === 'none' ? 'Not linked to a firm' : ((users.find(x => x.id === f.name) || {}).vendorName || f.name) }));
  const since = keys[0] ? new Date(keys[0] + 'T00:00:00+05:30') : null;
  const cases = (db.data.cases || []).filter(c => c.aiCost && c.aiCost.tm && (!since || new Date(c.createdAt) >= since)).map(c => {
    const tasks = group(Object.entries(c.aiCost.tm), 'name');
    return { caseRef: c.caseRef || c.claimNo, service: c.service, firm: (users.find(x => x.id === c.vendorId) || {}).vendorName || '',
      calls: tasks.reduce((a, x) => a + x.calls, 0), usd: tasks.reduce((a, x) => a + x.usd, 0), unpriced: tasks.reduce((a, x) => a + x.unpriced, 0),
      tasks: Object.fromEntries(tasks.map(x => [x.name, x.usd])) };
  });
  const done = cases.filter(c => c.calls);
  const dayRows = keys.map(d => { const g = group(Object.entries(u[d].tm || {}), 'model'); return { date: d, text: u[d].text || 0, voice: u[d].voice || 0, errors: u[d].errors || 0, usd: g.reduce((a, x) => a + x.usd, 0) }; });
  const sc = require('./speech-cache');
  return {
    cacheHits: sc.stats.hits, cacheMisses: sc.stats.misses,
    days: dayRows, text: sum('text'), voice: sum('voice'), errors: sum('errors'), usd: dayRows.reduce((a, x) => a + x.usd, 0),
    tasks: group(all('tm'), 'name'), models: group(all('tm'), 'model'), firms,
    topCases: cases.sort((a, b) => b.usd - a.usd).slice(0, 15),
    perCase: done.length ? { cases: done.length, averageUsd: done.reduce((a, c) => a + c.usd, 0) / done.length } : null,
    prices: prices()
  };
}

// Super Admin edits prices: { model: { in, audioIn, out } } in USD per 1M tokens.
function setPrices(input) {
  const out = {};
  for (const [model, p] of Object.entries(input || {})) {
    if (!/^[a-z0-9.\-]{3,80}$/i.test(model)) continue;
    const n = v => (v === '' || v == null || !isFinite(Number(v)) || Number(v) < 0) ? null : Number(v);
    out[model] = { in: n(p.in), audioIn: n(p.audioIn), out: n(p.out) };
  }
  (db.data.platformSettings ||= {}).aiPrices = out;
  return prices();
}

module.exports = { bump, record, summary, run, context, setPrices, prices, tokensOf, costOf, DEFAULT_PRICES };
