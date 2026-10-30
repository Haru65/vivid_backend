ALTER TABLE visit_tasks
ADD COLUMN IF NOT EXISTS next_activity TEXT;
