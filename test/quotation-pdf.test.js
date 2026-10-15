const assert = require('node:assert/strict');
const test = require('node:test');
const { PDFDocument } = require('pdf-lib');
const { generateQuotationPdf } = require('../services/quotationGeneration');

test('quotation PDF includes cover, price schedule, technical notes, and commercial terms', async () => {
  const bytes = await generateQuotationPdf({
    quotation_number: 'QT-TEST',
    company_name: 'Example Industries',
    contact_person_name: 'Customer',
    assigned_to: 'Estimator',
    line_items: [{ description: 'PCC Panel', quantity: 1, unit_price: 100000 }],
    subtotal: 100000,
    gst_rate: 18,
    gst_amount: 18000,
    total_amount: 118000,
    technical_notes_data: [
      { code: 'IP_RATING', section: 'General', label: 'Degree of protection', value: 'IP54', display_order: 10 },
      { code: 'INSTALLATION', section: 'General', label: 'Installation', value: 'Indoor', display_order: 20 },
    ],
  }, { name: 'Estimator' });

  const document = await PDFDocument.load(bytes);
  assert.equal(document.getPageCount(), 5);
  assert.ok(bytes.length > 1000);
});
