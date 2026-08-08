-- Kobo -> PostgreSQL : parent + attachments
-- The unique constraints are what make the upserts idempotent.

CREATE TABLE IF NOT EXISTS kobo_submissions (
  xform_id_string  text        NOT NULL,
  submission_id    bigint      NOT NULL,
  submission_uuid  text,
  submitted_at     timestamptz,
  started_at       timestamptz,
  ended_at         timestamptz,
  latitude         double precision,
  longitude        double precision,
  altitude         double precision,
  gps_accuracy     double precision,
  answers          jsonb       NOT NULL,
  raw_submission   jsonb       NOT NULL,
  synced_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kobo_submissions_unique UNIQUE (xform_id_string, submission_id)
);

CREATE TABLE IF NOT EXISTS kobo_attachments (
  xform_id_string  text        NOT NULL,
  submission_id    bigint      NOT NULL,
  attachment_id    bigint      NOT NULL,
  filename         text,
  mimetype         text,
  download_url     text,
  raw_attachment   jsonb       NOT NULL,
  synced_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kobo_attachments_unique UNIQUE (xform_id_string, submission_id, attachment_id)
);

CREATE INDEX IF NOT EXISTS kobo_attachments_submission_idx
  ON kobo_attachments (xform_id_string, submission_id);
