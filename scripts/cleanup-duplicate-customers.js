#!/usr/bin/env node

const pool = require('../config/db_connection');
const { normalizedName } = require('./reset-and-import-customers');

const CLEANUP_CONFIRMATION = 'DEDUPLICATE_AND_DELETE_UNLINKED_CUSTOMERS';
const ACTIONS = new Set(['dry-run', 'cleanup']);
const MERGE_FIELDS = Object.freeze([
  'company_type',
  'gstin',
  'pan',
  'city',
  'country',
  'state',
  'district',
  'pincode',
  'precise_location',
  'industry',
  'company_site',
  'segment',
  'site_location',
  'consultant',
  'contact_person_name',
  'designation',
  'contact_person_phone',
  'contact_person_email',
  'alternate_contact_name',
  'alternate_contact_phone',
  'alternate_contact_email',
  'billing_address',
  'shipping_address',
  'amc_status',
  'amc_start_date',
  'amc_end_date',
  'account_owner_user_id',
  'account_owner_name',
  'remarks',
  'region',
]);

function usage() {
  return `Usage:
  npm run db:cleanup-customers -- --action=dry-run
  npm run db:cleanup-customers -- --action=cleanup --confirm=${CLEANUP_CONFIRMATION}

Actions:
  dry-run  Report duplicate groups, canonical records, links to remap, and unlinked records to delete.
  cleanup  Deduplicate customers, remap all customer_id links, and delete unlinked non-duplicate customers.

Duplicate matching ignores case, punctuation, and extra spaces. The cleanup is one transaction.`;
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
    if (!['action', 'confirm'].includes(name)) {
      throw new Error(`Unknown option: --${name}\n\n${usage()}`);
    }
    options[name] = argument.slice(separator + 1);
  }

  const action = options.action || 'dry-run';
  if (!ACTIONS.has(action)) throw new Error(`Invalid action: ${action}\n\n${usage()}`);
  if (action === 'cleanup' && options.confirm !== CLEANUP_CONFIRMATION) {
    throw new Error(`Customer cleanup refused. Pass --confirm=${CLEANUP_CONFIRMATION} to continue.`);
  }
  return { action };
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function hasValue(value) {
  return value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');
}

function completeness(customer) {
  return MERGE_FIELDS.reduce((total, field) => total + (hasValue(customer[field]) ? 1 : 0), 0);
}

function referenceCount(customerId, referencesByCustomerId) {
  return (referencesByCustomerId.get(Number(customerId)) || [])
    .reduce((total, reference) => total + reference.count, 0);
}

function canonicalSort(referencesByCustomerId) {
  return (left, right) => (
    referenceCount(right.id, referencesByCustomerId) - referenceCount(left.id, referencesByCustomerId)
    || completeness(right) - completeness(left)
    || Number(left.id) - Number(right.id)
  );
}

