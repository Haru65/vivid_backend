const pool = require('../config/db_connection');

const DEFAULT_TAX_SETTINGS = {
  gst_rate: 18,
  cgst_rate: 9,
  sgst_rate: 9,
};

const DEFAULT_MASTER_SETTINGS = {
  industry_types: ['Manufacturing', 'Pharma', 'Food', 'Chemical', 'Textile', 'Automotive', 'Infrastructure', 'OEM', 'EPC'],
  lead_sources: ['Website', 'Referral', 'IndiaMART', 'TradeIndia', 'Exhibition', 'Cold Call', 'Existing Customer', 'WhatsApp', 'Email'],
  product_categories: ['PCC Panel', 'MCC Panel', 'APFC Panel', 'VFD Panel', 'AMF Panel', 'HT Panel', 'LT Panel', 'Bus Duct', 'Control Panel'],
  quotation_terms: ['50% advance with PO, balance before dispatch', 'Delivery within 4-6 weeks after technical clearance', 'Warranty 12 months from commissioning or 18 months from dispatch', 'Offer valid for 30 days'],
  departments: ['Sales', 'Design', 'Estimation', 'Purchase', 'Production', 'QA/QC', 'Dispatch', 'Management', 'Accounts'],
  designations: ['Sales Executive', 'Sales Head', 'ERP Manager', 'Design Engineer', 'Purchase Head', 'Production Manager', 'QA Engineer', 'Workspace Admin'],
  approval_authority_rules: ['Salesperson discount up to 3%', 'Payment terms above 30 days require approval', 'Warranty above 12 months requires approval', 'Final price reduction above role limit requires approval'],
  erp_workflow_stage_owners: ['GA Approval - Design', 'Cost Approval - Estimation', 'Work Order Approval - Management', 'Purchase - Purchase', 'Production - Production', 'Quality & Testing - QA/QC', 'Dispatch & Delivery - Dispatch'],
  loss_reasons: ['Price high', 'Competitor selected', 'Project delayed', 'No response', 'Technical mismatch', 'Budget not approved'],
  email_templates: ['Quotation email', 'Approval request email', 'Follow-up email', 'Handover notification'],
};

function appError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function taxNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    throw appError(`${field} must be between 0 and 100.`);
  }
  return Number(number.toFixed(2));
}

function normalizeTaxSettings(data = {}) {
  const cgstRate = data.cgst_rate === undefined ? DEFAULT_TAX_SETTINGS.cgst_rate : taxNumber(data.cgst_rate, 'CGST rate');
  const sgstRate = data.sgst_rate === undefined ? DEFAULT_TAX_SETTINGS.sgst_rate : taxNumber(data.sgst_rate, 'SGST rate');
  const gstRate = data.gst_rate === undefined ? Number((cgstRate + sgstRate).toFixed(2)) : taxNumber(data.gst_rate, 'GST rate');

  return {
    gst_rate: gstRate,
    cgst_rate: cgstRate,
    sgst_rate: sgstRate,
  };
}

function normalizeMasterList(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  const unique = [];
  value.forEach((item) => {
    const text = String(item || '').trim();
    if (!text || text.length > 200) return;
    if (!unique.some((existing) => existing.toLowerCase() === text.toLowerCase())) unique.push(text);
  });
  return unique;
}

function normalizeMasterSettings(data = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_MASTER_SETTINGS).map(([key, fallback]) => [
    key,
    normalizeMasterList(data[key], fallback),
  ]));
}

async function getTaxSettings() {
  const result = await pool.query(
    `SELECT value
     FROM system_settings
     WHERE key = 'tax_rates'`,
  );
  return normalizeTaxSettings({
    ...DEFAULT_TAX_SETTINGS,
    ...(result.rows[0]?.value || {}),
  });
}

async function updateTaxSettings(data, user) {
  if (user?.role !== 'admin') {
    throw appError('Only admins can update tax settings.', 403);
  }

  const settings = normalizeTaxSettings(data);
  const result = await pool.query(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES ('tax_rates', $1::jsonb, CURRENT_TIMESTAMP)
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value,
                   updated_at = CURRENT_TIMESTAMP
     RETURNING value`,
    [JSON.stringify(settings)],
  );

  return normalizeTaxSettings(result.rows[0].value);
}

async function getMasterSettings() {
  const result = await pool.query(
    `SELECT value
     FROM system_settings
     WHERE key = 'masters'`,
  );
  return normalizeMasterSettings({
    ...DEFAULT_MASTER_SETTINGS,
    ...(result.rows[0]?.value || {}),
  });
}

async function updateMasterSettings(data, user) {
  if (user?.role !== 'admin') {
    throw appError('Only admins can update masters.', 403);
  }

  const settings = normalizeMasterSettings(data);
  const result = await pool.query(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES ('masters', $1::jsonb, CURRENT_TIMESTAMP)
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value,
                   updated_at = CURRENT_TIMESTAMP
     RETURNING value`,
    [JSON.stringify(settings)],
  );

  return normalizeMasterSettings(result.rows[0].value);
}

module.exports = {
  DEFAULT_TAX_SETTINGS,
  DEFAULT_MASTER_SETTINGS,
  getTaxSettings,
  getMasterSettings,
  updateTaxSettings,
  updateMasterSettings,
};
