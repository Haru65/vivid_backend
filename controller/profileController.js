const pool = require('../config/db_connection');
const { hashPassword, verifyPassword } = require('./userManagement');

function profileError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name) throw profileError('Name is required.');
  if (name.length > 200) throw profileError('Name is too long.');
  const [firstName, ...lastNameParts] = name.split(' ');
  return { firstName, lastName: lastNameParts.join(' ') || null };
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw profileError('Enter a valid email address.');
  if (email.length > 255) throw profileError('Email is too long.');
  return email;
}

function normalizePhone(value) {
  const phone = String(value || '').trim();
  if (phone.length > 20) throw profileError('Phone number is too long.');
  return phone || null;
}

async function updateProfile(req, res) {
  try {
    if (String(req.user?.id || '') !== String(req.params.userId || '')) {
      throw profileError('You can only update your own profile.', 403);
    }

    const { firstName, lastName } = normalizeName(req.body.name);
    const email = normalizeEmail(req.body.email);
    const phone = normalizePhone(req.body.phone);
    const newPassword = String(req.body.password || '');
    let passwordHash = null;

    if (newPassword) {
      const currentPassword = String(req.body.current_password || '');
      if (!currentPassword) throw profileError('Current password is required to set a new password.');
      const existingResult = await pool.query(
        'SELECT password_hash FROM users WHERE id = $1 AND is_active = TRUE',
        [req.user.id],
      );
      const existingUser = existingResult.rows[0];
      if (!existingUser) throw profileError('User profile not found.', 404);
      if (!verifyPassword(currentPassword, existingUser.password_hash)) {
        throw profileError('Current password is incorrect.', 401);
      }
      passwordHash = hashPassword(newPassword);
    }

    const result = await pool.query(
      `UPDATE users
       SET first_name = $1,
           last_name = $2,
           email = $3,
           phone = $4,
           password_hash = COALESCE($5, password_hash),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6 AND is_active = TRUE
       RETURNING id, first_name, last_name, email, phone, role, department,
                 designation, employee_code, is_active, manager_id, created_at, updated_at`,
      [firstName, lastName, email, phone, passwordHash, req.user.id],
    );

    const user = result.rows[0];
    if (!user) throw profileError('User profile not found.', 404);
    return res.json({
      ...user,
      last_name: user.last_name || '',
      name: [user.first_name, user.last_name].filter(Boolean).join(' '),
      phone: user.phone || '',
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    const status = error.statusCode || (error.code === '23505' ? 409 : 500);
    const message = error.statusCode
      ? error.message
      : error.code === '23505'
        ? 'That email address is already in use.'
        : 'Unable to update profile.';
    return res.status(status).json({ error: message });
  }
}

module.exports = { updateProfile };
