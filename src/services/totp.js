// Two-step login with an authenticator app (Google Authenticator, Microsoft Authenticator, Authy…).
// Standard TOTP (RFC 6238): 6 digits, 30 seconds, SHA-1. No extra library needed.
const crypto = require('crypto');

const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += A[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
function unbase32(s) {
  let bits = '';
  for (const ch of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) bits += A.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

const newSecret = () => base32(crypto.randomBytes(20));

function codeAt(secret, t = Date.now()) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}

// accepts the previous, current and next 30-second window (clock differences)
function verify(secret, code, t = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c) || !secret) return false;
  return [-1, 0, 1].some(w => { const a = Buffer.from(codeAt(secret, t + w * 30000)), b = Buffer.from(c); return crypto.timingSafeEqual(a, b); });
}

const otpauthUrl = (secret, account, issuer = 'Praman') => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;

module.exports = { newSecret, codeAt, verify, otpauthUrl, base32, unbase32 };
