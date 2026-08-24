const express = require('express');
const {
  getProject,
  listProjects,
} = require('../services/projectService');

const router = express.Router();

function currentUser(req) {
  const rawRole = String(req.get('x-user-role') || 'admin').trim().toLowerCase();
  const role = ['salesperson', 'erp', 'admin'].includes(rawRole) ? rawRole : 'salesperson';
  return {
    role,
    name: String(req.get('x-user-name') || 'Ashish Vibhute').trim() || 'Ashish Vibhute',
  };
}

function handleError(res, message, error) {
  console.error(`${message}:`, error);
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.statusCode ? error.message : message,
  });
}

router.get('/', async (req, res) => {
  try {
    res.json(await listProjects(currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to retrieve projects', error);
  }
});

router.get('/:id', async (req, res) => {
  try {
    res.json(await getProject(req.params.id, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to retrieve project', error);
  }
});

module.exports = router;
