const pool = require('../config/db_connection');

const DEFAULT_TAX_SETTINGS = {
  gst_rate: 18,
  cgst_rate: 9,
  sgst_rate: 9,
};

const DEAL_PRODUCTS = [
  'HT',
  'LT – 61439',
  '60439',
  'Artuk',
  'Siemens Siepan – 8PU',
  'Enersys – L&T',
  'TI',
  'Trading',
  'Busduct',
  'SKID',
  'PDU',
];

const DASHBOARD_ROLES = ['admin', 'sales_head', 'salesperson', 'sales_engineer', 'presales', 'estimation_head', 'estimation_engineer', 'erp'];
const DASHBOARD_WIDGETS = ['executive_metrics', 'sales_funnel', 'monthly_trend', 'project_health', 'engineer_performance', 'lead_reminders', 'pipeline_health'];
const DEFAULT_DASHBOARD_WIDGETS = {
  admin: ['executive_metrics', 'sales_funnel', 'monthly_trend', 'lead_reminders', 'project_health', 'engineer_performance'],
  sales_head: ['executive_metrics', 'sales_funnel', 'monthly_trend', 'lead_reminders', 'engineer_performance'],
  salesperson: ['executive_metrics', 'lead_reminders', 'pipeline_health'],
  sales_engineer: ['executive_metrics', 'lead_reminders', 'pipeline_health'],
  presales: ['executive_metrics', 'lead_reminders', 'pipeline_health', 'engineer_performance'],
  estimation_head: ['engineer_performance'],
  estimation_engineer: ['engineer_performance'],
  erp: ['executive_metrics', 'project_health'],
};

