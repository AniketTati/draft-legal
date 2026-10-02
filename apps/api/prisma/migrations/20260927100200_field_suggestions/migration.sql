-- docs/39 C3 — fields someone asked for from a highlight, for an admin to add
-- or decline (routes/field-suggestions.ts).

-- CreateTable
CREATE TABLE "field_suggestions" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "fieldType" TEXT NOT NULL,
    "contractType" TEXT,
    "helpText" TEXT,
    "exampleContractId" TEXT,
    "exampleQuote" TEXT,
    "exampleValue" JSONB,
    "suggestedById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "reason" TEXT,
    "fieldDefinitionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "field_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "field_suggestions_orgId_status_idx" ON "field_suggestions"("orgId", "status");

-- AddForeignKey
ALTER TABLE "field_suggestions" ADD CONSTRAINT "field_suggestions_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Y1 — tenant isolation, as every table with an orgId column
-- (20260924100000_tenant_row_level_security).
GRANT SELECT, INSERT, UPDATE, DELETE ON "field_suggestions" TO clm_tenant_access;
ALTER TABLE "field_suggestions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "field_suggestions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "field_suggestions"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());
