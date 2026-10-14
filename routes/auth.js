const express = require('express');
const {
  authenticateUser,
  createUser,
  deactivateUser,
  deleteUser,
  getUserById,
  listApprovalUsers,
  listUsers,
  normalizeUser,
  updateUser,
} = require('../controller/userManagement');
const { authenticateToken, requireRoles, signUserToken } = require('../middleware/auth');

const router = express.Router();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const loginFailures = new Map();

function loginKey(req) {
  return `${req.ip || req.socket?.remoteAddress || 'unknown'}:${String(req.body?.email || '').trim().toLowerCase()}`;
}

function activeFailureRecord(key) {
  const record = loginFailures.get(key);
  if (!record) return null;
  if (Date.now() - record.startedAt >= LOGIN_WINDOW_MS) {
    loginFailures.delete(key);
    return null;
  }
  return record;
}

function pruneLoginFailures() {
  if (loginFailures.size < 1000) return;
  const now = Date.now();
  for (const [key, record] of loginFailures) {
    if (now - record.startedAt >= LOGIN_WINDOW_MS) loginFailures.delete(key);
  }
  while (loginFailures.size > 5000) {
    loginFailures.delete(loginFailures.keys().next().value);
  }
}

function recordLoginFailure(key) {
  const record = activeFailureRecord(key) || { count: 0, startedAt: Date.now() };
  record.count += 1;
  loginFailures.set(key, record);
}

function handleError(res, message, error) {
  console.error(`${message}:`, error);
  res.status(error.statusCode || (['23503', '23505'].includes(error.code) ? 409 : 500)).json({
    error: error.statusCode
      ? error.message
      : error.code === '23505'
        ? 'A user with this email or employee code already exists.'
        : error.code === '23503'
          ? 'This user is linked to workspace records and cannot be permanently deleted. Deactivate the account instead.'
        : message,
  });
}

router.post('/login', async (req, res) => {
  pruneLoginFailures();
  const key = loginKey(req);
  const record = activeFailureRecord(key);
  if (record?.count >= MAX_LOGIN_FAILURES) {
    const retryAfterSeconds = Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (Date.now() - record.startedAt)) / 1000));
    res.set('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many sign-in attempts. Please try again later.' });
  }

  try {
    const user = await authenticateUser(req.body.email, req.body.password);
    loginFailures.delete(key);
    res.json({ token: signUserToken(user), user });
  } catch (error) {
    if (error.statusCode === 401) recordLoginFailure(key);
    handleError(res, 'Unable to sign in', error);
  }
});

router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = normalizeUser(await getUserById(req.user.id));
    if (!user.is_active) return res.status(401).json({ error: 'User account is inactive.' });
    res.json(user);
  } catch (error) {
    handleError(res, 'Unable to load current user', error);
  }
});

router.get('/users', authenticateToken, async (req, res) => {
  try {
    res.json(await listUsers(req.user));
  } catch (error) {
    handleError(res, 'Unable to retrieve users', error);
  }
});

router.get(
  '/approval-users',
  authenticateToken,
  requireRoles('admin', 'sales_head', 'sales_engineer', 'salesperson', 'estimation_head', 'estimation_engineer'),
  async (req, res) => {
  try {
    res.json(await listApprovalUsers());
  } catch (error) {
    handleError(res, 'Unable to retrieve approval users', error);
  }
  },
);

router.post('/users', authenticateToken, async (req, res) => {
  try {
    res.status(201).json(await createUser(req.body, req.user));
  } catch (error) {
    handleError(res, 'Unable to create user', error);
  }
});

router.put('/users/:id', authenticateToken, async (req, res) => {
  try {
    res.json(await updateUser(req.params.id, req.body, req.user));
  } catch (error) {
    handleError(res, 'Unable to update user', error);
  }
});

router.delete('/users/:id', authenticateToken, async (req, res) => {
  try {
    res.json(await deactivateUser(req.params.id, req.user));
  } catch (error) {
    handleError(res, 'Unable to deactivate user', error);
  }
});

router.delete('/users/:id/permanent', authenticateToken, async (req, res) => {
  try {
    res.json(await deleteUser(req.params.id, req.user));
  } catch (error) {
    handleError(res, 'Unable to delete user', error);
  }
});

module.exports = router;
