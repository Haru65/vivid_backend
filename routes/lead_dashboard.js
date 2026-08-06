const express = require('express');
const {
  retrieveLeads,
  retrieveLeadActivities,
  createLeadActivity,
  createLead,
  updateLead,
  deleteLead,
  acceptProposal,
} = require('../controller/leads');

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

function handleActivityError(res, message, error) {
  console.error(`${message}:`, error);
  res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : message });
}

router.get('/', async (req, res) => {
  try {
    res.json(await retrieveLeads());
  } catch (error) {
    console.error('Error retrieving leads:', error);
    res.status(500).json({ error: 'Unable to retrieve leads' });
  }
});

router.get('/:leadId/activities', async (req, res) => {
  try {
    res.json(await retrieveLeadActivities(req.params.leadId));
  } catch (error) {
    handleActivityError(res, 'Unable to retrieve lead activity', error);
  }
});

router.post('/:leadId/activities', async (req, res) => {
  try {
    res.status(201).json(await createLeadActivity(req.params.leadId, req.body, currentUser(req)));
  } catch (error) {
    handleActivityError(res, 'Unable to create lead activity', error);
  }
});

router.post('/create-lead', async (req, res) => {
  try {
    res.status(201).json(await createLead(req.body));
  } catch (error) {
    console.error('Error creating lead:', error);
    res.status(500).json({ error: 'Unable to create lead' });
  }
});

router.put('/update-lead/:id', async (req, res) => {
  try {
    const lead = await updateLead(req.params.id, req.body);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(lead);
  } catch (error) {
    console.error('Error updating lead:', error);
    res.status(500).json({ error: 'Unable to update lead' });
  }
});

router.delete('/delete-lead/:id', async (req, res) => {
  try {
    const lead = await deleteLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json({ id: lead.id, message: 'Lead deleted successfully' });
  } catch (error) {
    console.error('Error deleting lead:', error);
    res.status(500).json({ error: 'Unable to delete lead' });
  }
});

router.post('/accept-proposal/:id', async (req, res) => {
  try {
    const lead = await acceptProposal(req.params.id, req.body.quotation);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json({
      ...lead,
      quotation_delivery: 'sent',
      message: 'Proposal accepted and quotation marked as sent',
    });
  } catch (error) {
    console.error('Error accepting proposal:', error);
    res.status(500).json({ error: 'Unable to accept proposal' });
  }
});

module.exports = router;
