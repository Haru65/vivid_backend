ALTER TABLE estimation_quote_uploads
  ADD COLUMN IF NOT EXISTS quotation_number VARCHAR(80),
  ADD COLUMN IF NOT EXISTS revision_number INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS estimation_quote_uploads_number_idx
ON estimation_quote_uploads (quotation_number)
WHERE quotation_number IS NOT NULL;
