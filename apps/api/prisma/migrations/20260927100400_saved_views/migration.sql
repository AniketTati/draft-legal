-- docs/39 D3 — saved views of the contracts list: filters (field filters
-- too), columns and sort, for their owner or shared with the org.

-- CreateTable
CREATE TABLE "saved_views" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "page" TEXT NOT NULL DEFAULT 'contracts',
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "query" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "saved_views_orgId_page_idx" ON "saved_views"("orgId", "page");

-- AddForeignKey
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Y1 — tenant isolation, as every table with an orgId column
-- (20260924100000_tenant_row_level_security).
GRANT SELECT, INSERT, UPDATE, DELETE ON "saved_views" TO clm_tenant_access;
ALTER TABLE "saved_views" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "saved_views" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "saved_views"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());
