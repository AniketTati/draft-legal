-- docs/39 G3 — a parent's value set from one of its amendments keeps which
-- contract it came from (lib/field-store.ts applyAmendmentValues).

-- AlterTable
ALTER TABLE "contract_field_values" ADD COLUMN     "fromContractId" TEXT;