function groupCustomers(customers) {
  const groups = new Map();
  const unmatchable = [];
  for (const customer of customers) {
    const key = normalizedName(customer.company_name);
    if (!key) {
      unmatchable.push(customer);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(customer);
  }
  return { groups, unmatchable };
}

function buildCleanupPlan(customers, referencesByCustomerId) {
  const { groups, unmatchable } = groupCustomers(customers);
  const duplicateGroups = [];
  const duplicateCustomerIds = new Set();

  for (const records of groups.values()) {
    if (records.length < 2) continue;
    const ordered = [...records].sort(canonicalSort(referencesByCustomerId));
    const canonical = ordered[0];
    const duplicates = ordered.slice(1);
    duplicates.forEach((customer) => duplicateCustomerIds.add(Number(customer.id)));
    duplicateGroups.push({
      normalizedCompanyName: normalizedName(canonical.company_name),
      canonical,
      duplicates,
      referencesToMove: duplicates.reduce(
        (total, customer) => total + referenceCount(customer.id, referencesByCustomerId),
        0,
      ),
    });
  }

  const unlinkedUnique = [];
  const linkedUnique = [];
  for (const records of groups.values()) {
    if (records.length !== 1) continue;
    const customer = records[0];
    const references = referencesByCustomerId.get(Number(customer.id)) || [];
    if (references.length) linkedUnique.push({ customer, references });
    else unlinkedUnique.push(customer);
  }

  for (const customer of unmatchable) {
    const references = referencesByCustomerId.get(Number(customer.id)) || [];
    if (references.length) linkedUnique.push({ customer, references });
    else unlinkedUnique.push(customer);
  }

  return {
    duplicateGroups,
    duplicateCustomerIds,
    unlinkedUnique,
    linkedUnique,
  };
}

async function customerReferenceTables(db) {
  const result = await db.query(`
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'customer_id'
      AND table_name <> 'customers'
    ORDER BY table_name
  `);
  return result.rows.map((row) => row.table_name);
}

async function customerReferences(db, referenceTables) {
  const referencesByCustomerId = new Map();
  for (const tableName of referenceTables) {
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

async function loadPlan(db) {
  const referenceTables = await customerReferenceTables(db);
  const [customerResult, referencesByCustomerId] = await Promise.all([
    db.query('SELECT * FROM public.customers ORDER BY id'),
    customerReferences(db, referenceTables),
  ]);
  return {
    customers: customerResult.rows,
    referenceTables,
    plan: buildCleanupPlan(customerResult.rows, referencesByCustomerId),
  };
}

function customerLabel(customer) {
  return { id: Number(customer.id), company_name: customer.company_name };
}

function planSummary(action, loaded) {
  const { customers, plan } = loaded;
  const duplicateRows = plan.duplicateGroups.reduce((total, group) => total + group.duplicates.length, 0);
  const referencesToRemap = plan.duplicateGroups.reduce((total, group) => total + group.referencesToMove, 0);
  return {
    action,
    customerCountBefore: customers.length,
    duplicateGroupCount: plan.duplicateGroups.length,
    duplicateRowsToRemove: duplicateRows,
    referencesToRemap,
    duplicateGroups: plan.duplicateGroups.map((group) => ({
      normalizedCompanyName: group.normalizedCompanyName,
      canonical: customerLabel(group.canonical),
      duplicates: group.duplicates.map(customerLabel),
      referencesToMove: group.referencesToMove,
    })),
    unlinkedUniqueCustomersToDelete: plan.unlinkedUnique.length,
    linkedUniqueCustomersToKeep: plan.linkedUnique.map(({ customer, references }) => ({
      ...customerLabel(customer),
      references,
    })),
    expectedCustomerCountAfter: customers.length - duplicateRows - plan.unlinkedUnique.length,
    deletedDuplicateCustomers: 0,
    deletedUnlinkedCustomers: 0,
    remappedReferences: 0,
  };
}

function mergedValues(group) {
  const ordered = [group.canonical, ...group.duplicates]
    .sort(canonicalSort(new Map()));
  const merged = {};
  for (const field of MERGE_FIELDS) {
    const donor = ordered.find((customer) => hasValue(customer[field]));
    merged[field] = donor ? donor[field] : null;
  }
  return merged;
}

async function mergeCanonicalCustomer(db, group) {
  const merged = mergedValues(group);
  const assignments = MERGE_FIELDS.map((field, index) => `${quoteIdentifier(field)} = $${index + 1}`);
  await db.query(
    `UPDATE public.customers
     SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP
     WHERE id = $${MERGE_FIELDS.length + 1}`,
    [...MERGE_FIELDS.map((field) => merged[field]), group.canonical.id],
  );
}

async function executeCleanup(db, loaded, summary) {
  for (const group of loaded.plan.duplicateGroups) {
    await mergeCanonicalCustomer(db, group);
    for (const duplicate of group.duplicates) {
      for (const tableName of loaded.referenceTables) {
        const result = await db.query(
          `UPDATE public.${quoteIdentifier(tableName)} SET customer_id = $1 WHERE customer_id = $2`,
          [group.canonical.id, duplicate.id],
        );
        summary.remappedReferences += result.rowCount;
      }
    }
    const duplicateIds = group.duplicates.map((customer) => customer.id);
    const result = await db.query(
      'DELETE FROM public.customers WHERE id = ANY($1::INTEGER[])',
      [duplicateIds],
    );
    summary.deletedDuplicateCustomers += result.rowCount;
  }

  if (loaded.plan.unlinkedUnique.length) {
    const result = await db.query(
      'DELETE FROM public.customers WHERE id = ANY($1::INTEGER[])',
      [loaded.plan.unlinkedUnique.map((customer) => customer.id)],
    );
    summary.deletedUnlinkedCustomers = result.rowCount;
  }
}

async function run(options, db = pool) {
  if (options.action === 'dry-run') {
    const loaded = await loadPlan(db);
    return planSummary(options.action, loaded);
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE public.customers IN ACCESS EXCLUSIVE MODE');
    const referenceTables = await customerReferenceTables(client);
    for (const tableName of referenceTables) {
      await client.query(`LOCK TABLE public.${quoteIdentifier(tableName)} IN SHARE ROW EXCLUSIVE MODE`);
    }
    const loaded = await loadPlan(client);
    const summary = planSummary(options.action, loaded);
    await executeCleanup(client, loaded, summary);
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
    console.log(JSON.stringify(await run(options), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) main();

module.exports = {
  CLEANUP_CONFIRMATION,
  buildCleanupPlan,
  parseArguments,
  run,
};
