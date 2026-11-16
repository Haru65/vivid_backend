#!/usr/bin/env node

const path = require('node:path');
const pool = require('../config/db_connection');
const {
  attachAccountOwners,
  insertCustomers,
  listUsers,
  normalizedName,
  readCustomers,
  resetOwnedSequences,
  updateCustomer,
  validateRows,
} = require('./reset-and-import-customers');

const REPLACE_CONFIRMATION = 'DELETE_AND_REPLACE_CUSTOMERS';
const SYNC_CONFIRMATION = 'SYNC_CUSTOMERS_FROM_EXCEL';
const ACTIONS = new Set(['dry-run', 'sync', 'replace']);

function usage() {
  return `Usage:
  npm run db:replace-customers -- --action=dry-run --file=/path/to/customers.xlsx
  npm run db:replace-customers -- --action=sync --file=/path/to/customers.xlsx --confirm=${SYNC_CONFIRMATION}
  npm run db:replace-customers -- --action=replace --file=/path/to/customers.xlsx --confirm=${REPLACE_CONFIRMATION}

Actions:
  dry-run  Preview a safe synchronization without writing.
  sync     Update name matches, insert new customers, and delete only unlinked old customers.
  replace  Delete only rows in public.customers and import the workbook in one transaction.

Both write actions are transactional. Replace refuses to run while customers are linked.`;
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
  if (action === 'sync' && options.confirm !== SYNC_CONFIRMATION) {
    throw new Error(`Customer synchronization refused. Pass --confirm=${SYNC_CONFIRMATION} to continue.`);
  }
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

async function findCustomerReferenceDetails(db) {
  const tableResult = await db.query(`
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'customer_id'
      AND table_name <> 'customers'
    ORDER BY table_name
  `);

  const referencesByCustomerId = new Map();
  for (const { table_name: tableName } of tableResult.rows) {
    const result = await db.query(`
      SELECT dependent.customer_id AS customer_id, COUNT(*)::INTEGER AS count
      FROM public.${quoteIdentifier(tableName)} dependent
      JOIN public.customers customer ON customer.id = dependent.customer_id
      GROUP BY dependent.customer_id
    `);
    for (const row of result.rows) {
      const customerId = Number(row.customer_id);
      if (!referencesByCustomerId.has(customerId)) referencesByCustomerId.set(customerId, []);
      referencesByCustomerId.get(customerId).push({ table: tableName, count: Number(row.count) });
    }
  }
  return referencesByCustomerId;
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
    updatedCustomers: 0,
    importedCustomers: 0,
    resetSequences: [],
    skippedSequences: [],
    syncPlan: null,
  };
}

function groupByNormalizedCompany(entries, companyName) {
  const groups = new Map();
  for (const entry of entries) {
    const key = normalizedName(companyName(entry));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return groups;
}

function buildSyncPlan(workbookRows, existingCustomers, referencesByCustomerId) {
  const workbookGroups = groupByNormalizedCompany(workbookRows, (row) => row.customer.company_name);
  const existingGroups = groupByNormalizedCompany(existingCustomers, (customer) => customer.company_name);
  const conflicts = [];
  const updates = [];
  const inserts = [];
  const matchedExistingIds = new Set();

  for (const [key, rows] of workbookGroups) {
    const existingMatches = existingGroups.get(key) || [];
    if (rows.length > 1) {
      conflicts.push({
        company: rows[0].customer.company_name,
        reason: 'duplicate_excel_rows',
        excelRows: rows.map((row) => row.rowNumber),
      });
      continue;
    }
    if (existingMatches.length > 1) {
      conflicts.push({
        company: rows[0].customer.company_name,
        reason: 'duplicate_existing_customers',
        customerIds: existingMatches.map((customer) => customer.id),
      });
      continue;
    }
    if (existingMatches.length === 1) {
      updates.push({ row: rows[0], existing: existingMatches[0] });
      matchedExistingIds.add(existingMatches[0].id);
    } else {
      inserts.push(rows[0]);
    }
  }

  const deletions = [];
  const retainedLinked = [];
  for (const customer of existingCustomers) {
    if (matchedExistingIds.has(customer.id)) continue;
    const links = referencesByCustomerId.get(customer.id) || [];
    if (links.length) retainedLinked.push({ ...customer, links });
    else deletions.push(customer);
  }

  return { conflicts, updates, inserts, deletions, retainedLinked };
}

function syncPlanSummary(plan) {
  return {
    matchedCustomersToUpdate: plan.updates.length,
    newCustomersToInsert: plan.inserts.length,
    unlinkedOldCustomersToDelete: plan.deletions.length,
    linkedOldCustomersToRetain: plan.retainedLinked,
    conflicts: plan.conflicts,
  };
}

function syncConflictError(conflicts) {
  const details = conflicts
    .slice(0, 10)
    .map((conflict) => `${conflict.company} (${conflict.reason})`)
    .join(', ');
  return new Error(`Customer synchronization has ambiguous company names: ${details}. Resolve these conflicts and run the dry-run again.`);
}

async function prepareSyncPlan(db, prepared) {
  const existingResult = await db.query('SELECT id, company_name FROM public.customers ORDER BY id');
  const referencesByCustomerId = await findCustomerReferenceDetails(db);
  return buildSyncPlan(prepared.workbook.rows, existingResult.rows, referencesByCustomerId);
}

async function run(options, db = pool) {
  const prepared = await prepareWorkbook(options.file, db);

  if (options.action === 'dry-run') {
    const references = await findCustomerReferences(db);
    const summary = createSummary(options, prepared, references);
    summary.syncPlan = syncPlanSummary(await prepareSyncPlan(db, prepared));
    return summary;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE public.customers IN ACCESS EXCLUSIVE MODE');

    if (options.action === 'sync') {
      const plan = await prepareSyncPlan(client, prepared);
      if (plan.conflicts.length) throw syncConflictError(plan.conflicts);

      const summary = createSummary(options, prepared, await findCustomerReferences(client));
      summary.syncPlan = syncPlanSummary(plan);
      for (const update of plan.updates) {
        await updateCustomer(client, update.row, update.existing.id);
      }
      if (plan.deletions.length) {
        const deleteResult = await client.query(
          'DELETE FROM public.customers WHERE id = ANY($1::INTEGER[])',
          [plan.deletions.map((customer) => customer.id)],
        );
        summary.deletedCustomers = deleteResult.rowCount;
      }
      await insertCustomers(client, plan.inserts);
      summary.updatedCustomers = plan.updates.length;
      summary.importedCustomers = plan.inserts.length;
      await client.query('COMMIT');
      return summary;
    }

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
  SYNC_CONFIRMATION,
  buildSyncPlan,
  findCustomerReferences,
  findCustomerReferenceDetails,
  parseArguments,
  run,
};
