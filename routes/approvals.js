const express = require('express');
const {
  approveApproval,
  prepareApprovalEmail,
  rejectApproval,
  retrieveApproval,
  retrieveApprovals,
} = require('../controller/approval');
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

router.get('/', async (req, res) => {
  try {
    res.json(await retrieveApprovals(currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to retrieve approvals', error);
  }
});

router.get('/:id', async (req, res) => {
  try {
    res.json(await retrieveApproval(req.params.id, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to retrieve approval', error);
  }
});

router.post('/:id/request-email', async (req, res) => {
  try {
    res.json(await prepareApprovalEmail(req.params.id, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to prepare approval email', error);
  }
});

router.post('/:id/approve', async (req, res) => {
  try {
    res.json(await approveApproval(req.params.id, req.body, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to approve request', error);
  }
});

router.post('/:id/reject', async (req, res) => {
  try {
    res.json(await rejectApproval(req.params.id, req.body, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to reject request', error);
  }
});

module.exports = router;
