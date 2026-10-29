const assert = require('node:assert/strict');
const test = require('node:test');

const { buildPoFrontSheetPdf } = require('../services/estimationService');

test('frontsheet PDF generation works without the optional frontend header artwork', async () => {
  const pdf = await buildPoFrontSheetPdf({
    id: 42,
    company_name: 'Example Customer',
    enquiry_product: 'Control Panel',
    quotation_number: 'Q-42',
    quotation_total: 125000,
  }, {
    sales_data: {
      po_number: 'PO/42',
      client_name: 'Example Customer',
      project_name: 'Example Project',
    },
    estimation_data: {},
  }, {
    headerImagePath: '/path/that/does/not/exist/frontsheet-header.png',
  });

  const bytes = Buffer.from(pdf);
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(bytes.length > 1000);
});
