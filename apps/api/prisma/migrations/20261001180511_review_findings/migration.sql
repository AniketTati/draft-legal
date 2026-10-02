-- docs/41 P1 (Workstream A) — review findings per (version, baseline); where a
-- clause's words came from (fingerprint matching) and the model's position
-- verdict on it; the version an approval was submitted on.

-- AlterTable
ALTER TABLE "approval_instances" ADD COLUMN     "versionId" TEXT;

-- AlterTable
ALTER TABLE "contract_clauses" ADD COLUMN     "positionVerdict" JSONB,
ADD COLUMN     "provenance" TEXT,
ADD COLUMN     "sourceRef" TEXT;

-- CreateTable
CREATE TABLE "review_findings" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "baselineVersionId" TEXT,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "clauseType" TEXT,
    "clauseId" TEXT,
    "categoryId" TEXT,
    "positionId" TEXT,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "review_findings_orgId_contractId_idx" ON "review_findings"("orgId", "contractId");

-- CreateIndex
CREATE INDEX "review_findings_contractId_versionId_status_idx" ON "review_findings"("contractId", "versionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "review_findings_versionId_key_key" ON "review_findings"("versionId", "key");

-- AddForeignKey
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Y1 — tenant isolation, as every table with an orgId column
-- (20260924100000_tenant_row_level_security).
GRANT SELECT, INSERT, UPDATE, DELETE ON "review_findings" TO clm_tenant_access;
ALTER TABLE "review_findings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "review_findings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "review_findings"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());
