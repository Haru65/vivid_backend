const jwt = require('jsonwebtoken');
const pool = require('../config/db_connection');

const VALID_ROLES = new Set(['admin', 'salesperson', 'sales_head', 'sales_engineer', 'estimation_head', 'estimation_engineer', 'erp']);

function jwtSecret() {
  return process.env.JWT_SECRET || 'vivid-dev-secret-change-me';
}

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
    jwtSecret(),
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' },
  );
}

async function authenticateToken(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  try {
    const payload = jwt.verify(token, jwtSecret());
    const result = await pool.query(
      `SELECT id, first_name, last_name, email, role, is_active
       FROM users
       WHERE id = $1`,
      [payload.sub],
    );
    const user = result.rows[0];
    if (!user || !user.is_active || !VALID_ROLES.has(user.role)) {
      return res.status(401).json({ error: 'User account is inactive or no longer available.' });
    }
    req.user = {
      id: String(user.id),
      name: [user.first_name, user.last_name].filter(Boolean).join(' '),
      email: user.email,
      role: user.role,
    };
    return next();
  } catch (error) {
    if (error.name !== 'JsonWebTokenError' && error.name !== 'TokenExpiredError') {
      console.error('Unable to validate authenticated user:', error);
    }
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
}

function optionalUser(req) {
  if (req.user) return req.user;
  throw authError();
}

function requireRoles(...roles) {
  const allowed = new Set(roles);
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    if (!allowed.has(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to access this workspace.' });
    }
    return next();
  };
}




module.exports = {
  authError,
  authenticateToken,
  optionalUser,
  requireRoles,
  signUserToken,
};
