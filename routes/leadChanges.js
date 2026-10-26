const express = require('express');
const { requireRoles } = require('../middleware/auth');
const { listLeadChanges, reviewLeadChange } = require('../services/leadChangeService');

const router = express.Router();
router.use(requireRoles('admin', 'sales_head', 'estimation_head', 'sales_engineer', 'estimation_engineer', 'presales'));

function handleError(res, error) {
  console.error('Lead change request failed:', error);
  res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to process lead change request.' });
}

router.get('/', async (req, res) => {
  try { res.json(await listLeadChanges(req.user)); }
  catch (error) { handleError(res, error); }
});

router.post('/:id/:decision', requireRoles('sales_head', 'estimation_head'), async (req, res) => {
  try { res.json(await reviewLeadChange(req.params.id, req.params.decision, req.body.comments, req.user)); }
  catch (error) { handleError(res, error); }
});

module.exports = router;
