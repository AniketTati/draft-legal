-- docs/41 Part 16 — what became of each AI suggestion (shown, accepted, edited, dismissed).

-- CreateTable
CREATE TABLE "ai_suggestion_events" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "versionId" TEXT,
    "userId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "suggestionId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_suggestion_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_suggestion_events_orgId_contractId_at_idx" ON "ai_suggestion_events"("orgId", "contractId", "at");

-- CreateIndex
CREATE INDEX "ai_suggestion_events_orgId_feature_outcome_idx" ON "ai_suggestion_events"("orgId", "feature", "outcome");

-- AddForeignKey
ALTER TABLE "ai_suggestion_events" ADD CONSTRAINT "ai_suggestion_events_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_suggestion_events" ADD CONSTRAINT "ai_suggestion_events_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Checked values, as the routes write them.
ALTER TABLE "ai_suggestion_events" ADD CONSTRAINT "ai_suggestion_events_feature_check"
  CHECK ("feature" IN ('ask_ai', 'counter', 'insert_standard', 'redline_to_position', 'fix_all', 'amendment_language', 'draft'));
ALTER TABLE "ai_suggestion_events" ADD CONSTRAINT "ai_suggestion_events_outcome_check"
  CHECK ("outcome" IN ('shown', 'accepted', 'edited', 'dismissed'));

-- Y1 — tenant isolation, as every table with an orgId column
-- (20260924100000_tenant_row_level_security).
GRANT SELECT, INSERT, UPDATE, DELETE ON "ai_suggestion_events" TO clm_tenant_access;
ALTER TABLE "ai_suggestion_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_suggestion_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ai_suggestion_events"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());
