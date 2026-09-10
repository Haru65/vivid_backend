const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'vivid-dev-secret-change-me';

function authError(message = 'Authentication required.') {
  const error = new Error(message);
  error.statusCode = 401;
  return error;
}

function signUserToken(user) {
  return jwt.sign(
    {
      sub: String(user.id),
      name: user.name,
      email: user.email,
      role: user.role,
    },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' },
  );
}

function authenticateToken(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: payload.sub,
      name: payload.name,
      email: payload.email,
      role: payload.role,
    };
    return next();
  } catch {
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
}

function optionalUser(req) {
  if (req.user) return req.user;
  const role = String(req.get('x-user-role') || 'salesperson').trim().toLowerCase();
  return {
    role: ['admin', 'salesperson', 'erp'].includes(role) ? role : 'salesperson',
    name: String(req.get('x-user-name') || 'Workspace user').trim() || 'Workspace user',
  };
}

module.exports = {
  authError,
  authenticateToken,
  optionalUser,
  signUserToken,
};
