// A small picture code ("captcha") that stops simple bots, with nothing to sign up for.
// The server remembers nothing: the id carries a signed expiry and a signed fingerprint of the answer.
// Each id works for ONE try (a wrong answer burns it too), so a bot cannot guess its way through.
// For stronger protection later, Cloudflare Turnstile can replace this.
const crypto = require('crypto');
const CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const secret = () => process.env.JWT_SECRET || 'praman';
const sign = s => crypto.createHmac('sha256', secret()).update(s).digest('base64url').slice(0, 32);
const used = new Map(); // nonce -> expiry (only to stop a second try with the same picture)
const rnd = (a, b) => a + crypto.randomInt(0, 1000) / 1000 * (b - a);

function picture(text) {
  const W = 168, H = 56;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#f1f5f9"/>`;
  for (let i = 0; i < 6; i++) s += `<path d="M${rnd(0, W)} ${rnd(0, H)} Q${rnd(0, W)} ${rnd(0, H)} ${rnd(0, W)} ${rnd(0, H)}" stroke="hsl(${Math.round(rnd(0, 360))},45%,55%)" stroke-width="1.6" fill="none" opacity=".7"/>`;
  for (let i = 0; i < 30; i++) s += `<circle cx="${rnd(0, W).toFixed(1)}" cy="${rnd(0, H).toFixed(1)}" r="${rnd(.6, 1.6).toFixed(1)}" fill="hsl(${Math.round(rnd(0, 360))},40%,45%)" opacity=".6"/>`;
  [...text].forEach((ch, i) => {
    const x = 16 + i * 30 + rnd(-2, 2), y = 38 + rnd(-5, 5);
    s += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="${Math.round(rnd(28, 34))}" fill="hsl(${Math.round(rnd(190, 260))},55%,26%)" transform="rotate(${rnd(-22, 22).toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})">${ch}</text>`;
  });
  return s + '</svg>';
}

function create() {
  const answer = Array.from({ length: 5 }, () => CH[crypto.randomInt(CH.length)]).join('');
  const exp = Date.now() + 5 * 60e3, nonce = crypto.randomBytes(8).toString('hex');
  const id = `${nonce}.${exp}.${sign(`${nonce}|${exp}|${answer}`)}`;
  return { id, image: 'data:image/svg+xml;base64,' + Buffer.from(picture(answer)).toString('base64'), answer };
}

function check(id, text) {
  const [nonce, exp, h] = String(id || '').split('.');
  const t = String(text || '').trim().toUpperCase();
  if (!nonce || !/^\d+$/.test(exp || '') || !h || Date.now() > Number(exp) || used.has(nonce)) return false;
  used.set(nonce, Number(exp));
  const now = Date.now();
  if (used.size > 5000) for (const [k, e] of used) if (e < now) used.delete(k);
  const want = sign(`${nonce}|${exp}|${t}`);
  return want.length === h.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(h));
}

module.exports = { create, check };
