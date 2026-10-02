-- docs/39 A12 — an exhibit or schedule attached to a contract, read: its text
-- goes into the contract's analysis, a value quoted from it is placed in it,
-- and search finds it (lib/exhibits.ts).

-- CreateTable
CREATE TABLE "contract_exhibits" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "pageCount" INTEGER,
    "ocrApplied" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_exhibits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contract_exhibits_contractId_s3Key_key" ON "contract_exhibits"("contractId", "s3Key");

-- CreateIndex
CREATE INDEX "contract_exhibits_orgId_idx" ON "contract_exhibits"("orgId");

-- AddForeignKey
ALTER TABLE "contract_exhibits" ADD CONSTRAINT "contract_exhibits_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_exhibits" ADD CONSTRAINT "contract_exhibits_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Y1 — tenant isolation, as every table with an orgId column
-- (20260924100000_tenant_row_level_security).
GRANT SELECT, INSERT, UPDATE, DELETE ON "contract_exhibits" TO clm_tenant_access;
ALTER TABLE "contract_exhibits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contract_exhibits" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "contract_exhibits"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());
