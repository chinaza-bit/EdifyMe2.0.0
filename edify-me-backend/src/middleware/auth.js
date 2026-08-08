const jwt = require('jsonwebtoken');

// Protects routes: expects header "Authorization: Bearer <token>".
// On success attaches req.userId; on failure returns 401.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const headerToken = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = req.cookies?.token || headerToken; // cookie first (browser), header as a fallback (e.g. Thunder Client)
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }
}

module.exports = { requireAuth };
