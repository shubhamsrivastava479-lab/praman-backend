// Team roles under a company admin:
//   agent    works on cases (can sign off, assign, upload)
//   viewer   read-only access to everything the firm sees
//   insurer  read-only, only finished cases and their reports (for the insurance company)
const TEAM = ['agent', 'viewer', 'insurer'];
const isTeam = role => TEAM.includes(role);
const READ_ONLY = ['viewer', 'insurer'];

// Server-side guard, mounted before the API routes. Never trusts the page.
function guard(req, res, next) {
  const h = req.get('Authorization') || '';
  if (!h.startsWith('Bearer ')) return next();
  let u;
  try { u = require('./auth').verifyToken(h.slice(7)); } catch { return next(); } // the route itself answers 401
  if (!READ_ONLY.includes(u.role)) return next();
  const path = req.originalUrl.split('?')[0];
  if (/^\/api\/notifications\/read$/.test(path) && req.method === 'POST') return next();
  if (u.role === 'viewer') return req.method === 'GET' ? next() : res.status(403).json({ error: 'Your account is read-only.' });
  // insurer: reports of finished cases only
  const ok = req.method === 'GET' && (/^\/api\/cases\/?$/.test(path) || /^\/api\/cases\/[^/]+\/ai-report(\.pdf)?$/.test(path) || /^\/api\/auth\/me$/.test(path) || /^\/api\/notifications\/?$/.test(path));
  return ok ? next() : res.status(403).json({ error: 'Your account can only view finished reports.' });
}

// Cases an insurer may see: finished and signed off (or no sign-off needed).
const insurerCan = c => c.status === 'completed' && ['reviewed', 'not_required', undefined].includes(c.reviewState);

module.exports = { TEAM, isTeam, READ_ONLY, guard, insurerCan };
