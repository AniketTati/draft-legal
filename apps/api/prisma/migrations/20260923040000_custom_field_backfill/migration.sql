-- X2: progress of a custom field's backfill over existing contracts
-- ({ status, cursor, processed, filled, failed, total, error, updatedAt }),
-- so a retried or re-pressed backfill resumes where it stopped.
ALTER TABLE "contract_field_definitions" ADD COLUMN "backfill" JSONB;
