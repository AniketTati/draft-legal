-- docs/39 B1/G1 — the field store: one row per contract × field with the
-- value, where it came from and who checked it (lib/field-store.ts).
--
-- Existing contracts need no backfill to keep working: the store reads a
-- contract's legacy keyTerms / fieldConfidence / metadata on first touch.
-- scripts/backfill-field-values.ts fills it for every contract at once, which
-- the cross-contract Review Queue and field filters need.

-- CreateTable
CREATE TABLE "contract_field_values" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT,
    "valueType" TEXT NOT NULL,
    "value" JSONB,
    "valueText" TEXT,
    "valueNumber" DOUBLE PRECISION,
    "valueDate" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'ai',
    "confidence" DOUBLE PRECISION,
    "quote" TEXT,
    "section" TEXT,
    "issue" TEXT,
    "anchor" JSONB,
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "suggestion" JSONB,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_field_values_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contract_field_values_orgId_fieldKey_idx" ON "contract_field_values"("orgId", "fieldKey");

-- CreateIndex
CREATE INDEX "contract_field_values_orgId_verifiedAt_confidence_idx" ON "contract_field_values"("orgId", "verifiedAt", "confidence");

-- CreateIndex
CREATE UNIQUE INDEX "contract_field_values_contractId_fieldKey_key" ON "contract_field_values"("contractId", "fieldKey");

-- AddForeignKey
ALTER TABLE "contract_field_values" ADD CONSTRAINT "contract_field_values_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Y1 — tenant isolation, as every table with an orgId column
-- (20260924100000_tenant_row_level_security).
GRANT SELECT, INSERT, UPDATE, DELETE ON "contract_field_values" TO clm_tenant_access;
ALTER TABLE "contract_field_values" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contract_field_values" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "contract_field_values"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());
