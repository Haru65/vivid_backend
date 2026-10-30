CREATE TABLE IF NOT EXISTS visit_tasks (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  client_name VARCHAR(255) NOT NULL,
  company_name VARCHAR(255) NOT NULL,
  contact_number VARCHAR(30),
  location VARCHAR(500) NOT NULL,
  reason_for_visit TEXT NOT NULL,
  meeting_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'todo'
    CHECK (status IN ('todo', 'in_progress', 'completed', 'cancelled')),
  created_by_user_id BIGINT NOT NULL,
  created_by_name VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS visit_tasks_meeting_at_idx ON visit_tasks (meeting_at);
CREATE INDEX IF NOT EXISTS visit_tasks_status_idx ON visit_tasks (status);
CREATE INDEX IF NOT EXISTS visit_tasks_created_by_idx ON visit_tasks (created_by_user_id);
