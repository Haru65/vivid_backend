const express = require('express');
const {
  retrieveLeads,
  retrieveLeadActivities,
  createLeadActivity,
  retrieveLeadFollowups,
  createLeadFollowup,
  updateLeadFollowup,
  completeLeadFollowup,
  cancelLeadFollowup,
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
    res.json(await retrieveLeadActivities(req.params.leadId, currentUser(req)));
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

router.get('/:leadId/followups', async (req, res) => {
  try {
    res.json(await retrieveLeadFollowups(req.params.leadId, currentUser(req)));
  } catch (error) {
    handleActivityError(res, 'Unable to retrieve lead follow-ups', error);
  }
});

router.post('/:leadId/followups', async (req, res) => {
  try {
    res.status(201).json(await createLeadFollowup(req.params.leadId, req.body, currentUser(req)));
  } catch (error) {
    handleActivityError(res, 'Unable to create lead follow-up', error);
  }
});

router.put('/:leadId/followups/:followupId', async (req, res) => {
  try {
    const followup = await updateLeadFollowup(req.params.leadId, req.params.followupId, req.body, currentUser(req));
    if (!followup) return res.status(404).json({ error: 'Follow-up not found' });
    res.json(followup);
  } catch (error) {
    handleActivityError(res, 'Unable to update lead follow-up', error);
  }
});

router.post('/:leadId/followups/:followupId/complete', async (req, res) => {
  try {
    const followup = await completeLeadFollowup(req.params.leadId, req.params.followupId, currentUser(req));
    if (!followup) return res.status(404).json({ error: 'Follow-up not found' });
    res.json(followup);
  } catch (error) {
    handleActivityError(res, 'Unable to complete lead follow-up', error);
  }
});

router.post('/:leadId/followups/:followupId/cancel', async (req, res) => {
  try {
    const followup = await cancelLeadFollowup(req.params.leadId, req.params.followupId, currentUser(req));
    if (!followup) return res.status(404).json({ error: 'Follow-up not found' });
    res.json(followup);
  } catch (error) {
    handleActivityError(res, 'Unable to cancel lead follow-up', error);
  }
});

router.post('/create-lead', async (req, res) => {
  try {
    res.status(201).json(await createLead(req.body, currentUser(req)));
  } catch (error) {
    handleActivityError(res, 'Unable to create lead', error);
  }
});

router.put('/update-lead/:id', async (req, res) => {
  try {
    const lead = await updateLead(req.params.id, req.body, currentUser(req));
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(lead);
  } catch (error) {
    handleActivityError(res, 'Unable to update lead', error);
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
    const lead = await acceptProposal(req.params.id, req.body.quotation, currentUser(req));
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json({
      ...lead,
      quotation_delivery: 'sent',
      message: 'Proposal accepted and quotation marked as sent',
    });
  } catch (error) {
    handleActivityError(res, 'Unable to accept proposal', error);
  }
});

module.exports = router;
