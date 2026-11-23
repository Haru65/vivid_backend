const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function mockModule(relativePath, exports) {
  const filename = path.resolve(__dirname, relativePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

function setup({ status = 'assigned', remarks = null } = {}) {
  const calls = [];
  const request = {
    id: 22, lead_id: 11, status, assigned_engineer_id: 8,
    sales_owner_id: 14, uploaded_quote_remarks: remarks,
  };
  const query = async (sql, values = []) => {
    calls.push({ sql, values });
    if (/FROM estimation_requests er/.test(sql)) {
      assert.match(sql, /equ\.remarks AS uploaded_quote_remarks/);
      return { rows: [{ ...request }] };
    }
    if (/SELECT quotation_number, revision_number/.test(sql)) return { rows: [{ revision_number: 1 }] };
    if (/INSERT INTO estimation_quote_uploads/.test(sql)) {
      assert.match(sql, /remarks = EXCLUDED\.remarks/);
      request.uploaded_quote_remarks = values[9];
      request.uploaded_revision_number = values[2];
      return { rows: [] };
    }
    if (/UPDATE estimation_requests/.test(sql)) {
      request.status = values[4];
      return { rows: [] };
    }
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  mockModule('../config/db_connection.js', { query, connect: async () => ({ query, release() {} }) });
  mockModule('../controller/leads.js', { logLeadActivity: async () => {} });
  mockModule('../services/notificationService.js', { notifyUserId: async () => {}, notifyRole: async () => {} });
  const filename = path.resolve(__dirname, '../services/estimationService.js');
  delete require.cache[filename];
  return { service: require(filename), calls };
}

const engineer = { id: 8, role: 'estimation_engineer', name: 'Estimator' };
const sales = { id: 14, role: 'sales_engineer', name: 'Sales' };
const metadata = { filename: 'quotation.pdf', quotation_number: 'Q-489', quote_value: '1200' };
const pdf = Buffer.from('%PDF-1.7\nTest quotation');

test('PDF remarks are saved and returned to both assigned Estimation and Sales users', async () => {
  const { service } = setup();
  const remarks = 'Price includes 10% discount.\nडिलीवरी: 4 weeks';
  const uploaded = await service.uploadRequestQuotationPdf(22, pdf, { ...metadata, remarks: `  ${remarks}  ` }, engineer);
  assert.equal(uploaded.uploaded_quote_remarks, remarks);
  assert.equal(uploaded.status, 'submitted_for_review');
  assert.equal((await service.getRequest(22, sales)).uploaded_quote_remarks, remarks);
  assert.equal((await service.getRequest(22, engineer)).uploaded_quote_remarks, remarks);
});

test('Remarks are optional for existing clients and whitespace-only submissions', async () => {
  for (const remarks of [undefined, '', '  \n  ']) {
    const { service } = setup();
    const saved = await service.uploadRequestQuotationPdf(22, pdf, { ...metadata, remarks }, engineer);
    assert.equal(saved.uploaded_quote_remarks, null);
  }
});

test('Revision upload can replace or clear the previous PDF remarks', async () => {
  for (const remarks of ['Updated delivery terms', '']) {
    const { service } = setup({ status: 'revision_requested', remarks: 'Old terms' });
    const saved = await service.uploadRequestQuotationPdf(22, pdf, { ...metadata, remarks }, engineer);
    assert.equal(saved.uploaded_quote_remarks, remarks || null);
    assert.equal(saved.uploaded_revision_number, 2);
    assert.equal(saved.status, 'revision_submitted_for_review');
  }
});

test('Oversized remarks are rejected before changing the PDF', async () => {
  const { service, calls } = setup();
  await assert.rejects(service.uploadRequestQuotationPdf(22, pdf, { ...metadata, remarks: 'a'.repeat(1001) }, engineer),
    (error) => error.statusCode === 400 && /remarks/.test(error.message));
  assert.equal(calls.some(({ sql }) => sql === 'BEGIN'), false);
});

test('Adding remarks does not allow another engineer to upload or view the quotation', async () => {
  const { service, calls } = setup();
  const otherEngineer = { ...engineer, id: 9 };
  await assert.rejects(service.uploadRequestQuotationPdf(22, pdf, { ...metadata, remarks: 'Not allowed' }, otherEngineer),
    (error) => error.statusCode === 403);
  await assert.rejects(service.getRequest(22, { ...sales, id: 15 }), (error) => error.statusCode === 403);
  assert.equal(calls.some(({ sql }) => sql === 'BEGIN'), false);
});
