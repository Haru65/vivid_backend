const express = require('express');
const {
  getMasterSettings,
  getTaxSettings,
  updateMasterSettings,
  updateTaxSettings,
} = require('../controller/settings');
const { optionalUser } = require('../middleware/auth');

const router = express.Router();

function currentUser(req) {
  return optionalUser(req);
}

function handleError(res, message, error) {
  console.error(`${message}:`, error);
  res.status(error.statusCode || 500).json({
    error: error.statusCode ? error.message : message,
  });
}

router.get('/tax', async (req, res) => {
  try {
    res.json(await getTaxSettings());
  } catch (error) {
    handleError(res, 'Unable to retrieve tax settings', error);
  }
});

router.put('/tax', async (req, res) => {
  try {
    res.json(await updateTaxSettings(req.body, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to update tax settings', error);
  }
});

router.get('/masters', async (req, res) => {
  try {
    res.json(await getMasterSettings());
  } catch (error) {
    handleError(res, 'Unable to retrieve masters', error);
  }
});

router.put('/masters', async (req, res) => {
  try {
    res.json(await updateMasterSettings(req.body, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to update masters', error);
  }
});

module.exports = router;
