-- docs/39 E3 — clause types an organization teaches the AI: what each is, and
-- passages that are one (lib/clause-types.ts).

-- CreateTable
CREATE TABLE "clause_type_definitions" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "examples" JSONB NOT NULL DEFAULT '[]',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "detect" JSONB,

    CONSTRAINT "clause_type_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clause_type_definitions_orgId_key_key" ON "clause_type_definitions"("orgId", "key");

-- CreateIndex
CREATE INDEX "clause_type_definitions_orgId_deletedAt_idx" ON "clause_type_definitions"("orgId", "deletedAt");

-- AddForeignKey
ALTER TABLE "clause_type_definitions" ADD CONSTRAINT "clause_type_definitions_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Y1 — tenant isolation, as every table with an orgId column
-- (20260924100000_tenant_row_level_security).
GRANT SELECT, INSERT, UPDATE, DELETE ON "clause_type_definitions" TO clm_tenant_access;
ALTER TABLE "clause_type_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clause_type_definitions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "clause_type_definitions"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());
