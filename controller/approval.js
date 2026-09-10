const {
  approveRequest,
  getApproval,
  listApprovals,
  rejectRequest,
  requestApprovalEmail,
} = require('../services/approvalService');

async function retrieveApprovals(user) {
  return listApprovals(user);
}

async function retrieveApproval(id, user) {
  return getApproval(id, user);
}

async function prepareApprovalEmail(id, user) {
  return requestApprovalEmail(id, user);
}

async function approveApproval(id, data, user) {
  return approveRequest(id, data, user);
}

async function rejectApproval(id, data, user) {
  return rejectRequest(id, data, user);
}

module.exports = {
  approveApproval,
  prepareApprovalEmail,
  rejectApproval,
  retrieveApproval,
  retrieveApprovals,
};
