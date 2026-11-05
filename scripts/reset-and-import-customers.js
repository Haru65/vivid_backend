#!/usr/bin/env node

const path = require('node:path');
const ExcelJS = require('exceljs');
const pool = require('../config/db_connection');

const REQUIRED_HEADER = 'Company name *';
const DELETE_CONFIRMATION = 'DELETE_ALL_EXCEPT_USERS';
const ACTIONS = new Set(['dry-run', 'import', 'reset', 'reset-and-import']);

const COLUMN_MAP = Object.freeze({
  'Company name *': 'company_name',
  'Company Type': 'company_type',
  'Primary contact name *': 'contact_person_name',
  'Email *': 'contact_person_email',
  Phone: 'contact_person_phone',
  'Company Address': 'billing_address',
  Country: 'country',
  State: 'state',
  'City / town': 'city',
  'Territory *': 'region',
  'Account owner (sales person) *': 'account_owner_name',
  Remarks: 'remarks',
});

function usage() {
  return `Usage:
  npm run db:reset-import -- --action=dry-run --file=/path/to/customers.xlsx
  npm run db:reset-import -- --action=import --file=/path/to/customers.xlsx
  npm run db:reset-import -- --action=reset --confirm=${DELETE_CONFIRMATION}
  npm run db:reset-import -- --action=reset-and-import --file=/path/to/customers.xlsx --confirm=${DELETE_CONFIRMATION}

Actions:
  dry-run          Validate the workbook and account-owner mappings without writing.
  import           Add workbook customers without deleting existing data.
  reset            Delete data from every public table except users.
  reset-and-import Atomically reset the database and import workbook customers.`;
}

function parseArguments(argv) {
  const options = {};
  for (const argument of argv) {
    if (argument === '--help' || argument === '-h') return { help: true };
    if (!argument.startsWith('--') || !argument.includes('=')) {
      throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
    }
    const separator = argument.indexOf('=');
    options[argument.slice(2, separator)] = argument.slice(separator + 1);
  }

  const action = options.action || 'dry-run';
  if (!ACTIONS.has(action)) throw new Error(`Invalid action: ${action}\n\n${usage()}`);
  if (['dry-run', 'import', 'reset-and-import'].includes(action) && !options.file) {
    throw new Error(`--file is required for ${action}.\n\n${usage()}`);
  }
  if (['reset', 'reset-and-import'].includes(action) && options.confirm !== DELETE_CONFIRMATION) {
    throw new Error(`Destructive action refused. Pass --confirm=${DELETE_CONFIRMATION} to continue.`);
  }
  return { action, file: options.file ? path.resolve(options.file) : null };
}

function cleanText(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').trim();
}

function normalizedName(value) {
  return cleanText(value).toLocaleLowerCase('en-IN').replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizePhone(value) {
  const phone = cleanText(value);
  if (!phone || phone.length <= 20) return phone || null;
  const mobile = phone.match(/(?:^|\D)([6-9]\d{9})(?:\D|$)/);
  if (mobile) return mobile[1];
  const first = phone.split(/\s*(?:\/|;|,|\||\bor\b)\s*/i).find(Boolean) || phone;
  return first.slice(0, 20).trim() || null;
}

function mapUsersByName(users) {
  const exact = new Map();
  const firstNames = new Map();
  for (const user of users) {
    const fullName = cleanText([user.first_name, user.last_name].filter(Boolean).join(' '));
    exact.set(normalizedName(fullName), { ...user, full_name: fullName });
    const firstName = normalizedName(user.first_name);
    if (!firstNames.has(firstName)) firstNames.set(firstName, []);
    firstNames.get(firstName).push({ ...user, full_name: fullName });
  }
  return { exact, firstNames };
}

function resolveAccountOwner(ownerName, userIndex) {
  const requestedName = cleanText(ownerName);
  if (!requestedName) return { id: null, name: null, matched: false };
  const key = normalizedName(requestedName);
  const exact = userIndex.exact.get(key);
  if (exact) return { id: exact.id, name: exact.full_name, matched: true };
  const firstNameMatches = userIndex.firstNames.get(key) || [];
  if (firstNameMatches.length === 1) {
    return { id: firstNameMatches[0].id, name: firstNameMatches[0].full_name, matched: true };
  }
  return { id: null, name: requestedName, matched: false };
}

function worksheetHeaders(worksheet) {
  return worksheet.getRow(1).values.slice(1).map(cleanText);
}

function findCustomerWorksheet(workbook) {
  const worksheet = workbook.worksheets.find((candidate) => worksheetHeaders(candidate).includes(REQUIRED_HEADER));
  if (!worksheet) throw new Error(`No worksheet contains the required header "${REQUIRED_HEADER}".`);
  return worksheet;
}

function workbookRows(worksheet, sourceFile) {
  const headers = worksheetHeaders(worksheet);
  const missingHeaders = Object.keys(COLUMN_MAP).filter((header) => !headers.includes(header));
  if (missingHeaders.length) throw new Error(`Missing workbook headers: ${missingHeaders.join(', ')}`);

  const rows = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const original = {};
    headers.forEach((header, index) => {
      if (header) original[header] = cleanText(row.getCell(index + 1).text);
    });
    if (!Object.values(original).some(Boolean)) return;

    const customer = {};
    for (const [header, databaseColumn] of Object.entries(COLUMN_MAP)) {
      customer[databaseColumn] = original[header] || null;
    }
    customer.contact_person_phone = normalizePhone(customer.contact_person_phone);
    customer.raw_data = {
      source_file: path.basename(sourceFile),
      source_sheet: worksheet.name,
      excel_row: rowNumber,
      original,
    };
    rows.push({ rowNumber, customer });
  });
  return rows;
}

