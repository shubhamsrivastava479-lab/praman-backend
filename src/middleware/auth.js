const { verifyToken } = require('../services/auth');

function requireAuth(req, res, next) {
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired, please log in again' });
  }
}

module.exports = { requireAuth };
