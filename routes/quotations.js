const express = require('express');
const {
  retrieveQuotations,
  createQuotation,
  createQuotationRevision,
  updateQuotation,
  deleteQuotation,
  sendQuotation,
} = require('../controller/quotations');

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
  res.status(error.statusCode || (error.code === '23505' ? 409 : 500)).json({
    error: error.statusCode ? error.message : error.code === '23505' ? 'Quotation number already exists' : message,
  });
}

router.get('/', async (req, res) => {
  try {
    res.json(await retrieveQuotations());
  } catch (error) {
    handleError(res, 'Unable to retrieve quotations', error);
  }
});

router.post('/create-quotation', async (req, res) => {
  try {
    res.status(201).json(await createQuotation(req.body, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to create quotation', error);
  }
});

router.post('/:id/revisions', async (req, res) => {
  try {
    res.status(201).json(await createQuotationRevision(req.params.id, req.body, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to create quotation revision', error);
  }
});

router.put('/update-quotation/:id', async (req, res) => {
  try {
    const quotation = await updateQuotation(req.params.id, req.body, currentUser(req));
    if (!quotation) return res.status(404).json({ error: 'Draft quotation not found' });
    res.json(quotation);
  } catch (error) {
    handleError(res, 'Unable to update quotation', error);
  }
});

router.delete('/delete-quotation/:id', async (req, res) => {
  try {
    const quotation = await deleteQuotation(req.params.id, currentUser(req));
    if (!quotation) return res.status(404).json({ error: 'Draft quotation not found' });
    res.json({ id: quotation.id, message: 'Quotation deleted successfully' });
  } catch (error) {
    handleError(res, 'Unable to delete quotation', error);
  }
});

router.post('/send-quotation/:id', async (req, res) => {
  try {
    res.json(await sendQuotation(req.params.id, currentUser(req)));
  } catch (error) {
    handleError(res, 'Unable to send quotation', error);
  }
});

module.exports = router;
