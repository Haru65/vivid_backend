const crypto = require('crypto');
const pool = require('../config/db_connection');

const USER_ROLES = new Set(['admin', 'salesperson', 'erp']);
const PASSWORD_HASH_PREFIX = 'pbkdf2';
const PASSWORD_ITERATIONS = 120000;
const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_DIGEST = 'sha512';

function appError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeRole(role) {
  const value = String(role || '').trim().toLowerCase();
  if (!USER_ROLES.has(value)) throw appError('User role must be admin, salesperson, or erp.');
  return value;
}

function normalizeText(value, label, maxLength, { required = false } = {}) {
  const text = String(value || '').trim();
  if (!text) {
    if (required) throw appError(`${label} is required.`);
    return null;
  }
  if (text.length > maxLength) throw appError(`${label} is too long.`);
  return text;
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) throw appError('Email is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw appError('Email must be valid.');
  if (email.length > 255) throw appError('Email is too long.');
  return email;
}

function normalizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    first_name: row.first_name,
    last_name: row.last_name || '',
    name: [row.first_name, row.last_name].filter(Boolean).join(' '),
    email: row.email,
    phone: row.phone || '',
    role: row.role,
    department: row.department || '',
    designation: row.designation || '',
    employee_code: row.employee_code || '',
    is_active: row.is_active !== false,
    manager_id: row.manager_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function userSelect(where = '') {
  return `
    SELECT id, first_name, last_name, email, phone, password_hash, role, department,
           designation, employee_code, is_active, manager_id, created_at, updated_at
    FROM users
    ${where}
  `;
}

function hashPassword(password) {
  const value = String(password || '');
  if (value.length < 6) throw appError('Password must be at least 6 characters.');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .pbkdf2Sync(value, salt, PASSWORD_ITERATIONS, PASSWORD_KEY_LENGTH, PASSWORD_DIGEST)
    .toString('hex');
  return `${PASSWORD_HASH_PREFIX}$${PASSWORD_ITERATIONS}$${salt}$${hash}`;
}

function verifyPassword(password, passwordHash) {
  const [prefix, iterations, salt, storedHash] = String(passwordHash || '').split('$');
  if (prefix !== PASSWORD_HASH_PREFIX || !iterations || !salt || !storedHash) return false;
  const hash = crypto
    .pbkdf2Sync(String(password || ''), salt, Number(iterations), PASSWORD_KEY_LENGTH, PASSWORD_DIGEST)
    .toString('hex');
  if (hash.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
}

async function createUserSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100),
      email VARCHAR(255) UNIQUE NOT NULL,
      phone VARCHAR(20),
      password_hash TEXT NOT NULL,
      role VARCHAR(100) NOT NULL CHECK (role IN ('admin', 'salesperson', 'erp')),
      department VARCHAR(100),
      designation VARCHAR(150),
      employee_code VARCHAR(50) UNIQUE,
      is_active BOOLEAN DEFAULT TRUE,
      manager_id BIGINT REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const count = await pool.query('SELECT COUNT(*)::int AS count FROM users');
  if (count.rows[0].count === 0) {
    await createUser({
      first_name: process.env.DEFAULT_ADMIN_FIRST_NAME || 'Ashish',
      last_name: process.env.DEFAULT_ADMIN_LAST_NAME || 'Vibhute',
      email: process.env.DEFAULT_ADMIN_EMAIL || 'admin@vividelectromech.in',
      password: process.env.DEFAULT_ADMIN_PASSWORD || 'admin123',
      role: 'admin',
      department: 'Management',
      designation: 'Workspace Admin',
      employee_code: 'ADMIN-001',
      is_active: true,
    }, { role: 'admin' });
    console.log('Default admin user created.');
  }

  console.log('User schema created successfully.');
}

async function findUserByEmail(email) {
  const result = await pool.query(userSelect('WHERE LOWER(email) = $1'), [normalizeEmail(email)]);
  return result.rows[0] || null;
}

async function getUserById(id) {
  if (!id) throw appError('User ID is required.');
  const result = await pool.query(userSelect('WHERE id = $1'), [id]);
  const user = result.rows[0];
  if (!user) throw appError('User not found.', 404);
  return user;
}

function requireAdmin(actor) {
  if (actor?.role !== 'admin') throw appError('Only admins can manage users.', 403);
}

