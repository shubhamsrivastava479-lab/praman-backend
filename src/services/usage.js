// Counts AI (Gemini) calls per day so the Super Admin can see usage and failures.
// Platform-wide, kept for 90 days. Saved with the next database save (no extra writes).
const { db } = require('../db');

const day = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); // India date

function bump(label, model, ok) {
  try {
    const u = (db.data.aiUsage ||= {});
    const d = (u[day()] ||= {});
    const kind = /TTS/i.test(label) ? 'voice' : 'text';
    d[kind] = (d[kind] || 0) + (ok ? 1 : 0);
    if (!ok) d.errors = (d.errors || 0) + 1;
    const m = (d.models ||= {});
    if (ok) m[model] = (m[model] || 0) + 1;
    const keys = Object.keys(u).sort();
    while (keys.length > 90) delete u[keys.shift()];
  } catch { /* never break a call because of counting */ }
}

function summary(days = 30) {
  const u = db.data.aiUsage || {};
  const keys = Object.keys(u).sort().slice(-days);
  const sum = (k) => keys.reduce((a, d) => a + (u[d][k] || 0), 0);
  const sc = require('./speech-cache');
  return { cacheHits: sc.stats.hits, cacheMisses: sc.stats.misses, days: keys.map(d => ({ date: d, text: u[d].text || 0, voice: u[d].voice || 0, errors: u[d].errors || 0 })), text: sum('text'), voice: sum('voice'), errors: sum('errors') };
}

module.exports = { bump, summary };
