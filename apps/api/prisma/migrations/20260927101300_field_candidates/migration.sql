-- docs/39 A6 — a field the contract says different things about keeps every
-- reading of it, for a person to choose the one that governs.
ALTER TABLE "contract_field_values" ADD COLUMN "candidates" JSONB;
