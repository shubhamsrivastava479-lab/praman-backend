// Second step of every login (vendor, agent, insurer, Super Admin): a 6-digit code sent to the person's email,
// after the password or the Google sign-in has been accepted.
//  - Needs email sending (SMTP_URL). Without it the step is skipped, so nobody is locked out.
//  - People who already use an authenticator app (two-step login) are not asked twice.
//  - LOGIN_OTP=off on the server switches it off at once (in case the email service stops).
const crypto = require('crypto');
const notifications = require('./notifications');

const challenges = new Map(); // id -> { userId, hash, exp, tries, sends:[times] }
const secret = () => process.env.JWT_SECRET || 'praman';
const hash = (id, code) => crypto.createHash('sha256').update(secret() + '|login|' + id + '|' + code).digest('hex');
const enabled = () => String(process.env.LOGIN_OTP || '').toLowerCase() !== 'off' && !!notifications.transport();
const needed = user => enabled() && !user.totpEnabled;
const mask = e => { const [a, d] = String(e).split('@'); return (a.slice(0, 2) + '•••') + '@' + (d || ''); };

async function mail(user, c, id) {
  const code = String(crypto.randomInt(100000, 1000000));
  const ok = await notifications.sendMail(user.email, 'Your Praman login code',
    `Your Praman login code is ${code}.\nIt is valid for 10 minutes. If you did not try to log in, please change your password.\n\nSatyaSakshi LLP · Praman`);
  if (!ok) return false;
  c.hash = hash(id, code); c.exp = Date.now() + 10 * 60e3; c.tries = 0; c.sends.push(Date.now());
  return true;
}

async function start(user) {
  const id = crypto.randomBytes(24).toString('hex');
  const c = { userId: user.id, sends: [] };
  if (!(await mail(user, c, id))) return { error: 'We could not send the login code to your email. Please try again, or ask the platform admin.' };
  challenges.set(id, c);
  const now = Date.now();
  if (challenges.size > 3000) for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k);
  return { challenge: id, email: mask(user.email) };
}

async function resend(id, findUser) {
  const c = challenges.get(id);
  if (!c) return { status: 400, error: 'Your login has expired. Please log in again.' };
  const now = Date.now();
  c.sends = c.sends.filter(t => now - t < 3600e3);
  if (c.sends.length >= 4) return { status: 429, error: 'Too many codes. Please log in again after some time.' };
  if (c.sends.length && now - c.sends[c.sends.length - 1] < 30e3) return { status: 429, error: 'Please wait 30 seconds before asking for another code.' };
  const user = findUser(c.userId);
  if (!user || !(await mail(user, c, id))) return { status: 502, error: 'We could not send the code. Please try again.' };
  return { ok: true };
}

function verify(id, code) {
  const c = challenges.get(String(id || ''));
  const t = String(code || '').trim();
  if (!c || Date.now() > c.exp) return { status: 400, error: 'This code has expired. Please log in again.' };
  if (c.tries >= 5) { challenges.delete(id); return { status: 429, error: 'Too many wrong codes. Please log in again.' }; }
  if (!(t.length === 6 && crypto.timingSafeEqual(Buffer.from(hash(id, t)), Buffer.from(c.hash)))) { c.tries++; return { status: 400, error: 'That code is not correct.' }; }
  challenges.delete(id);
  return { ok: true, userId: c.userId };
}

module.exports = { enabled, needed, start, resend, verify };
