ALTER TABLE visit_tasks
ADD COLUMN IF NOT EXISTS priority VARCHAR(20) NOT NULL DEFAULT 'normal',
ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

ALTER TABLE visit_tasks DROP CONSTRAINT IF EXISTS visit_tasks_priority_check;
ALTER TABLE visit_tasks ADD CONSTRAINT visit_tasks_priority_check
  CHECK (priority IN ('low', 'normal', 'high', 'urgent'));

CREATE INDEX IF NOT EXISTS visit_tasks_planning_idx
  ON visit_tasks (created_by_user_id, sort_order, meeting_at);
