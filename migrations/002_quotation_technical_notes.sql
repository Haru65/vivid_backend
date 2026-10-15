ALTER TABLE quotations
ADD COLUMN IF NOT EXISTS technical_notes_data JSONB NOT NULL DEFAULT '[]'::jsonb;
