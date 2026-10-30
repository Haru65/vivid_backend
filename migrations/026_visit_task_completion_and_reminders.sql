ALTER TABLE visit_tasks
  ADD COLUMN IF NOT EXISTS completion_latitude NUMERIC(10, 7),
  ADD COLUMN IF NOT EXISTS completion_longitude NUMERIC(10, 7),
  ADD COLUMN IF NOT EXISTS completion_accuracy_m NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS task_planning_reminders (
  id SERIAL PRIMARY KEY,
  recipient_user_id BIGINT NOT NULL,
  week_start DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (recipient_user_id, week_start)
);
