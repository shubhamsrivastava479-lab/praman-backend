// Remembers the translated text and the spoken audio of every AI line.
// The questions are the same for every customer, so after the first customer in a language
// the voice and translation of those lines cost nothing. Lines that carry a customer's own
// details (name, number) are cached too, but only matter for that customer.
// Kept in memory with a size limit (oldest dropped first); empty after a restart.
const MAX_BYTES = (parseInt(process.env.SPEECH_CACHE_MB, 10) || 60) * 1024 * 1024;
const map = new Map(); // key -> { value, size }
let bytes = 0;
const stats = { hits: 0, misses: 0 };

const key = (kind, language, text) => kind + '|' + (language || '') + '|' + text;

function get(kind, language, text) {
  const k = key(kind, language, text);
  const e = map.get(k);
  if (!e) { stats.misses++; return undefined; }
  map.delete(k); map.set(k, e);   // most recently used goes last
  stats.hits++;
  return e.value;
}

function set(kind, language, text, value) {
  if (value == null) return;
  const k = key(kind, language, text);
  const size = (typeof value === 'string' ? value.length : JSON.stringify(value).length) + k.length;
  if (size > MAX_BYTES / 4) return;
  const old = map.get(k); if (old) { bytes -= old.size; map.delete(k); }
  map.set(k, { value, size }); bytes += size;
  for (const [kk, e] of map) { if (bytes <= MAX_BYTES) break; map.delete(kk); bytes -= e.size; }
}

module.exports = { get, set, stats, size: () => ({ entries: map.size, mb: +(bytes / 1048576).toFixed(1) }) };
