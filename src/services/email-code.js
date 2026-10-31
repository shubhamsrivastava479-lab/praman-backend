// 6-digit codes sent to an email address (demo form, forgot password, new firm registration).
// A code lasts 10 minutes, works once, allows 5 wrong tries, and an address gets at most 3 codes an hour.
const crypto = require('crypto');
const notifications = require('./notifications');

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const FREE = /^(gmail|googlemail|yahoo|ymail|rocketmail|outlook|hotmail|live|msn|rediffmail|rediff|icloud|me|mac|aol|proton|protonmail|pm|gmx|mail|zoho|yandex|inbox|tutanota)\.[a-z.]+$/i;
const store = new Map(); // "kind|email" -> { hash, exp, tries, sends:[times] }
const secret = () => process.env.JWT_SECRET || 'praman';
const hash = (key, code) => crypto.createHash('sha256').update(secret() + '|' + key + '|' + code).digest('hex');

const available = () => !!notifications.transport();
const clean = (v, max = 120) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// official = true: a company address is needed (not Gmail, Yahoo, Outlook ...)
function email(raw, official) {
  const e = clean(raw).toLowerCase();
  if (!EMAIL.test(e)) return { error: 'Please enter a valid email address.' };
  if (official && !process.env.ALLOW_FREE_EMAIL && FREE.test(e.split('@')[1])) return { error: 'Please use your official company email (not Gmail, Yahoo, Outlook etc.).' };
  return { email: e };
}

async function issue(kind, addr, subject, text) {
  if (!available()) return { status: 503, error: 'Email codes are not switched on yet.' };
  const key = kind + '|' + addr, now = Date.now();
  const cur = store.get(key) || { sends: [] };
  cur.sends = cur.sends.filter(t => now - t < 3600e3);
  if (cur.sends.length >= 3) return { status: 429, error: 'Too many codes for this email. Please try again in an hour.' };
  if (cur.sends.length && now - cur.sends[cur.sends.length - 1] < 30e3) return { status: 429, error: 'Please wait 30 seconds before asking for another code.' };
  const code = String(crypto.randomInt(100000, 1000000));
  const sent = await notifications.sendMail(addr, subject, text.replace('{code}', code));
  if (!sent) return { status: 502, error: 'We could not send the email. Please check the address and try again.' };
  cur.sends.push(now);
  Object.assign(cur, { hash: hash(key, code), exp: now + 10 * 60e3, tries: 0 });
  store.set(key, cur);
  return { ok: true };
}

function check(kind, addr, code) {
  const key = kind + '|' + addr, cur = store.get(key), c = clean(code, 6);
  if (!cur || !cur.hash || Date.now() > cur.exp) return { status: 400, error: 'Please get a new email code and enter it.' };
  if (cur.tries >= 5) return { status: 429, error: 'Too many wrong codes. Please ask for a new one.' };
  if (!(c.length === 6 && crypto.timingSafeEqual(Buffer.from(hash(key, c)), Buffer.from(cur.hash)))) { cur.tries++; return { status: 400, error: 'That code is not correct.' }; }
  store.delete(key);
  return { ok: true };
}

module.exports = { available, email, issue, check, clean, isFree: e => FREE.test(String(e || '').split('@')[1] || '') };
