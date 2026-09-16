const pool = require('../config/db_connection');

const ERP_WORKFLOW_STAGES = [
  {
    stageNumber: 10,
    stageKey: 'ga_approval',
    stageName: 'GA Approval',
    department: 'Design',
    description: 'Design prepares the General Arrangement drawing and submits it to the client for approval.',
    checklist: ['GA drawing prepared', 'GA sent to client', 'Client approval received'],
  },
  {
    stageNumber: 11,
    stageKey: 'design_change_management',
    stageName: 'Design Change Management',
    department: 'Design',
    description: 'Capture additions, deletions, or modifications after GA approval and share revised BOM/drawings for cost impact analysis.',
    checklist: ['Change request recorded', 'Revised BOM prepared', 'Revised drawings shared with estimation'],
  },
  {
    stageNumber: 12,
    stageKey: 'cost_approval_for_changes',
    stageName: 'Cost Approval for Changes',
    department: 'Estimation',
    description: 'Estimation evaluates cost impact for additions/deletions and records approval when MD and related teams approve.',
    checklist: ['Cost impact calculated', 'Approval requested', 'Cost approval completed'],
  },
  {
    stageNumber: 13,
    stageKey: 'revised_po',
    stageName: 'Revised PO',
    department: 'Sales',
    description: 'Obtain revised purchase order from the client for approved commercial changes.',
    checklist: ['Revised PO requested', 'Revised PO received', 'Revised PO verified'],
  },
  {
    stageNumber: 14,
    stageKey: 'work_order_creation',
    stageName: 'Work Order Creation',
    department: 'Operations',
    description: 'Operations generates the work order based on approved project documents.',
    checklist: ['Work order draft created', 'Approved documents attached', 'Work order issued'],
  },
  {
    stageNumber: 15,
    stageKey: 'work_order_approval',
    stageName: 'Work Order Approval',
    department: 'Management',
    description: 'Authorized management reviews and approves the work order.',
    checklist: ['Work order reviewed', 'Approval comments resolved', 'Work order approved'],
  },
  {
    stageNumber: 16,
    stageKey: 'design_release',
    stageName: 'Design Release',
    department: 'Design',
    description: 'Design uploads approved drawings and exports the data to production/process software.',
    checklist: ['Approved drawings uploaded', 'Design data exported', 'Production release confirmed'],
  },
  {
    stageNumber: 17,
    stageKey: 'production_planning',
    stageName: 'Production Planning',
    department: 'Operations',
    description: 'Operations releases the project for manufacturing and monitors progress.',
    checklist: ['Manufacturing plan created', 'Resource allocation completed', 'Production schedule released'],
  },
  {
    stageNumber: 18,
    stageKey: 'purchase',
    stageName: 'Purchase',
    department: 'Purchase',
    description: 'Purchase receives approved BOM through ERP and procures required materials.',
    checklist: ['Approved BOM received', 'Material requirement reviewed', 'Procurement completed'],
  },
  {
    stageNumber: 19,
    stageKey: 'production',
    stageName: 'Production',
    department: 'Production',
    description: 'Production performs fabrication, assembly, and wiring activities with detailed process completion tracking.',
    checklist: ['Fabrication completed', 'Assembly completed', 'Wiring completed', 'Production update posted'],
  },
  {
    stageNumber: 20,
    stageKey: 'quality_testing',
    stageName: 'Quality & Testing',
    department: 'QA/QC',
    description: 'QA/QC performs routine testing, FAT, and inspections. Test reports are generated and uploaded to CRM.',
    checklist: ['Routine testing completed', 'FAT completed', 'Inspection completed', 'Test reports uploaded'],
  },
  {
    stageNumber: 21,
    stageKey: 'dispatch_delivery',
    stageName: 'Dispatch & Delivery',
    department: 'Dispatch',
    description: 'Dispatch details, invoices, LR, and transport documents are generated and updated before material dispatch.',
    checklist: ['Dispatch details recorded', 'Invoice generated', 'LR generated', 'Transport documents uploaded', 'Material dispatched'],
  },
];

function workflowColumns(alias = 'pst') {
  return `${alias}.id, ${alias}.project_id, ${alias}.stage_number, ${alias}.stage_key, ${alias}.stage_name, ${alias}.department, ${alias}.description, ${alias}.sequence_index, ${alias}.status, ${alias}.checklist, ${alias}.notes, ${alias}.assigned_to, ${alias}.started_at, ${alias}.completed_at, ${alias}.completed_by, ${alias}.created_at, ${alias}.updated_at`;
}

function appError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function actorName(user) {
  return user?.name || 'Workspace user';
}

function requireErpUser(user) {
  const role = String(user?.role || '').toLowerCase();
  if (!['admin', 'erp'].includes(role)) throw appError('Only ERP users or admin can update ERP workflow.', 403);
}

function projectStatusForStage(stage) {
  if (!stage) return 'completed';
  if (stage.stage_number <= 16) return 'engineering';
  if (stage.stage_key === 'production_planning') return 'planning';
  if (stage.stage_key === 'purchase') return 'procurement';
  if (stage.stage_key === 'production') return 'production';
  if (stage.stage_key === 'quality_testing') return 'quality';
  if (stage.stage_key === 'dispatch_delivery') return 'ready_for_dispatch';
  return 'handover';
}

function normalizeStatus(value) {
  const status = String(value || 'pending').trim().toLowerCase();
  if (!['pending', 'in_progress', 'completed', 'blocked', 'skipped'].includes(status)) {
    throw appError('Workflow stage status is invalid.');
  }
  return status;
}

