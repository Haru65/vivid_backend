const { sendEmail } = require('./emailService');

const APPROVAL_EMAIL_TYPES = {
  SALES_HOD: 'sales_hod',
  ESTIMATION_HOD: 'estimation_hod',
  MANAGEMENT: 'management',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function display(value, fallback = 'Not provided') {
  const text = String(value ?? '').trim();
  return escapeHtml(text || fallback);
}

function money(value) {
  if (value === undefined || value === null || value === '') return 'Not provided';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return display(value);
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(amount);
}

function percent(value) {
  if (value === undefined || value === null || value === '') return 'Not provided';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return display(value);
  return `${amount.toFixed(2)}%`;
}

function row(label, value) {
  return `<p><strong>${escapeHtml(label)}:</strong> ${value}</p>`;
}

function approvalLink(url, label = 'Review Approval') {
  if (!url) return '';
  const safeUrl = escapeHtml(url);
  return `<p><a href="${safeUrl}">${escapeHtml(label)}</a></p>`;
}

function salesHodApprovalTemplate(data) {
  return {
    subject: `Sales Approval Required - ${data.quotationNumber}`,
    html: `
      <h2>Sales Approval Required</h2>
      ${row('Customer', display(data.customerName))}
      ${row('Quotation', display(data.quotationNumber))}
      ${row('Current Value', money(data.currentValue))}
      ${row('Proposed Value', display(data.proposedValue))}
      ${row('Discount', percent(data.discountPercent))}
      ${row('Reason', display(data.reason))}
      ${approvalLink(data.approvalUrl)}
    `,
  };
}

function estimationHodApprovalTemplate(data) {
  return {
    subject: `Estimation Approval Required - ${data.quotationNumber}`,
    html: `
      <h2>Estimation Approval Required</h2>
      ${row('Customer', display(data.customerName))}
      ${row('Quotation', display(data.quotationNumber))}
      ${row('Material Cost', money(data.materialCost))}
      ${row('Labour Cost', money(data.labourCost))}
      ${row('Total Cost', money(data.totalCost))}
      ${row('Selling Price', money(data.sellingPrice))}
      ${row('Margin', percent(data.marginPercent))}
      ${approvalLink(data.approvalUrl, 'Review Estimation')}
    `,
  };
}

function managementApprovalTemplate(data) {
  return {
    subject: `Management Approval Required - ${data.quotationNumber}`,
    html: `
      <h2>Commercial Approval Required</h2>
      ${row('Customer', display(data.customerName))}
      ${row('Quotation', display(data.quotationNumber))}
      ${row('Order Value', money(data.orderValue))}
      ${row('Total Cost', money(data.totalCost))}
      ${row('Gross Margin', percent(data.marginPercent))}
      ${row('Payment Terms', display(data.paymentTerms))}
      ${row('Delivery Terms', display(data.deliveryTerms))}
      ${row('Reason', display(data.reason))}
      ${approvalLink(data.approvalUrl)}
    `,
  };
}

function templateFor(type, data) {
  switch (type) {
    case APPROVAL_EMAIL_TYPES.SALES_HOD:
      return salesHodApprovalTemplate(data);
    case APPROVAL_EMAIL_TYPES.ESTIMATION_HOD:
      return estimationHodApprovalTemplate(data);
    case APPROVAL_EMAIL_TYPES.MANAGEMENT:
      return managementApprovalTemplate(data);
    default:
      throw new Error('Unknown approval email type.');
  }
}

async function sendApprovalEmail(type, approver, data) {
  if (!approver?.email) {
    throw new Error('Approver email is required.');
  }

  const template = templateFor(type, data);
  const result = await sendEmail({
    to: approver.email,
    subject: template.subject,
    html: template.html,
  });

  return {
    ...result,
    subject: template.subject,
    html: template.html,
  };
}

module.exports = {
  APPROVAL_EMAIL_TYPES,
  managementApprovalTemplate,
  salesHodApprovalTemplate,
  estimationHodApprovalTemplate,
  sendApprovalEmail,
};
