// Masks all but the last 4 characters of a sensitive ID (Aadhaar, PAN, DL
// number) — used anywhere such a number would otherwise be written to the
// database, a log line, or a custody-trail event. The full number is only
// ever used in-memory for the single verification API call itself; it is
// never persisted or displayed afterward.
function maskId(value) {
  if (!value) return value;
  const str = String(value).replace(/\s/g, '');
  if (str.length <= 4) return '••••';
  return '•'.repeat(str.length - 4) + str.slice(-4);
}

// Redacts common Indian ID number patterns found inside a larger text blob
// (e.g. a Gridlines API JSON response) before it's stored as evidence —
// so a full Aadhaar/PAN number never ends up sitting in the database even
// inside a nested JSON string.
function redactIdsInText(text) {
  if (!text) return text;
  return String(text)
    .replace(/\b\d{4}\s?\d{4}\s?\d{4}\b/g, m => maskId(m)) // Aadhaar-shaped: 12 digits
    .replace(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, m => maskId(m)); // PAN-shaped
}

// Minimal in-memory sliding-window rate limiter for public, unauthenticated
// routes (participant wizard, shared report links) — protects against
// brute-forcing a case ID or share token, or spamming the Gemini/Gridlines
// APIs at someone else's cost. Not for authenticated, internal traffic.
const buckets = new Map();
function rateLimit({ windowMs = 60_000, max = 20 } = {}) {
  return (req, res, next) => {
    const key = req.ip + ':' + req.baseUrl;
    const now = Date.now();
    const bucket = buckets.get(key) || [];
    const recent = bucket.filter(t => now - t < windowMs);
    if (recent.length >= max) {
      return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    }
    recent.push(now);
    buckets.set(key, recent);
    next();
  };
}

module.exports = { maskId, redactIdsInText, rateLimit };
