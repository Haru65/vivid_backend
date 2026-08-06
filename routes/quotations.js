const express = require('express');
const {
  retrieveQuotations,
  createQuotation,
  updateQuotation,
  deleteQuotation,
  sendQuotation,
} = require('../controller/quotations');

const router = express.Router();

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
    res.status(201).json(await createQuotation(req.body));
  } catch (error) {
    handleError(res, 'Unable to create quotation', error);
  }
});

router.put('/update-quotation/:id', async (req, res) => {
  try {
    const quotation = await updateQuotation(req.params.id, req.body);
    if (!quotation) return res.status(404).json({ error: 'Draft quotation not found' });
    res.json(quotation);
  } catch (error) {
    handleError(res, 'Unable to update quotation', error);
  }
});

router.delete('/delete-quotation/:id', async (req, res) => {
  try {
    const quotation = await deleteQuotation(req.params.id);
    if (!quotation) return res.status(404).json({ error: 'Draft quotation not found' });
    res.json({ id: quotation.id, message: 'Quotation deleted successfully' });
  } catch (error) {
    handleError(res, 'Unable to delete quotation', error);
  }
});

router.post('/send-quotation/:id', async (req, res) => {
  try {
    res.json(await sendQuotation(req.params.id));
  } catch (error) {
    handleError(res, 'Unable to send quotation', error);
  }
});

module.exports = router;