async function listUsers(actor) {
  requireAdmin(actor);
  const result = await pool.query(`${userSelect()} ORDER BY first_name ASC, last_name ASC, id ASC`);
  return result.rows.map(normalizeUser);
}

async function listApprovalUsers() {
  const result = await pool.query(
    `${userSelect('WHERE is_active = TRUE')}
     ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'salesperson' THEN 1 ELSE 2 END,
       first_name ASC, last_name ASC, id ASC`,
  );
  return result.rows.map((row) => {
    const user = normalizeUser(row);
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      approver_role: user.role,
      title: user.designation || user.department || user.role,
    };
  });
}

function userValues(data = {}, { partial = false } = {}) {
  const values = {};
  if (!partial || data.first_name !== undefined) values.firstName = normalizeText(data.first_name, 'First name', 100, { required: !partial });
  if (!partial || data.last_name !== undefined) values.lastName = normalizeText(data.last_name, 'Last name', 100);
  if (!partial || data.email !== undefined) values.email = normalizeEmail(data.email);
  if (!partial || data.phone !== undefined) values.phone = normalizeText(data.phone, 'Phone', 20);
  if (!partial || data.role !== undefined) values.role = normalizeRole(data.role);
  if (!partial || data.department !== undefined) values.department = normalizeText(data.department, 'Department', 100);
  if (!partial || data.designation !== undefined) values.designation = normalizeText(data.designation, 'Designation', 150);
  if (!partial || data.employee_code !== undefined) values.employeeCode = normalizeText(data.employee_code, 'Employee code', 50);
  if (!partial || data.manager_id !== undefined) values.managerId = data.manager_id ? Number(data.manager_id) : null;
  if (!partial || data.is_active !== undefined) values.isActive = data.is_active !== false;
  return values;
}

async function createUser(data, actor) {
  requireAdmin(actor);
  const values = userValues(data);
  const passwordHash = hashPassword(data.password);
  const result = await pool.query(
    `INSERT INTO users (
       first_name, last_name, email, phone, password_hash, role, department,
       designation, employee_code, is_active, manager_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      values.firstName,
      values.lastName,
      values.email,
      values.phone,
      passwordHash,
      values.role,
      values.department,
      values.designation,
      values.employeeCode,
      values.isActive,
      values.managerId,
    ],
  );
  return normalizeUser(result.rows[0]);
}

async function updateUser(id, data, actor) {
  requireAdmin(actor);
  await getUserById(id);
  const values = userValues(data, { partial: true });
  const updates = [];
  const params = [];

  const add = (column, value) => {
    params.push(value);
    updates.push(`${column} = $${params.length}`);
  };

  if ('firstName' in values) add('first_name', values.firstName);
  if ('lastName' in values) add('last_name', values.lastName);
  if ('email' in values) add('email', values.email);
  if ('phone' in values) add('phone', values.phone);
  if ('role' in values) add('role', values.role);
  if ('department' in values) add('department', values.department);
  if ('designation' in values) add('designation', values.designation);
  if ('employeeCode' in values) add('employee_code', values.employeeCode);
  if ('managerId' in values) add('manager_id', values.managerId);
  if ('isActive' in values) add('is_active', values.isActive);
  if (data.password) add('password_hash', hashPassword(data.password));

  if (!updates.length) return normalizeUser(await getUserById(id));

  params.push(id);
  const result = await pool.query(
    `UPDATE users
     SET ${updates.join(', ')},
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $${params.length}
     RETURNING *`,
    params,
  );
  return normalizeUser(result.rows[0]);
}

async function deactivateUser(id, actor) {
  requireAdmin(actor);
  if (String(actor?.id) === String(id)) throw appError('You cannot deactivate your own account.', 409);
  return updateUser(id, { is_active: false }, actor);
}

async function authenticateUser(email, password) {
  const user = await findUserByEmail(email);
  if (!user || !user.is_active || !verifyPassword(password, user.password_hash)) {
    throw appError('Invalid email or password.', 401);
  }
  return normalizeUser(user);
}

module.exports = {
  USER_ROLES,
  authenticateUser,
  createUser,
  createUserSchema,
  deactivateUser,
  getUserById,
  listApprovalUsers,
  listUsers,
  normalizeRole,
  normalizeUser,
  updateUser,
};
