const pool = require('../config/db_connection');
const { notifyRole, notifyUserId } = require('../services/notificationService');

const TASK_COLUMNS = `
  id,
  customer_id,
  client_name,
  company_name,
  contact_number,
  location,
  reason_for_visit,
  meeting_at,
  all_day,
  review,
  remark,
  next_activity,
  completion_latitude,
  completion_longitude,
  completion_accuracy_m,
  completed_at,
  priority,
  sort_order,
  status,
  created_by_user_id,
  created_by_name,
  created_at,
  updated_at
`;

const TASK_STATUSES = new Set(['todo', 'in_progress', 'completed', 'cancelled']);
const TASK_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const TASK_MANAGER_ROLES = new Set(['admin', 'sales_head']);

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requiredText(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw httpError(`${field} is required.`);
  const result = value.trim();
  if (result.length > maxLength) throw httpError(`${field} is too long.`);
  return result;
}

function optionalText(value, field, maxLength) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw httpError(`${field} must be text.`);
  const result = value.trim();
  if (result.length > maxLength) throw httpError(`${field} is too long.`);
  return result || null;
}

function customerId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw httpError('Choose a valid customer.');
  return id;
}

function taskPriority(value, fallback = 'normal') {
  const priority = value || fallback;
  if (!TASK_PRIORITIES.has(priority)) throw httpError('Task priority is invalid.');
  return priority;
}

function taskOrder(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const order = Number(value);
  if (!Number.isSafeInteger(order) || order < 0 || order > 9999) throw httpError('Visit order must be between 0 and 9999.');
  return order;
}

function futureTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) throw httpError('Meeting date and time is required.');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw httpError('Meeting date and time is invalid.');
  if (date <= new Date()) throw httpError('Meeting date and time must be in the future.');
  return date.toISOString();
}

function completionLocation(data = {}) {
  const latitude = Number(data.latitude);
  const longitude = Number(data.longitude);
  const accuracy = Number(data.accuracy_m);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw httpError('A valid completion latitude is required.');
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw httpError('A valid completion longitude is required.');
  if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000) throw httpError('A valid GPS accuracy is required.');
  return { latitude, longitude, accuracy };
}

function taskNotification(task, title, body, category = 'task') {
  return { title, body, category, link_type: 'task', link_id: task.id, metadata: { task_id: task.id } };
}

async function canonicalCustomer(id) {
  const result = await pool.query(
    `SELECT id, company_name, contact_person_name, contact_person_phone
     FROM customers
     WHERE id = $1`,
    [id],
  );
  if (!result.rows[0]) throw httpError('Customer not found.', 404);
  if (!result.rows[0].contact_person_name) throw httpError('The selected customer does not have a client contact.');
  return result.rows[0];
}

function isTaskOwner(task, user) {
  return String(task?.created_by_user_id || '') === String(user?.id || '');
}

function roleOf(user) {
  return String(user?.role || '').trim().toLowerCase();
}

function canEditTask(task, user) {
  return isTaskOwner(task, user);
}

function canManageTaskSchedule(task, user) {
  return TASK_MANAGER_ROLES.has(roleOf(user)) || isTaskOwner(task, user);
}

async function retrieveTasks(user) {
  const canViewAll = TASK_MANAGER_ROLES.has(roleOf(user));
  const result = await pool.query(
    `SELECT ${TASK_COLUMNS}
     FROM visit_tasks
     WHERE ($1::boolean = TRUE OR created_by_user_id = $2)
     ORDER BY
       CASE status WHEN 'todo' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'completed' THEN 3 ELSE 4 END,
       sort_order ASC,
       meeting_at ASC,
       id ASC`,
    [canViewAll, user.id],
  );
  return result.rows;
}

