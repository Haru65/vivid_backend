const express = require('express');
const {
  retrieveMeetings,
  createMeeting,
  updateMeeting,
  deleteMeeting,
} = require('../controller/meetings');
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
    res.json(await retrieveMeetings({ start: req.query.start, end: req.query.end }, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to retrieve calendar meetings', error);
  }
});

router.post('/', async (req, res) => {
  try {
    res.status(201).json(await createMeeting(req.body, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to create calendar meeting', error);
  }
});

router.put('/:id', async (req, res) => {
  try {
    const meeting = await updateMeeting(req.params.id, req.body, currentUser(req));
    if (!meeting) return res.status(404).json({ error: 'Meeting not found or not visible to this user.' });
    res.json(meeting);
  } catch (error) {
    handleError(res, 'Unable to update calendar meeting', error);
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const meeting = await deleteMeeting(req.params.id, currentUser(req));
    if (!meeting) return res.status(404).json({ error: 'Meeting not found or not visible to this user.' });
    res.json({ id: meeting.id, message: 'Meeting deleted successfully' });
  } catch (error) {
    handleError(res, 'Unable to delete calendar meeting', error);
  }
});

module.exports = router;
