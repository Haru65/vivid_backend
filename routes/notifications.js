
const express = require('express');
const {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} = require('../services/notificationService');
const { optionalUser } = require('../middleware/auth');

const router = express.Router();

function currentUser(req) {
  return optionalUser(req);
}

function handleError(res, message, error) {
  console.error(`${message}:`, error);
  res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : message });
}

router.get('/', async (req, res) => {
  try {
    res.json(await listNotifications(currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to retrieve notifications', error);
  }
});

router.post('/read-all', async (req, res) => {
  try {
    res.json(await markAllNotificationsRead(currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to mark notifications read', error);
  }
});

router.post('/:id/read', async (req, res) => {
  try {
    res.json(await markNotificationRead(req.params.id, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to mark notification read', error);
  }
});

module.exports = router;
