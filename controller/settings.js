const pool = require('../config/db_connection');

const DEFAULT_TAX_SETTINGS = {
  gst_rate: 18,
  cgst_rate: 9,
  sgst_rate: 9,
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

module.exports = {
  DEFAULT_TAX_SETTINGS,
  getTaxSettings,
  updateTaxSettings,
};
