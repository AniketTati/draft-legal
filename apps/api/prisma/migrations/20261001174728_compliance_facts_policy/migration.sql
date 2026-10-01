-- docs/41 Part 9 — facts that decide which compliance frameworks apply to a
-- contract, and the org's rules from facts to frameworks
-- (lib/compliance-facts.ts, lib/compliance-policy.ts).

-- CreateTable
CREATE TABLE "contract_facts" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "versionId" TEXT,
    "key" TEXT NOT NULL,
    "value" JSONB,
    "quote" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'ai',
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_policies" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "rules" JSONB NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contract_facts_orgId_idx" ON "contract_facts"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "contract_facts_contractId_key_key" ON "contract_facts"("contractId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_policies_orgId_key" ON "compliance_policies"("orgId");

-- AddForeignKey
ALTER TABLE "contract_facts" ADD CONSTRAINT "contract_facts_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_facts" ADD CONSTRAINT "contract_facts_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_policies" ADD CONSTRAINT "compliance_policies_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Y1 — tenant isolation, as every table with an orgId column
-- (20260924100000_tenant_row_level_security).
GRANT SELECT, INSERT, UPDATE, DELETE ON "contract_facts" TO clm_tenant_access;
ALTER TABLE "contract_facts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contract_facts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "contract_facts"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON "compliance_policies" TO clm_tenant_access;
ALTER TABLE "compliance_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "compliance_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "compliance_policies"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());
