-- docs/39 B3/I2 — what the AI read before a person corrected or rejected a
-- value: each field's correction rate (computed confidence, fields needing
-- attention) and the examples the extraction learns from.

-- AlterTable
ALTER TABLE "contract_field_values" ADD COLUMN     "correctedFrom" JSONB;
