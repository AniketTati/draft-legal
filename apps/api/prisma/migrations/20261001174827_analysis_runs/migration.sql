-- docs/41 P1 (Workstream A) — one row per analysis of a version, with each
-- step it took (lib/analysis-runs.ts).

-- CreateTable
CREATE TABLE "analysis_runs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'full',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "steps" JSONB NOT NULL DEFAULT '[]',
    "failedStep" TEXT,
    "error" TEXT,
    "model" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analysis_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analysis_runs_orgId_status_idx" ON "analysis_runs"("orgId", "status");

-- CreateIndex
CREATE INDEX "analysis_runs_contractId_startedAt_idx" ON "analysis_runs"("contractId", "startedAt");

-- CreateIndex
CREATE INDEX "analysis_runs_versionId_idx" ON "analysis_runs"("versionId");

-- AddForeignKey
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Y1 — tenant isolation, as every table with an orgId column
-- (20260924100000_tenant_row_level_security).
GRANT SELECT, INSERT, UPDATE, DELETE ON "analysis_runs" TO clm_tenant_access;
ALTER TABLE "analysis_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "analysis_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "analysis_runs"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());