async function retrieveTask(id) {
  const result = await pool.query(`SELECT ${TASK_COLUMNS} FROM visit_tasks WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

async function createTask(data, user) {
  const selectedCustomer = await canonicalCustomer(customerId(data.customer_id));
  const location = requiredText(data.location, 'Location', 500);
  const reason = requiredText(data.reason_for_visit, 'Reason for visit', 5000);
  const meetingAt = futureTimestamp(data.meeting_at);
  const orderResult = await pool.query(
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM visit_tasks WHERE created_by_user_id = $1',
    [user.id],
  );
  const sortOrder = Number(orderResult.rows[0]?.next_order) || 1;
  const result = await pool.query(
    `INSERT INTO visit_tasks (
       customer_id, client_name, company_name, contact_number, location,
       reason_for_visit, meeting_at, all_day, priority, sort_order, status, created_by_user_id, created_by_name
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'todo', $11, $12)
     RETURNING ${TASK_COLUMNS}`,
    [selectedCustomer.id, selectedCustomer.contact_person_name, selectedCustomer.company_name,
      selectedCustomer.contact_person_phone || null, location, reason, meetingAt,
      data.all_day === true, taskPriority(data.priority), sortOrder, user.id, user.name],
  );
  return result.rows[0];
}

async function updateTask(id, data, user) {
  const existing = await retrieveTask(id);
  if (!existing) return null;
  if (!canEditTask(existing, user)) throw httpError('Managers may only reschedule or cancel another engineer’s task.', 403);
  const selectedCustomer = await canonicalCustomer(customerId(data.customer_id));
  const status = data.status || existing.status;
  if (!TASK_STATUSES.has(status)) throw httpError('Task status is invalid.');
  const result = await pool.query(
    `UPDATE visit_tasks
     SET customer_id = $1,
         client_name = $2,
         company_name = $3,
         contact_number = $4,
         location = $5,
         reason_for_visit = $6,
         meeting_at = $7,
         all_day = $8,
         status = $9,
         priority = $10,
         sort_order = $11,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $12
     RETURNING ${TASK_COLUMNS}`,
    [selectedCustomer.id, selectedCustomer.contact_person_name, selectedCustomer.company_name,
      selectedCustomer.contact_person_phone || null,
      requiredText(data.location, 'Location', 500),
      requiredText(data.reason_for_visit, 'Reason for visit', 5000),
      futureTimestamp(data.meeting_at), data.all_day === true, status, taskPriority(data.priority, existing.priority),
      taskOrder(data.sort_order, existing.sort_order), id],
  );
  return result.rows[0];
}

async function updateTaskStatus(id, status, user) {
  const existing = await retrieveTask(id);
  if (!existing) return null;
  if (!canManageTaskSchedule(existing, user)) throw httpError('You can only update tasks you created.', 403);
  if (TASK_MANAGER_ROLES.has(roleOf(user)) && !isTaskOwner(existing, user) && status !== 'cancelled') {
    throw httpError('Managers may only cancel another engineer’s task.', 403);
  }
  if (!TASK_STATUSES.has(status)) throw httpError('Task status is invalid.');
  const result = await pool.query(
    `UPDATE visit_tasks SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING ${TASK_COLUMNS}`,
    [status, id],
  );
  return result.rows[0];
}

async function updateTaskReview(id, data, user) {
  const existing = await retrieveTask(id);
  if (!existing) return null;
  if (!canEditTask(existing, user)) throw httpError('Managers cannot edit another engineer’s task details.', 403);
  if (data.status === 'completed' && existing.status !== 'completed') throw httpError('Complete a visit using GPS location capture.', 400);
  const status = data.status || existing.status;
  if (!TASK_STATUSES.has(status)) throw httpError('Task status is invalid.');
  const result = await pool.query(
    `UPDATE visit_tasks
     SET review = $1,
         remark = $2,
         next_activity = $3,
         status = $4,
         priority = $5,
         sort_order = $6,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $7
     RETURNING ${TASK_COLUMNS}`,
    [optionalText(data.review, 'Review', 5000), optionalText(data.remark, 'Remark', 5000),
      optionalText(data.next_activity, 'Next activity', 5000), status,
      taskPriority(data.priority, existing.priority), taskOrder(data.sort_order, existing.sort_order), id],
  );
  return result.rows[0];
}

async function rescheduleTask(id, data, user) {
  const existing = await retrieveTask(id);
  if (!existing) return null;
  if (!canManageTaskSchedule(existing, user)) {
    throw httpError('Only the assigned Sales Engineer or a Sales Manager can reschedule this task.', 403);
  }
  if (existing.status === 'cancelled') throw httpError('A cancelled task cannot be rescheduled.', 409);
  const meetingAt = futureTimestamp(data?.meeting_at);
  const allDay = data?.all_day === true;
  const result = await pool.query(
    `UPDATE visit_tasks
     SET meeting_at = $1,
         all_day = $2,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $3 AND status <> 'cancelled'
     RETURNING ${TASK_COLUMNS}`,
    [meetingAt, allDay, id],
  );
  if (!result.rows[0]) throw httpError('This task was cancelled before it could be rescheduled.', 409);
  const saved = result.rows[0];
  if (!isTaskOwner(existing, user)) {
    await notifyUserId(existing.created_by_user_id, taskNotification(saved, 'Visit rescheduled', `${user.name || 'Sales manager'} rescheduled your visit with ${saved.company_name}.`));
  }
  return saved;
}

async function completeTask(id, data, user) {
  const existing = await retrieveTask(id);
  if (!existing) return null;
  if (!isTaskOwner(existing, user)) throw httpError('Only the assigned Sales Engineer can complete this task.', 403);
  if (existing.status === 'cancelled') throw httpError('A cancelled task cannot be completed.', 409);
  const location = completionLocation(data);
  const result = await pool.query(
    `UPDATE visit_tasks
     SET status = 'completed',
         completion_latitude = $1,
         completion_longitude = $2,
         completion_accuracy_m = $3,
         completed_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $4 AND status <> 'cancelled'
     RETURNING ${TASK_COLUMNS}`,
    [location.latitude, location.longitude, location.accuracy, id],
  );
  if (!result.rows[0]) throw httpError('This task was cancelled before it could be completed.', 409);
  const saved = result.rows[0];
  const notice = taskNotification(saved, 'Sales visit completed', `${user.name || saved.created_by_name} completed ${saved.company_name}. GPS location was captured.`);
  await Promise.all([notifyRole('sales_head', notice), notifyRole('admin', notice)]);
  return saved;
}

async function deleteTask(id, user) {
  const existing = await retrieveTask(id);
  if (!existing) return null;
  if (!canEditTask(existing, user)) throw httpError('Managers cannot delete another engineer’s task. Cancel it instead.', 403);
  const result = await pool.query('DELETE FROM visit_tasks WHERE id = $1 RETURNING id', [id]);
  return result.rows[0] || null;
}

module.exports = { retrieveTasks, createTask, updateTask, updateTaskStatus, updateTaskReview, rescheduleTask, completeTask, deleteTask };
