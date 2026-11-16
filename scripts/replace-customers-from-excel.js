#!/usr/bin/env node

const path = require('node:path');
const pool = require('../config/db_connection');
const {
  attachAccountOwners,
  insertCustomers,
  listUsers,
  readCustomers,
  resetOwnedSequences,
  validateRows,
} = require('./reset-and-import-customers');

const REPLACE_CONFIRMATION = 'DELETE_AND_REPLACE_CUSTOMERS';
const ACTIONS = new Set(['dry-run', 'replace']);

function usage() {
  return `Usage:
  npm run db:replace-customers -- --action=dry-run --file=/path/to/customers.xlsx
  npm run db:replace-customers -- --action=replace --file=/path/to/customers.xlsx --confirm=${REPLACE_CONFIRMATION}

Actions:
  dry-run  Validate the workbook, account owners, and linked-record safety without writing.
  replace  Delete only rows in public.customers and import the workbook in one transaction.

The replace action refuses to run while existing customers are linked from another table.`;
}

function parseArguments(argv) {
  const options = {};
  for (const argument of argv) {
    if (argument === '--help' || argument === '-h') return { help: true };
    if (!argument.startsWith('--') || !argument.includes('=')) {
      throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
    }
    const separator = argument.indexOf('=');
    const name = argument.slice(2, separator);
    if (!['action', 'file', 'confirm'].includes(name)) {
      throw new Error(`Unknown option: --${name}\n\n${usage()}`);
    }
    options[name] = argument.slice(separator + 1);
  }

  const action = options.action || 'dry-run';
  if (!ACTIONS.has(action)) throw new Error(`Invalid action: ${action}\n\n${usage()}`);
  if (!options.file) throw new Error(`--file is required.\n\n${usage()}`);
  if (action === 'replace' && options.confirm !== REPLACE_CONFIRMATION) {
    throw new Error(`Customer replacement refused. Pass --confirm=${REPLACE_CONFIRMATION} to continue.`);
  }
  return { action, file: path.resolve(options.file) };
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

async function findCustomerReferences(db) {
  const tableResult = await db.query(`
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'customer_id'
      AND table_name <> 'customers'
    ORDER BY table_name
  `);

  const references = [];
  for (const { table_name: tableName } of tableResult.rows) {
    const result = await db.query(`
      SELECT COUNT(*)::INTEGER AS count
      FROM public.${quoteIdentifier(tableName)} dependent
      JOIN public.customers customer ON customer.id = dependent.customer_id
    `);
    const count = Number(result.rows[0]?.count || 0);
    if (count > 0) references.push({ table: tableName, count });
  }
  return references;
}

function linkedRecordsError(references) {
  const details = references.map(({ table, count }) => `${table} (${count})`).join(', ');
  return new Error(
    `Customer replacement refused because existing customers are linked from: ${details}. `
    + 'Remove or migrate those links before replacing the customer table.',
  );
}

async function prepareWorkbook(file, db) {
  const workbook = await readCustomers(file);
  if (!workbook.rows.length) throw new Error('Workbook contains no customer data rows; replacement was cancelled.');

  const validation = validateRows(workbook.rows);
  if (validation.errors.length) {
    throw new Error(`Workbook validation failed:\n${validation.errors.join('\n')}`);
  }
  const users = await listUsers(db);
  const ownerSummary = attachAccountOwners(workbook.rows, users);
  return { workbook, validation, users, ownerSummary };
}

function createSummary(options, prepared, references) {
  return {
    action: options.action,
    file: options.file,
    worksheet: prepared.workbook.worksheetName,
    customerRows: prepared.workbook.rows.length,
    preservedUsers: prepared.users.length,
    matchedOwnerRows: prepared.ownerSummary.matchedOwnerRows,
    unmatchedOwners: prepared.ownerSummary.unmatchedOwners,
    warningCount: prepared.validation.warnings.length,
    warnings: prepared.validation.warnings.slice(0, 25),
    linkedCustomerRecords: references,
    deletedCustomers: 0,
    importedCustomers: 0,
    resetSequences: [],
    skippedSequences: [],
  };
}

async function run(options, db = pool) {
  const prepared = await prepareWorkbook(options.file, db);

  if (options.action === 'dry-run') {
    const references = await findCustomerReferences(db);
    return createSummary(options, prepared, references);
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE public.customers IN ACCESS EXCLUSIVE MODE');

    const references = await findCustomerReferences(client);
    if (references.length) throw linkedRecordsError(references);

    const summary = createSummary(options, prepared, references);
    const deleteResult = await client.query('DELETE FROM public.customers');
    summary.deletedCustomers = deleteResult.rowCount;

    const sequenceSummary = await resetOwnedSequences(client, ['customers']);
    summary.resetSequences = sequenceSummary.sequences;
    summary.skippedSequences = sequenceSummary.skippedSequences;

    await insertCustomers(client, prepared.workbook.rows);
    summary.importedCustomers = prepared.workbook.rows.length;
    await client.query('COMMIT');
    return summary;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const summary = await run(options);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) main();

module.exports = {
  REPLACE_CONFIRMATION,
  findCustomerReferences,
  parseArguments,
  run,
};
