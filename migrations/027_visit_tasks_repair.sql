-- Visit task database repair and access migration.
--
-- Run this ONCE as the current owner of public.visit_tasks (or as a PostgreSQL
-- superuser). Replace `vivid_app` with the username from DATABASE_URL used by
-- the Node backend:
--
--   psql "$DATABASE_URL_AS_TABLE_OWNER" -v app_role='vivid_app' \
--     -f migrations/027_visit_tasks_repair.sql
--
-- The application role must own the task tables because the backend performs
-- safe startup schema upgrades. The GRANT statements also repair existing
-- installations where this table was created by a different database role.

\if :{?app_role}
\else
  \echo 'Missing app_role. Example: psql ... -v app_role=vivid_app -f migrations/027_visit_tasks_repair.sql'
  \quit
\endif

BEGIN;

CREATE TABLE IF NOT EXISTS public.visit_tasks (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  client_name VARCHAR(255) NOT NULL,
  company_name VARCHAR(255) NOT NULL,
  contact_number VARCHAR(30),
  location VARCHAR(500) NOT NULL,
  reason_for_visit TEXT NOT NULL,
  meeting_at TIMESTAMPTZ NOT NULL,
  all_day BOOLEAN NOT NULL DEFAULT FALSE,
  review TEXT,
  remark TEXT,
  next_activity TEXT,
  completion_latitude NUMERIC(10, 7),
  completion_longitude NUMERIC(10, 7),
  completion_accuracy_m NUMERIC(10, 2),
  completed_at TIMESTAMPTZ,
  priority VARCHAR(20) NOT NULL DEFAULT 'normal',
  sort_order INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'todo',
  created_by_user_id BIGINT NOT NULL,
  created_by_name VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE public.visit_tasks
  ADD COLUMN IF NOT EXISTS all_day BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS review TEXT,
  ADD COLUMN IF NOT EXISTS remark TEXT,
  ADD COLUMN IF NOT EXISTS next_activity TEXT,
  ADD COLUMN IF NOT EXISTS completion_latitude NUMERIC(10, 7),
  ADD COLUMN IF NOT EXISTS completion_longitude NUMERIC(10, 7),
  ADD COLUMN IF NOT EXISTS completion_accuracy_m NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS priority VARCHAR(20) NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.visit_tasks DROP CONSTRAINT IF EXISTS visit_tasks_priority_check;
ALTER TABLE public.visit_tasks ADD CONSTRAINT visit_tasks_priority_check
  CHECK (priority IN ('low', 'normal', 'high', 'urgent'));

CREATE INDEX IF NOT EXISTS visit_tasks_meeting_at_idx ON public.visit_tasks (meeting_at);
CREATE INDEX IF NOT EXISTS visit_tasks_status_idx ON public.visit_tasks (status);
CREATE INDEX IF NOT EXISTS visit_tasks_created_by_idx ON public.visit_tasks (created_by_user_id);
CREATE INDEX IF NOT EXISTS visit_tasks_planning_idx ON public.visit_tasks (created_by_user_id, sort_order, meeting_at);

CREATE TABLE IF NOT EXISTS public.task_planning_reminders (
  id SERIAL PRIMARY KEY,
  recipient_user_id BIGINT NOT NULL,
  week_start DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (recipient_user_id, week_start)
);

-- Make the backend role the permanent owner, so later safe schema checks do
-- not fail with "must be owner of table visit_tasks".
ALTER TABLE public.visit_tasks OWNER TO :"app_role";
ALTER SEQUENCE IF EXISTS public.visit_tasks_id_seq OWNER TO :"app_role";
ALTER TABLE public.task_planning_reminders OWNER TO :"app_role";
ALTER SEQUENCE IF EXISTS public.task_planning_reminders_id_seq OWNER TO :"app_role";

GRANT USAGE ON SCHEMA public TO :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.visit_tasks TO :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.task_planning_reminders TO :"app_role";
GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.visit_tasks_id_seq TO :"app_role";
GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.task_planning_reminders_id_seq TO :"app_role";

COMMIT;
