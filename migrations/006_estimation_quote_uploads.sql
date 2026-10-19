CREATE TABLE IF NOT EXISTS estimation_quote_uploads (
  id SERIAL PRIMARY KEY,
  estimation_request_id INTEGER NOT NULL UNIQUE,
  filename VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL DEFAULT 'application/pdf',
  file_size INTEGER NOT NULL CHECK (file_size > 0),
  quote_value NUMERIC(14, 2) NOT NULL CHECK (quote_value > 0),
  pdf_data BYTEA NOT NULL,
  uploaded_by_user_id BIGINT,
  uploaded_by_name VARCHAR(255) NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS estimation_quote_uploads_request_idx
ON estimation_quote_uploads (estimation_request_id);