async function readCustomers(file) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const worksheet = findCustomerWorksheet(workbook);
  return { worksheetName: worksheet.name, rows: workbookRows(worksheet, file) };
}

function validateRows(rows) {
  const errors = [];
  const warnings = [];
  for (const { rowNumber, customer } of rows) {
    if (!customer.company_name) errors.push(`Row ${rowNumber}: company name is required.`);
    if (!customer.contact_person_name) warnings.push(`Row ${rowNumber}: primary contact name is blank.`);
    if (!customer.contact_person_email) warnings.push(`Row ${rowNumber}: email is blank.`);
    if (!customer.billing_address) warnings.push(`Row ${rowNumber}: company address is blank.`);
  }
  return { errors, warnings };
}

async function listUsers(db) {
  const result = await db.query(`
    SELECT id, first_name, last_name, role, is_active
    FROM users
    ORDER BY id
  `);
  return result.rows;
}

function attachAccountOwners(rows, users) {
  const userIndex = mapUsersByName(users.filter((user) => user.is_active));
  const unmatchedOwners = new Set();
  let matchedOwnerRows = 0;
  for (const { customer } of rows) {
    const owner = resolveAccountOwner(customer.account_owner_name, userIndex);
    customer.account_owner_user_id = owner.id;
    customer.account_owner_name = owner.name;
    if (owner.matched) matchedOwnerRows += 1;
    else if (owner.name) unmatchedOwners.add(owner.name);
  }
  return { matchedOwnerRows, unmatchedOwners: [...unmatchedOwners].sort() };
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

async function publicTablesExceptUsers(db) {
  const result = await db.query(`
    SELECT tablename
    FROM pg_catalog.pg_tables
    WHERE schemaname = 'public' AND tablename <> 'users'
    ORDER BY tablename
  `);
  return result.rows.map((row) => row.tablename);
}

async function deleteOrder(db, tables) {
  const result = await db.query(`
    SELECT child.relname AS child_table, parent.relname AS parent_table
    FROM pg_catalog.pg_constraint constraint_record
    JOIN pg_catalog.pg_class child ON child.oid = constraint_record.conrelid
    JOIN pg_catalog.pg_class parent ON parent.oid = constraint_record.confrelid
    JOIN pg_catalog.pg_namespace namespace_record ON namespace_record.oid = constraint_record.connamespace
    WHERE constraint_record.contype = 'f'
      AND namespace_record.nspname = 'public'
      AND child.relname <> 'users'
      AND parent.relname <> 'users'
  `);
  const tableSet = new Set(tables);
  const childrenByParent = new Map(tables.map((table) => [table, []]));
  for (const row of result.rows) {
    if (tableSet.has(row.child_table) && tableSet.has(row.parent_table)) {
      childrenByParent.get(row.parent_table).push(row.child_table);
    }
  }

  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(table) {
    if (visited.has(table)) return;
    if (visiting.has(table)) throw new Error(`Cannot safely clear cyclic foreign keys involving ${table}.`);
    visiting.add(table);
    for (const child of childrenByParent.get(table)) visit(child);
    visiting.delete(table);
    visited.add(table);
    ordered.push(table);
  }
  for (const table of tables) visit(table);
  return ordered;
}

async function resetOwnedSequences(db, tables) {
  const result = await db.query(`
    SELECT DISTINCT pg_get_serial_sequence(
      quote_ident(table_schema) || '.' || quote_ident(table_name),
      column_name
    ) AS sequence_name,
    has_sequence_privilege(
      current_user,
      pg_get_serial_sequence(quote_ident(table_schema) || '.' || quote_ident(table_name), column_name),
      'UPDATE'
    ) AS can_reset
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
      AND (column_default LIKE 'nextval(%' OR is_identity = 'YES')
  `, [tables]);
  const sequences = result.rows.filter((row) => row.sequence_name && row.can_reset).map((row) => row.sequence_name);
  const skippedSequences = result.rows.filter((row) => row.sequence_name && !row.can_reset).map((row) => row.sequence_name);
  for (const sequence of sequences) {
    await db.query('SELECT setval($1::regclass, 1, false)', [sequence]);
  }
  return { sequences, skippedSequences };
}

async function resetDatabase(db) {
  const tables = await publicTablesExceptUsers(db);
  if (!tables.includes('customers')) throw new Error('The public customers table was not found; reset was cancelled.');
  const orderedTables = await deleteOrder(db, tables);
  for (const table of orderedTables) {
    await db.query(`DELETE FROM public.${quoteIdentifier(table)}`);
  }
  const sequenceSummary = await resetOwnedSequences(db, tables);
  return { tables: orderedTables, ...sequenceSummary };
}

const INSERT_CUSTOMER_SQL = `
  INSERT INTO customers (
    company_name, company_type, contact_person_name, contact_person_email,
    contact_person_phone, billing_address, country, state, city, region,
    account_owner_user_id, account_owner_name, remarks, raw_data
  ) VALUES (
    $1, $2, $3, $4, $5, $6, COALESCE($7, 'India'), $8, $9, $10,
    $11, $12, $13, $14::jsonb
  )
`;

async function insertCustomers(db, rows) {
  for (const { rowNumber, customer } of rows) {
    try {
      await db.query(INSERT_CUSTOMER_SQL, [
        customer.company_name,
        customer.company_type,
        customer.contact_person_name,
        customer.contact_person_email,
        customer.contact_person_phone,
        customer.billing_address,
        customer.country,
        customer.state,
        customer.city,
        customer.region,
        customer.account_owner_user_id,
        customer.account_owner_name,
        customer.remarks,
        JSON.stringify(customer.raw_data),
      ]);
    } catch (error) {
      error.message = `Excel row ${rowNumber} (${customer.company_name || 'unnamed customer'}): ${error.message}`;
      throw error;
    }
  }
}

async function run(options, db = pool) {
  let workbook = null;
  let validation = { errors: [], warnings: [] };
  let ownerSummary = { matchedOwnerRows: 0, unmatchedOwners: [] };
  let users = [];

  if (options.file) {
    workbook = await readCustomers(options.file);
    validation = validateRows(workbook.rows);
    if (validation.errors.length) {
      throw new Error(`Workbook validation failed:\n${validation.errors.join('\n')}`);
    }
    users = await listUsers(db);
    ownerSummary = attachAccountOwners(workbook.rows, users);
  }

  const summary = {
    action: options.action,
    file: options.file,
    worksheet: workbook?.worksheetName || null,
    customerRows: workbook?.rows.length || 0,
    preservedUsers: users.length || null,
    matchedOwnerRows: ownerSummary.matchedOwnerRows,
    unmatchedOwners: ownerSummary.unmatchedOwners,
    warningCount: validation.warnings.length,
    warnings: validation.warnings.slice(0, 25),
    clearedTables: [],
    resetSequences: [],
    skippedSequences: [],
    importedCustomers: 0,
  };

  if (options.action === 'dry-run') return summary;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (options.action === 'reset' || options.action === 'reset-and-import') {
      const resetSummary = await resetDatabase(client);
      summary.clearedTables = resetSummary.tables;
      summary.resetSequences = resetSummary.sequences;
      summary.skippedSequences = resetSummary.skippedSequences;
    }
    if (options.action === 'import' || options.action === 'reset-and-import') {
      await insertCustomers(client, workbook.rows);
      summary.importedCustomers = workbook.rows.length;
    }
    await client.query('COMMIT');
    return summary;
  } catch (error) {
    await client.query('ROLLBACK');
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
  DELETE_CONFIRMATION,
  attachAccountOwners,
  cleanText,
  findCustomerWorksheet,
  mapUsersByName,
  normalizePhone,
  parseArguments,
  resolveAccountOwner,
  validateRows,
  workbookRows,
};
