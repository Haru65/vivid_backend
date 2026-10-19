ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS project_name VARCHAR(255);

ALTER TABLE estimation_requests
  ADD COLUMN IF NOT EXISTS project_name VARCHAR(255);

UPDATE estimation_requests er
SET project_name = l.project_name
FROM leads l
WHERE er.lead_id = l.id
  AND er.project_name IS NULL
  AND l.project_name IS NOT NULL;
