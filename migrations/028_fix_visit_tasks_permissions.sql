-- Fix permissions for visit_tasks and task_planning_reminders tables
-- This repairs the ownership and grants necessary to the vivid role
--
-- Run this as the database owner or superuser:
--   psql "$DATABASE_URL" -f migrations/028_fix_visit_tasks_permissions.sql

BEGIN;

-- Transfer ownership to the application role
ALTER TABLE public.visit_tasks OWNER TO vivid;
ALTER SEQUENCE IF EXISTS public.visit_tasks_id_seq OWNER TO vivid;
ALTER TABLE public.task_planning_reminders OWNER TO vivid;
ALTER SEQUENCE IF EXISTS public.task_planning_reminders_id_seq OWNER TO vivid;

-- Grant schema usage
GRANT USAGE ON SCHEMA public TO vivid;

-- Grant table permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.visit_tasks TO vivid;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.task_planning_reminders TO vivid;

-- Grant sequence permissions
GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.visit_tasks_id_seq TO vivid;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.task_planning_reminders_id_seq TO vivid;

COMMIT;
