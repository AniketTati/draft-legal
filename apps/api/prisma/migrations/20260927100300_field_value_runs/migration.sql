-- docs/39 G1/D1 — bulk writes of field values (a re-analysis, a field filled
-- in across contracts), with the values before them, for a 30-day undo
-- (lib/field-runs.ts).

-- CreateTable
CREATE TABLE "field_value_runs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "contractId" TEXT,
    "fieldDefinitionId" TEXT,
    "changes" JSONB NOT NULL DEFAULT '[]',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),
    "undoneById" TEXT,

    CONSTRAINT "field_value_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "field_value_runs_orgId_kind_createdAt_idx" ON "field_value_runs"("orgId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "field_value_runs_contractId_createdAt_idx" ON "field_value_runs"("contractId", "createdAt");

-- CreateIndex
CREATE INDEX "field_value_runs_fieldDefinitionId_idx" ON "field_value_runs"("fieldDefinitionId");

-- AddForeignKey
ALTER TABLE "field_value_runs" ADD CONSTRAINT "field_value_runs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Y1 — tenant isolation, as every table with an orgId column
-- (20260924100000_tenant_row_level_security).
GRANT SELECT, INSERT, UPDATE, DELETE ON "field_value_runs" TO clm_tenant_access;
ALTER TABLE "field_value_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "field_value_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "field_value_runs"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());