const DEFAULT_MASTER_SETTINGS = {
  industry_types: ['Manufacturing', 'Pharma', 'Food', 'Chemical', 'Textile', 'Automotive', 'Infrastructure', 'OEM', 'EPC'],
  lead_sources: ['Website', 'Referral', 'IndiaMART', 'TradeIndia', 'Exhibition', 'Cold Call', 'Existing Customer', 'WhatsApp', 'Email'],
  product_categories: ['PCC Panel', 'MCC Panel', 'APFC Panel', 'VFD Panel', 'AMF Panel', 'HT Panel', 'LT Panel', 'Bus Duct', 'Control Panel', ...DEAL_PRODUCTS],
  quotation_terms: ['50% advance with PO, balance before dispatch', 'Delivery within 4-6 weeks after technical clearance', 'Warranty 12 months from commissioning or 18 months from dispatch', 'Offer valid for 30 days'],
  departments: ['Sales', 'Design', 'Estimation', 'Purchase', 'Production', 'QA/QC', 'Dispatch', 'Management', 'Accounts'],
  designations: ['Sales Executive', 'Sales Head', 'ERP Manager', 'Design Engineer', 'Purchase Head', 'Production Manager', 'QA Engineer', 'Workspace Admin'],
  approval_authority_rules: ['Salesperson discount up to 3%', 'Payment terms above 30 days require approval', 'Warranty above 12 months requires approval', 'Final price reduction above role limit requires approval'],
  erp_workflow_stage_owners: ['GA Approval - Design', 'Cost Approval - Estimation', 'Work Order Approval - Management', 'Purchase - Purchase', 'Production - Production', 'Quality & Testing - QA/QC', 'Dispatch & Delivery - Dispatch'],
  loss_reasons: ['Price high', 'Competitor selected', 'Project delayed', 'No response', 'Technical mismatch', 'Budget not approved'],
  email_templates: ['Quotation email', 'Approval request email', 'Follow-up email', 'Handover notification'],
  dashboard_widgets: DEFAULT_DASHBOARD_WIDGETS,
  quotation_numbering: { prefix: 'QT', separator: '-', padding: 5 },
  quotation_price_points: [],
  technical_note_fields: [
    { code: 'IP_RATING', section: 'General', label: 'Degree of protection', pdf_label: 'IP Rating / Degree of Protection', input_type: 'select', options: ['IP42', 'IP52', 'IP54', 'IP55', 'IP65'], default_value: 'IP54', required: true, active: true, display_order: 10 },
    { code: 'INSTALLATION', section: 'General', label: 'Installation', pdf_label: 'Installation', input_type: 'select', options: ['Indoor', 'Outdoor'], default_value: 'Indoor', required: true, active: true, display_order: 20 },
    { code: 'PAINT', section: 'Construction', label: 'Paint shade', pdf_label: 'Paint Shade', input_type: 'text', options: [], default_value: 'RAL7032', required: true, active: true, display_order: 30 },
    { code: 'BUSBAR', section: 'Busbar', label: 'Busbar specification', pdf_label: 'Busbar', input_type: 'select', options: ['Aluminum', 'Copper'], default_value: '', required: true, active: true, display_order: 40 },
    { code: 'METER', section: 'Metering and protection', label: 'Meter specification', pdf_label: 'Meter', input_type: 'text', options: [], default_value: '', required: true, active: true, display_order: 50 },
    { code: 'RELAY', section: 'Metering and protection', label: 'Relay specification', pdf_label: 'Relay', input_type: 'text', options: [], default_value: '', required: true, active: true, display_order: 60 },
  ],
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

function cleanText(value, maxLength = 200) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizePricePoints(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  const seen = new Set();
  return value.slice(0, 500).map((item, index) => {
    if (!item || typeof item !== 'object') return null;
    const code = cleanText(item.code, 50).toUpperCase();
    const description = cleanText(item.description, 500);
    if (!code || !description || seen.has(code)) return null;
    seen.add(code);
    const rate = Number(item.default_rate || 0);
    return {
      code,
      description,
      category: cleanText(item.category, 100),
      unit: cleanText(item.unit, 30) || 'No.',
      default_rate: Number.isFinite(rate) && rate >= 0 ? Number(rate.toFixed(2)) : 0,
      active: item.active !== false,
      display_order: Number.isInteger(Number(item.display_order)) ? Number(item.display_order) : (index + 1) * 10,
    };
  }).filter(Boolean).sort((left, right) => left.display_order - right.display_order);
}

function normalizeTechnicalNoteFields(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  const seen = new Set();
  return value.slice(0, 200).map((item, index) => {
    if (!item || typeof item !== 'object') return null;
    const code = cleanText(item.code, 50).toUpperCase();
    const label = cleanText(item.label, 200);
    if (!code || !label || seen.has(code)) return null;
    seen.add(code);
    const isBusbar = code === 'BUSBAR';
    const inputType = isBusbar ? 'select' : ['select', 'text', 'number'].includes(item.input_type) ? item.input_type : 'text';
    return {
      code,
      section: cleanText(item.section, 100) || 'General',
      label,
      pdf_label: cleanText(item.pdf_label, 200) || label,
      input_type: inputType,
      options: isBusbar ? ['Aluminum', 'Copper'] : inputType === 'select' ? normalizeMasterList(item.options, []) : [],
      default_value: cleanText(item.default_value, 500),
      required: item.required !== false,
      active: item.active !== false,
      display_order: Number.isInteger(Number(item.display_order)) ? Number(item.display_order) : (index + 1) * 10,
    };
  }).filter(Boolean).sort((left, right) => left.display_order - right.display_order);
}

function normalizeQuotationNumbering(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const prefix = cleanText(source.prefix || 'QT', 20).replace(/[^a-zA-Z0-9]/g, '').toUpperCase() || 'QT';
  const separator = ['', '-', '/'].includes(source.separator) ? source.separator : '-';
  const requestedPadding = Number(source.padding);
  const padding = Number.isInteger(requestedPadding) && requestedPadding >= 1 && requestedPadding <= 10
    ? requestedPadding
    : 5;
  return { prefix, separator, padding };
}

function normalizeDashboardWidgets(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(DASHBOARD_ROLES.map((role) => {
    if (!Array.isArray(source[role])) return [role, [...DEFAULT_DASHBOARD_WIDGETS[role]]];
    const selected = [...new Set(source[role].map((item) => String(item || '').trim()))]
      .filter((item) => DASHBOARD_WIDGETS.includes(item));
    return [role, selected];
  }));
}

function normalizeMasterSettings(data = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_MASTER_SETTINGS).map(([key, fallback]) => {
    if (key === 'quotation_numbering') return [key, normalizeQuotationNumbering(data[key])];
    if (key === 'quotation_price_points') return [key, normalizePricePoints(data[key], fallback)];
    if (key === 'technical_note_fields') return [key, normalizeTechnicalNoteFields(data[key], fallback)];
    if (key === 'dashboard_widgets') return [key, normalizeDashboardWidgets(data[key])];
    if (key === 'product_categories') return [key, normalizeMasterList([...normalizeMasterList(data[key], fallback), ...DEAL_PRODUCTS], fallback)];
    return [key, normalizeMasterList(data[key], fallback)];
  }));
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
  normalizeMasterSettings,
};