function normalizeChecklist(value) {
  if (!Array.isArray(value)) throw appError('Checklist must be an array.');
  return value.map((item, index) => {
    if (typeof item === 'string') return { label: item.trim() || `Task ${index + 1}`, completed: false };
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw appError('Checklist items must be objects.');
    const label = String(item.label || '').trim();
    if (!label) throw appError('Checklist item label is required.');
    return { ...item, label, completed: Boolean(item.completed) };
  });
}

async function syncProjectProgress(projectId, db = pool) {
  const result = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status IN ('completed', 'skipped'))::int AS done
     FROM project_stage_tasks
     WHERE project_id = $1`,
    [projectId],
  );
  const total = Number(result.rows[0]?.total || 0);
  const done = Number(result.rows[0]?.done || 0);
  const progress = total ? Math.round((done / total) * 10000) / 100 : 0;
  const currentStageResult = await db.query(
    `SELECT ${workflowColumns('pst')}
     FROM project_stage_tasks pst
     WHERE pst.project_id = $1
       AND pst.status NOT IN ('completed', 'skipped')
     ORDER BY pst.sequence_index ASC
     LIMIT 1`,
    [projectId],
  );
  const currentStage = currentStageResult.rows[0] || null;
  const status = progress >= 100 ? 'completed' : projectStatusForStage(currentStage);
  await db.query(
    `UPDATE projects
     SET overall_progress = $1,
         status = $2,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $3`,
    [progress, status, projectId],
  );
  return { progress, status, currentStage };
}

async function seedProjectWorkflow(projectId, db = pool) {
  const values = [];
  const placeholders = ERP_WORKFLOW_STAGES.map((stage, index) => {
    const offset = index * 8;
    values.push(
      projectId,
      stage.stageNumber,
      stage.stageKey,
      stage.stageName,
      stage.department,
      stage.description,
      index + 1,
      JSON.stringify(stage.checklist.map((label) => ({ label, completed: false }))),
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}::jsonb)`;
  }).join(', ');

  await db.query(
    `INSERT INTO project_stage_tasks (
      project_id,
      stage_number,
      stage_key,
      stage_name,
      department,
      description,
      sequence_index,
      checklist
    ) VALUES ${placeholders}
    ON CONFLICT (project_id, stage_key) DO NOTHING`,
    values,
  );

  return getProjectWorkflow(projectId, db);
}

async function getProjectWorkflow(projectId, db = pool) {
  const result = await db.query(
    `SELECT ${workflowColumns('pst')}
     FROM project_stage_tasks pst
     WHERE pst.project_id = $1
     ORDER BY pst.sequence_index ASC, pst.stage_number ASC`,
    [projectId],
  );
  return result.rows;
}

async function getStageForUpdate(db, projectId, stageId) {
  const result = await db.query(
    `SELECT ${workflowColumns('pst')}
     FROM project_stage_tasks pst
     WHERE pst.project_id = $1
       AND pst.id = $2
     FOR UPDATE`,
    [projectId, stageId],
  );
  const stage = result.rows[0];
  if (!stage) throw appError('Workflow stage not found.', 404);
  return stage;
}

async function updateProjectWorkflowStage(projectId, stageId, data = {}, user, db = pool) {
  requireErpUser(user);
  const client = db === pool ? await pool.connect() : db;
  const shouldManageTransaction = db === pool;
  try {
    if (shouldManageTransaction) await client.query('BEGIN');
    await getStageForUpdate(client, projectId, stageId);
    const status = data.status === undefined ? null : normalizeStatus(data.status);
    const checklist = data.checklist === undefined ? null : normalizeChecklist(data.checklist);
    const assignedTo = data.assigned_to === undefined || data.assigned_to === null ? null : String(data.assigned_to).trim() || null;
    const notes = data.notes === undefined || data.notes === null ? null : String(data.notes).trim() || null;
    const result = await client.query(
      `UPDATE project_stage_tasks
       SET status = COALESCE($1, status),
           checklist = COALESCE($2::jsonb, checklist),
           assigned_to = CASE WHEN $3::boolean THEN $4 ELSE assigned_to END,
           notes = CASE WHEN $5::boolean THEN $6 ELSE notes END,
           started_at = CASE
             WHEN COALESCE($1, status) IN ('in_progress', 'completed') AND started_at IS NULL THEN CURRENT_TIMESTAMP
             ELSE started_at
           END,
           completed_at = CASE
             WHEN COALESCE($1, status) = 'completed' THEN COALESCE(completed_at, CURRENT_TIMESTAMP)
             WHEN COALESCE($1, status) <> 'completed' THEN NULL
             ELSE completed_at
           END,
           completed_by = CASE
             WHEN COALESCE($1, status) = 'completed' THEN COALESCE(completed_by, $7)
             WHEN COALESCE($1, status) <> 'completed' THEN NULL
             ELSE completed_by
           END,
           updated_at = CURRENT_TIMESTAMP
       WHERE project_id = $8
         AND id = $9
       RETURNING ${workflowColumns('project_stage_tasks')}`,
      [
        status,
        checklist ? JSON.stringify(checklist) : null,
        data.assigned_to !== undefined,
        assignedTo,
        data.notes !== undefined,
        notes,
        actorName(user),
        projectId,
        stageId,
      ],
    );
    await syncProjectProgress(projectId, client);
    if (shouldManageTransaction) await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    if (shouldManageTransaction) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (shouldManageTransaction) client.release();
  }
}

async function completeProjectWorkflowStage(projectId, stageId, user, db = pool) {
  const stage = await updateProjectWorkflowStage(projectId, stageId, { status: 'completed' }, user, db);
  return stage;
}

module.exports = {
  ERP_WORKFLOW_STAGES,
  completeProjectWorkflowStage,
  getProjectWorkflow,
  seedProjectWorkflow,
  syncProjectProgress,
  updateProjectWorkflowStage,
};
