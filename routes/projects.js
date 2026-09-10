const express = require('express');
const {
  getProject,
  listProjects,
} = require('../services/projectService');
const { optionalUser } = require('../middleware/auth');

const router = express.Router();

function currentUser(req) {
  return optionalUser(req);
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
