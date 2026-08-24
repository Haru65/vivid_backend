const NUMERIC_TYPES = new Set(['discount', 'final_price', 'payment_terms', 'delivery_extension', 'warranty']);

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function normalizeRole(role) {
  return String(role || 'salesperson').trim().toLowerCase();
}

function extractNumber(value) {
  const match = String(value || '').match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function comparisonValue(negotiationType, proposedValue, quotation) {
  if (negotiationType === 'final_price') {
    const proposed = Number(proposedValue);
    if (!Number.isFinite(proposed) || proposed < 0) throw validationError('Final price must be zero or more.');
    const current = Number(quotation?.total_amount || 0);
    if (current <= 0) return 0;
    const reduction = Math.max(0, ((current - proposed) / current) * 100);
    return Number(reduction.toFixed(2));
  }

  if (!NUMERIC_TYPES.has(negotiationType)) return null;
  const numeric = extractNumber(proposedValue);
  if (numeric === null || !Number.isFinite(numeric) || numeric < 0) {
    throw validationError(`${negotiationType.replace(/_/g, ' ')} must include a valid non-negative number.`);
  }
  return numeric;
}

async function checkNegotiationApprovalRequirement({
  client,
  user,
  negotiationType,
  proposedValue,
  quotation,
}) {
  const role = normalizeRole(user?.role);
  const ruleResult = await client.query(
    `SELECT role_name, negotiation_type, max_numeric_value, is_allowed, requires_ga_above_limit
     FROM negotiation_authority_rules
     WHERE LOWER(role_name) = $1
       AND negotiation_type = $2
       AND active = TRUE
     ORDER BY id DESC
     LIMIT 1`,
    [role, negotiationType],
  );
  const rule = ruleResult.rows[0];
  const valueForLimit = comparisonValue(negotiationType, proposedValue, quotation);

  if (!rule) {
    return {
      approvalRequired: true,
      reason: 'No negotiation authority rule is configured for this role and negotiation type.',
      authorityLimit: null,
      approverRole: 'admin',
      comparisonValue: valueForLimit,
    };
  }

  if (!rule.is_allowed) {
    return {
      approvalRequired: true,
      reason: `${role} cannot apply ${negotiationType.replace(/_/g, ' ')} negotiations directly.`,
      authorityLimit: rule.max_numeric_value === null ? null : Number(rule.max_numeric_value),
      approverRole: 'admin',
      comparisonValue: valueForLimit,
    };
  }

  const limit = rule.max_numeric_value === null ? null : Number(rule.max_numeric_value);
  if (limit !== null && valueForLimit !== null && valueForLimit > limit && rule.requires_ga_above_limit) {
    const label = negotiationType === 'final_price'
      ? `Requested final price reduction ${valueForLimit}% exceeds allowed limit of ${limit}%`
      : `Requested ${negotiationType.replace(/_/g, ' ')} ${proposedValue} exceeds allowed limit of ${limit}`;
    return {
      approvalRequired: true,
      reason: label,
      authorityLimit: limit,
      approverRole: 'admin',
      comparisonValue: valueForLimit,
    };
  }

  return {
    approvalRequired: false,
    reason: limit === null ? 'Within your negotiation authority.' : `Within your authority limit of ${limit}.`,
    authorityLimit: limit,
    approverRole: 'admin',
    comparisonValue: valueForLimit,
  };
}

module.exports = {
  checkNegotiationApprovalRequirement,
  extractNumber,
};
