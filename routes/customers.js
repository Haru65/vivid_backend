const express = require('express');
const {
  retrieveCustomers,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  renewAmc,
  convertLeadToCustomer,
} = require('../controller/customers');
const { optionalUser } = require('../middleware/auth');

const router = express.Router();

function currentUser(req) {
  return optionalUser(req);
}

function handleError(res, message, error) {
  console.error(`${message}:`, error);
  res.status(error.statusCode || (error.code === '23505' ? 409 : 500)).json({
    error: error.statusCode ? error.message : error.code === '23505' ? 'Customer already exists for this lead' : message,
  });
}

router.get('/', async (req, res) => {
  try {
    res.json(await retrieveCustomers());
  } catch (error) {
    handleError(res, 'Unable to retrieve customers', error);
  }
});

router.post('/create-customer', async (req, res) => {
  try {
    res.status(201).json(await createCustomer(req.body));
  } catch (error) {
    handleError(res, 'Unable to create customer', error);
  }
});

router.put('/update-customer/:id', async (req, res) => {
  try {
    const customer = await updateCustomer(req.params.id, req.body);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    res.json(customer);
  } catch (error) {
    handleError(res, 'Unable to update customer', error);
  }
});

router.delete('/delete-customer/:id', async (req, res) => {
  try {
    const customer = await deleteCustomer(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    res.json({ id: customer.id, message: 'Customer deleted successfully' });
  } catch (error) {
    handleError(res, 'Unable to delete customer', error);
  }
});

router.post('/renew-amc/:id', async (req, res) => {
  try {
    const customer = await renewAmc(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    res.json(customer);
  } catch (error) {
    handleError(res, 'Unable to renew AMC', error);
  }
});

router.post('/from-lead/:leadId', async (req, res) => {
  try {
    const result = await convertLeadToCustomer(req.params.leadId, currentUser(req));
    res.status(result.created ? 201 : 200).json({
      ...result.customer,
      created: result.created,
      message: result.created ? 'Customer created from lead' : 'Lead already has a customer account',
    });
  } catch (error) {
    handleError(res, 'Unable to convert lead to customer', error);
  }
});

module.exports = router;
