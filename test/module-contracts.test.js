const assert = require('node:assert/strict');
const test = require('node:test');

const quotations = require('../controller/quotations');
const { hashPassword, verifyPassword } = require('../controller/userManagement');
const { validateAuthConfiguration } = require('../middleware/auth');

test('quotation controller exposes every routed operation', () => {
  for (const operation of [
    'retrieveQuotations',
    'createQuotation',
    'createQuotationRevision',
    'updateQuotation',
    'deleteQuotation',
    'sendQuotation',
    'generateQuotationDocument',
  ]) {
    assert.equal(typeof quotations[operation], 'function', `${operation} must be exported`);
  }
});

test('password hashing accepts valid passwords and rejects invalid credentials', () => {
  const hash = hashPassword('safe-pass-123');
  assert.equal(verifyPassword('safe-pass-123', hash), true);
  assert.equal(verifyPassword('wrong-pass-123', hash), false);
  assert.throws(() => hashPassword('short'), /at least 8 characters/);
});

test('production authentication requires an explicit JWT secret', () => {
  const previousEnvironment = process.env.NODE_ENV;
  const previousSecret = process.env.JWT_SECRET;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.JWT_SECRET;
    assert.throws(() => validateAuthConfiguration(), /JWT_SECRET/);
    process.env.JWT_SECRET = 'test-production-secret';
    assert.doesNotThrow(() => validateAuthConfiguration());
  } finally {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});
