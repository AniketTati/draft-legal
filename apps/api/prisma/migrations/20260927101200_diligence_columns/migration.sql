-- docs/39 D6 — a diligence room's own columns: a field, or a question asked of
-- every document, with each answer and the words it came from
-- (lib/diligence-columns.ts).

-- AlterTable
ALTER TABLE "diligence_rooms" ADD COLUMN "columns" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "diligence_cells" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "columnId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "value" JSONB,
    "display" TEXT,
    "quote" TEXT,
    "confidence" DOUBLE PRECISION,
    "issue" TEXT,
    "error" TEXT,
    "answeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'ai',
    "checkedById" TEXT,
    "checkedAt" TIMESTAMP(3),

    CONSTRAINT "diligence_cells_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "diligence_cells_roomId_columnId_contractId_key" ON "diligence_cells"("roomId", "columnId", "contractId");

-- CreateIndex
CREATE INDEX "diligence_cells_orgId_idx" ON "diligence_cells"("orgId");

-- AddForeignKey
ALTER TABLE "diligence_cells" ADD CONSTRAINT "diligence_cells_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diligence_cells" ADD CONSTRAINT "diligence_cells_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "diligence_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Y1 — tenant isolation, as every table with an orgId column
-- (20260924100000_tenant_row_level_security).
GRANT SELECT, INSERT, UPDATE, DELETE ON "diligence_cells" TO clm_tenant_access;
ALTER TABLE "diligence_cells" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "diligence_cells" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "diligence_cells"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());
