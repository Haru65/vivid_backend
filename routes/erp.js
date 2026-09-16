const express = require('express');
const {
  acceptHandover,
  createHandover,
  getHandover,
  listHandovers,
  rejectHandover,
  submitHandover,
  updateHandover,
} = require('../services/handoverService');
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
  res.status(error.statusCode || (error.code === '23505' ? 409 : 500)).json({
    success: false,
    message: error.statusCode ? error.message : error.code === '23505' ? 'A duplicate handover or project already exists.' : message,
    blockers: error.blockers || undefined,
  });
}

router.get('/handovers', async (req, res) => {
  try {
    res.json(await listHandovers(currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to retrieve handovers', error);
  }
});

router.get('/handovers/:id', async (req, res) => {
  try {
    res.json(await getHandover(req.params.id, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to retrieve handover', error);
  }
});

router.post('/handovers', async (req, res) => {
  try {
    res.status(201).json(await createHandover(req.body, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to create handover', error);
  }
});

router.put('/handovers/:id', async (req, res) => {
  try {
    res.json(await updateHandover(req.params.id, req.body, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to update handover', error);
  }
});

router.post('/handovers/:id/submit', async (req, res) => {
  try {
    res.json(await submitHandover(req.params.id, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to submit handover', error);
  }
});

router.post('/handovers/:id/accept', async (req, res) => {
  try {
    res.json(await acceptHandover(req.params.id, req.body, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to accept handover', error);
  }
});

router.post('/handovers/:id/reject', async (req, res) => {
  try {
    res.json(await rejectHandover(req.params.id, req.body, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to reject handover', error);
  }
});

router.get('/projects', async (req, res) => {
  try {
    res.json(await listProjects(currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to retrieve projects', error);
  }
});

router.get('/projects/:id/workflow', async (req, res) => {
  try {
    res.json(await getWorkflowForProject(req.params.id, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to retrieve project workflow', error);
  }
});

router.put('/projects/:id/workflow/:stageId', async (req, res) => {
  try {
    res.json(await updateProjectWorkflowStage(req.params.id, req.params.stageId, req.body, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to update project workflow stage', error);
  }
});

router.post('/projects/:id/workflow/:stageId/complete', async (req, res) => {
  try {
    res.json(await completeProjectWorkflowStage(req.params.id, req.params.stageId, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to complete project workflow stage', error);
  }
});

router.get('/projects/:id', async (req, res) => {
  try {
    res.json(await getProject(req.params.id, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to retrieve project', error);
  }
});

module.exports = router;
