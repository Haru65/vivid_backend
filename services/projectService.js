const pool = require('../config/db_connection');
const { getProjectWorkflow, seedProjectWorkflow } = require('./projectWorkflowService');

function appError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function actorName(user) {
  return user?.name || 'Workspace user';
}

async function generateProjectNumber(client) {
  const sequence = await client.query(`SELECT nextval('project_number_seq') AS number`);
  return `PRJ-${new Date().getFullYear()}-${String(sequence.rows[0].number).padStart(4, '0')}`;
}

async function createProjectFromHandover(client, handover, user, data = {}) {
  const existing = await client.query(
    'SELECT id, project_number FROM projects WHERE handover_id = $1',
    [handover.id],
  );
  if (existing.rows[0]) {
    const error = appError(`Project ${existing.rows[0].project_number} already exists for this handover.`, 409);
    error.project = existing.rows[0];
    throw error;
  }

  const projectNumber = await generateProjectNumber(client);
  const snapshot = handover.snapshot || {};
  const result = await client.query(
    `INSERT INTO projects (
      project_number,
      handover_id,
      customer_id,
      lead_id,
      quotation_id,
      sales_order_id,
      project_name,
      customer_po_number,
      order_value,
      order_date,
      promised_delivery_date,
      project_manager_name,
      priority,
      status,
      handover_snapshot,
      created_by_name,
      created_by_role
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'handover', $14, $15, $16)
    RETURNING *`,
    [
      projectNumber,
      handover.id,
      handover.customer_id,
      handover.lead_id,
      handover.quotation_id,
      handover.sales_order_id,
      handover.project_name || snapshot.technical?.project_name || `Project ${handover.handover_number}`,
      handover.customer_po_number || snapshot.order?.customer_po_number || null,
      snapshot.order?.order_value || snapshot.quotation?.final_value || 0,
      handover.customer_po_date || snapshot.order?.po_date || null,
      handover.requested_delivery_date || snapshot.delivery?.requested_delivery_date || null,
      data.project_manager_name || data.project_manager_id || null,
      handover.priority || 'normal',
      JSON.stringify(snapshot),
      actorName(user),
      user?.role || null,
    ],
  );
  const project = result.rows[0];
  await seedProjectWorkflow(project.id, client);
  return project;
}

async function listProjects(user) {
  const result = await pool.query(
    `SELECT p.*, h.handover_number, c.company_name,
       COUNT(pst.id)::int AS workflow_stage_count,
       COUNT(pst.id) FILTER (WHERE pst.status = 'completed')::int AS completed_stage_count,
       (
         SELECT json_build_object(
           'stage_number', current_stage.stage_number,
           'stage_key', current_stage.stage_key,
           'stage_name', current_stage.stage_name,
           'department', current_stage.department,
           'status', current_stage.status
         )
         FROM project_stage_tasks current_stage
         WHERE current_stage.project_id = p.id
           AND current_stage.status <> 'completed'
         ORDER BY current_stage.sequence_index ASC
         LIMIT 1
       ) AS current_workflow_stage
     FROM projects p
     LEFT JOIN crm_erp_handovers h ON h.id = p.handover_id
     LEFT JOIN customers c ON c.id = p.customer_id
     LEFT JOIN project_stage_tasks pst ON pst.project_id = p.id
     GROUP BY p.id, h.handover_number, c.company_name
     ORDER BY p.created_at DESC, p.id DESC`,
  );
  return result.rows;
}

async function getProject(id, user) {
  const result = await pool.query(
    `SELECT p.*, h.handover_number, h.snapshot, c.company_name
     FROM projects p
     LEFT JOIN crm_erp_handovers h ON h.id = p.handover_id
     LEFT JOIN customers c ON c.id = p.customer_id
     WHERE p.id = $1`,
    [id],
  );
  const project = result.rows[0];
  if (!project) throw appError('Project not found.', 404);
  return {
    ...project,
    workflow: await getProjectWorkflow(project.id),
  };
}

async function ensureProjectWorkflow(id, user) {
  const project = await getProject(id, user);
  if (project.workflow.length) return project.workflow;
  return seedProjectWorkflow(project.id);
}

async function getWorkflowForProject(id, user) {
  const project = await getProject(id, user);
  if (project.workflow.length) return project.workflow;
  return seedProjectWorkflow(project.id);
}

module.exports = {
  createProjectFromHandover,
  ensureProjectWorkflow,
  generateProjectNumber,
  getProject,
  getWorkflowForProject,
  listProjects,
};
