const express = require('express');
const {
  authenticateUser,
  createUser,
  deactivateUser,
  getUserById,
  listApprovalUsers,
  listUsers,
  normalizeUser,
  updateUser,
} = require('../controller/userManagement');
const { authenticateToken, signUserToken } = require('../middleware/auth');

const router = express.Router();

function handleError(res, message, error) {
  console.error(`${message}:`, error);
  res.status(error.statusCode || (error.code === '23505' ? 409 : 500)).json({
    error: error.statusCode
      ? error.message
      : error.code === '23505'
        ? 'A user with this email or employee code already exists.'
        : message,
  });
}

router.post('/login', async (req, res) => {
  try {
    const user = await authenticateUser(req.body.email, req.body.password);
    res.json({ token: signUserToken(user), user });
  } catch (error) {
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

router.get('/approval-users', authenticateToken, async (req, res) => {
  try {
    res.json(await listApprovalUsers());
  } catch (error) {
    handleError(res, 'Unable to retrieve approval users', error);
  }
});

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

module.exports = router;
