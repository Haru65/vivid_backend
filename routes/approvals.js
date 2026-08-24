const express = require('express');
const {
  approveRequest,
  getApproval,
  listApprovals,
  rejectRequest,
  requestApprovalEmail,
} = require('../services/approvalService');

const router = express.Router();

function currentUser(req) {
  const role = String(req.get('x-user-role') || 'admin').toLowerCase() === 'salesperson'
    ? 'salesperson'
    : 'admin';
  return {
    role,
    name: String(req.get('x-user-name') || 'Ashish Vibhute').trim() || 'Ashish Vibhute',
  };
}

function handleError(res, message, error) {
  console.error(`${message}:`, error);
  res.status(error.statusCode || 500).json({
    error: error.statusCode ? error.message : message,
  });
}

router.get('/', async (req, res) => {
  try {
    res.json(await listApprovals(currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to retrieve approvals', error);
  }
});

router.get('/:id', async (req, res) => {
  try {
    res.json(await getApproval(req.params.id, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to retrieve approval', error);
  }
});

router.post('/:id/request-email', async (req, res) => {
  try {
    res.json(await requestApprovalEmail(req.params.id, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to prepare approval email', error);
  }
});

router.post('/:id/approve', async (req, res) => {
  try {
    res.json(await approveRequest(req.params.id, req.body, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to approve request', error);
  }
});

router.post('/:id/reject', async (req, res) => {
  try {
    res.json(await rejectRequest(req.params.id, req.body, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to reject request', error);
  }
});

module.exports = router;
