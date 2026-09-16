const express = require('express');
const {
  getWorkflowForProject,
  getProject,
  listProjects,
} = require('../services/projectService');
const {
  completeProjectWorkflowStage,
  updateProjectWorkflowStage,
} = require('../services/projectWorkflowService');
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

router.get('/:id/workflow', async (req, res) => {
  try {
    res.json(await getWorkflowForProject(req.params.id, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to retrieve project workflow', error);
  }
});

router.put('/:id/workflow/:stageId', async (req, res) => {
  try {
    res.json(await updateProjectWorkflowStage(req.params.id, req.params.stageId, req.body, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to update project workflow stage', error);
  }
});

router.post('/:id/workflow/:stageId/complete', async (req, res) => {
  try {
    res.json(await completeProjectWorkflowStage(req.params.id, req.params.stageId, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to complete project workflow stage', error);
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
