
const express = require('express');
const {
  approvePoSheet,
  approveRequest,
  assignRequest,
  createOrUpdateRequestQuotation,
  discardRequest,
  generatePoSheetPdf,
  getPoSheet,
  getRequest,
  listEstimationRequests,
  markClientApproved,
  requestRevision,
  requestSalesRevision,
  savePoEstimation,
  submitForReview,
  submitLeadToEstimation,
  upsertPoSheet,
} = require('../services/estimationService');
const { optionalUser, requireRoles } = require('../middleware/auth');

const router = express.Router();
router.use(requireRoles('admin', 'sales_head', 'sales_engineer', 'salesperson', 'estimation_head', 'estimation_engineer'));


function currentUser(req) {
  return optionalUser(req);
}

function handleError(res, message, error) {
  console.error(`${message}:`, error);
  res.status(error.statusCode || (error.code === '23505' ? 409 : 500)).json({
    error: error.statusCode ? error.message : error.code === '23505' ? 'This lead already has an active estimation request.' : message,
  });
}

router.get('/', async (req, res) => {
  try {
    res.json(await listEstimationRequests(currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to retrieve estimation requests', error);
  }
});

router.get('/:id', async (req, res) => {
  try {
    res.json(await getRequest(req.params.id, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to retrieve estimation request', error);
  }
});

router.post('/from-lead/:leadId', async (req, res) => {
  try {
    res.status(201).json(await submitLeadToEstimation(req.params.leadId, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to submit lead to estimation', error);
  }
});


router.post('/:id/sales-revision', async (req, res) => {
  try { res.json(await requestSalesRevision(req.params.id, req.body, currentUser(req))); }
  catch (error) { handleError(res, 'Unable to send quotation back for revision', error); }
});

router.post('/:id/client-approved', async (req, res) => {
  try { res.json(await markClientApproved(req.params.id, req.body, currentUser(req))); }
  catch (error) { handleError(res, 'Unable to mark client approval', error); }
});

router.post('/:id/discard', async (req, res) => {
  try { res.json(await discardRequest(req.params.id, req.body, currentUser(req))); }
  catch (error) { handleError(res, 'Unable to discard estimation request', error); }
});

router.post('/:id/po/sales', async (req, res) => {
  try { res.json(await upsertPoSheet(req.params.id, currentUser(req), req.body)); }
  catch (error) { handleError(res, 'Unable to submit PO sales sheet', error); }
});

router.post('/:id/po/estimation', async (req, res) => {
  try { res.json(await savePoEstimation(req.params.id, req.body, currentUser(req))); }
  catch (error) { handleError(res, 'Unable to save PO estimation section', error); }
});

router.post('/:id/po/approve', async (req, res) => {
  try { res.json(await approvePoSheet(req.params.id, currentUser(req))); }
  catch (error) { handleError(res, 'Unable to approve PO sheet', error); }
});

router.get('/:id/po', async (req, res) => {
  try { res.json(await getPoSheet(req.params.id, currentUser(req))); }
  catch (error) { handleError(res, 'Unable to retrieve PO sheet', error); }
});

router.get('/:id/po/pdf', async (req, res) => {
  try {
    const { filename, pdf } = await generatePoSheetPdf(req.params.id, currentUser(req));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-PO-Template-Version', 'neosol-v1');
    res.send(Buffer.from(pdf));
  } catch (error) { handleError(res, 'Unable to generate PO sheet PDF', error); }
});

router.post('/:id/assign', async (req, res) => {
  try {
    res.json(await assignRequest(req.params.id, req.body, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to assign estimation request', error);
  }
});

router.post('/:id/quotation', async (req, res) => {
  try {
    res.json(await createOrUpdateRequestQuotation(req.params.id, req.body, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to save estimation quotation', error);
  }
});

router.post('/:id/submit-review', async (req, res) => {
  try {
    res.json(await submitForReview(req.params.id, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to submit estimation quotation for review', error);
  }
});

router.post('/:id/request-revision', async (req, res) => {
  try {
    res.json(await requestRevision(req.params.id, req.body, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to request estimation revision', error);
  }
});

router.post('/:id/approve', async (req, res) => {
  try {
    res.json(await approveRequest(req.params.id, req.body, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to approve estimation request', error);
  }
});

module.exports = router;
