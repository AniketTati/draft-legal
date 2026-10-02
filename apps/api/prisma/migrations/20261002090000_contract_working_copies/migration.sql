-- docs/41 Part 16 (C1) — the editor's autosaved changes, kept apart from
-- versions (lib/working-copy.ts). One per contract.

-- CreateTable
CREATE TABLE "contract_working_copies" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "baseVersionId" TEXT,
    "html" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_working_copies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contract_working_copies_contractId_key" ON "contract_working_copies"("contractId");

-- CreateIndex
CREATE INDEX "contract_working_copies_orgId_idx" ON "contract_working_copies"("orgId");

-- AddForeignKey
ALTER TABLE "contract_working_copies" ADD CONSTRAINT "contract_working_copies_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_working_copies" ADD CONSTRAINT "contract_working_copies_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Y1 — tenant isolation, as every table with an orgId column
-- (20260924100000_tenant_row_level_security).
GRANT SELECT, INSERT, UPDATE, DELETE ON "contract_working_copies" TO clm_tenant_access;
ALTER TABLE "contract_working_copies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contract_working_copies" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "contract_working_copies"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());
