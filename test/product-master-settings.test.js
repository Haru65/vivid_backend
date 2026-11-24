const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const databasePath = path.resolve(__dirname, '../config/db_connection.js');
const settingsPath = path.resolve(__dirname, '../controller/settings.js');

function loadSettings(savedValue = null) {
  const calls = [];
  const pool = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/INSERT INTO system_settings/.test(sql)) return { rows: [] };
      if (/SELECT value/.test(sql)) return { rows: savedValue ? [{ value: savedValue }] : [] };
      throw new Error(`Unexpected settings query: ${sql}`);
    },
  };
  require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: pool, children: [], paths: [] };
  delete require.cache[settingsPath];
  return { settings: require(settingsPath), calls };
}

test('product categories saved in Masters remain the exact database-backed list', () => {
  const { settings } = loadSettings();
  const normalized = settings.normalizeMasterSettings({
    ...settings.DEFAULT_MASTER_SETTINGS,
    product_categories: ['Custom Panel', 'Retrofit Kit'],
  });

  assert.deepEqual(normalized.product_categories, ['Custom Panel', 'Retrofit Kit']);
});

test('loading Masters seeds the database before returning product categories', async () => {
  const saved = { product_categories: ['Database Product'] };
  const { settings, calls } = loadSettings(saved);
  const result = await settings.getMasterSettings();

  assert.deepEqual(result.product_categories, ['Database Product']);
  assert.match(calls[0].sql, /INSERT INTO system_settings/);
  assert.match(calls[0].sql, /ON CONFLICT \(key\) DO NOTHING/);
  assert.match(calls[1].sql, /WHERE key = 'masters'/);
});
