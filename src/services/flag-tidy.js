// Keeps the red-flag list short and readable:
//  - one line per topic (e.g. "Aadhaar not received" was listed twice: once by the call, once by the check)
//  - drops AI notes that only misread Indian amounts as dollars
// Order is kept; the first line of a topic stays.
const TOPICS = [
  ['aadhaar_missing', t => /aadhaar/i.test(t) && /not (been )?(received|sent)/i.test(t)],
  ['pan_missing', t => /\bpan\b/i.test(t) && /not (been )?(received|sent)/i.test(t)],
  ['promise', t => /guarantee|cash ?back|cash payment|assured return/i.test(t)],
  ['ai_busy', t => /AI (answer check )?could not (check|run)|service busy/i.test(t)]
];
const FOREIGN_MONEY = /\b(us|american)\b.*\bcurrenc|\bdollars?\b|\bmillion dollars\b/i;

function tidy(flags) {
  const seen = new Set(), out = [];
  for (const f of flags || []) {
    const t = String(f || '').trim();
    if (!t || FOREIGN_MONEY.test(t)) continue;
    const topic = (TOPICS.find(([, test]) => test(t)) || [t.toLowerCase()])[0];
    if (seen.has(topic)) continue;
    seen.add(topic); out.push(t);
  }
  return out;
}

// Speech language names as people read them. Odd guesses on a short word ("Turkish" for "Yes")
// fall back to the call's language.
const CODES = { en: 'English', hi: 'Hindi', bn: 'Bengali', mr: 'Marathi', te: 'Telugu', ta: 'Tamil', gu: 'Gujarati', ur: 'Urdu', kn: 'Kannada', or: 'Odia', ml: 'Malayalam', pa: 'Punjabi', as: 'Assamese', ne: 'Nepali' };
const KNOWN = new Set([...Object.values(CODES), 'Hinglish', 'Bhojpuri', 'Maithili', 'Konkani', 'Sindhi', 'Kashmiri', 'Dogri', 'Manipuri', 'Santali', 'Sanskrit', 'Rajasthani', 'Haryanvi', 'Chhattisgarhi', 'Tulu']);
function langName(l, fallback = 'English') {
  let s = String(l || '').trim();
  if (!s || /^unknown$/i.test(s)) return fallback;
  const code = s.toLowerCase().split(/[-_]/)[0];
  if (CODES[code] && s.length <= 5) return CODES[code];
  s = s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  if (s === 'Hinglish') return 'Hindi';
  return KNOWN.has(s) ? s : fallback;
}

module.exports = { tidy, langName };
