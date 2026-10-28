const express = require('express');
const { requireRoles } = require('../middleware/auth');
const { listActivityLogs } = require('../services/activityLogService');

const router = express.Router();

router.use(requireRoles('admin', 'sales_head', 'estimation_head'));

router.get('/', async (req, res) => {
  try {
    res.json(await listActivityLogs(req.query, req.user));
  } catch (error) {
    console.error('Unable to retrieve activity logs:', error);
    res.status(500).json({ error: 'Unable to retrieve activity logs' });
  }
});

module.exports = router;
