const express = require('express');
const { optionalUser, requireRoles } = require('../middleware/auth');
const { retrieveTasks, createTask, updateTask, updateTaskStatus, updateTaskReview, rescheduleTask, completeTask, deleteTask } = require('../controller/tasks');

const router = express.Router();
router.use(requireRoles('admin', 'sales_head', 'sales_engineer', 'salesperson', 'presales'));

function handleError(res, message, error) {
  console.error(`${message}:`, error);
  res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : message });
}

router.get('/', async (req, res) => {
  try {
    res.json(await retrieveTasks(optionalUser(req)));
  } catch (error) {
    handleError(res, 'Unable to retrieve tasks', error);
  }
});

router.post('/', async (req, res) => {
  try {
    res.status(201).json(await createTask(req.body, optionalUser(req)));
  } catch (error) {
    handleError(res, 'Unable to create task', error);
  }
});

router.put('/:id', async (req, res) => {
  try {
    const task = await updateTask(req.params.id, req.body, optionalUser(req));
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    res.json(task);
  } catch (error) {
    handleError(res, 'Unable to update task', error);
  }
});

router.patch('/:id/status', async (req, res) => {
  try {
    const task = await updateTaskStatus(req.params.id, req.body.status, optionalUser(req));
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    res.json(task);
  } catch (error) {
    handleError(res, 'Unable to update task status', error);
  }
});

router.patch('/:id/review', async (req, res) => {
  try {
    const task = await updateTaskReview(req.params.id, req.body, optionalUser(req));
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    res.json(task);
  } catch (error) {
    handleError(res, 'Unable to update task review', error);
  }
});

router.patch('/:id/reschedule', async (req, res) => {
  try {
    const task = await rescheduleTask(req.params.id, req.body, optionalUser(req));
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    res.json(task);
  } catch (error) {
    handleError(res, 'Unable to reschedule task', error);
  }
});

router.post('/:id/complete', async (req, res) => {
  try {
    const task = await completeTask(req.params.id, req.body, optionalUser(req));
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    res.json(task);
  } catch (error) {
    handleError(res, 'Unable to complete task', error);
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const task = await deleteTask(req.params.id, optionalUser(req));
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    res.json({ id: task.id, message: 'Task deleted successfully' });
  } catch (error) {
    handleError(res, 'Unable to delete task', error);
  }
});

module.exports = router;
