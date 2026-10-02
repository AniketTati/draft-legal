-- docs/41 Part 1 — deterministic drafting: clause families and their
-- variants (each library clause's words kept at every version), clause slots
-- in templates, a template's published snapshot, and a default template per
-- contract type. Existing templates keep working: a section without a slot is
-- literal text, as before, and a template never published with a snapshot is
-- drafted from its rows.

-- AlterTable
ALTER TABLE "clause_library_items" ADD COLUMN     "condition" JSONB,
ADD COLUMN     "familyId" TEXT,
ADD COLUMN     "isFamilyDefault" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "matchValues" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "variantLabel" TEXT,
ADD COLUMN     "variantOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "playbook_positions" ADD COLUMN     "libraryItemId" TEXT;

-- AlterTable
ALTER TABLE "template_sections" ADD COLUMN     "slotFamilyId" TEXT;

-- AlterTable
ALTER TABLE "templates" ADD COLUMN     "hasUnpublishedChanges" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isDefaultForType" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publishedVersionId" TEXT;

-- CreateTable
CREATE TABLE "template_versions" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "lint" JSONB NOT NULL DEFAULT '[]',
    "publishedById" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clause_families" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "categoryId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "requestKey" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "clause_families_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clause_library_versions" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "variantLabel" TEXT,
    "condition" JSONB,
    "matchValues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clause_library_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "template_versions_orgId_templateId_idx" ON "template_versions"("orgId", "templateId");

-- CreateIndex
CREATE UNIQUE INDEX "template_versions_templateId_version_key" ON "template_versions"("templateId", "version");

-- CreateIndex
CREATE INDEX "clause_families_orgId_deletedAt_idx" ON "clause_families"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX "clause_library_versions_orgId_idx" ON "clause_library_versions"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "clause_library_versions_itemId_version_key" ON "clause_library_versions"("itemId", "version");

-- CreateIndex
CREATE INDEX "clause_library_items_familyId_idx" ON "clause_library_items"("familyId");

-- AddForeignKey
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_sections" ADD CONSTRAINT "template_sections_slotFamilyId_fkey" FOREIGN KEY ("slotFamilyId") REFERENCES "clause_families"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clause_library_items" ADD CONSTRAINT "clause_library_items_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "clause_families"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clause_families" ADD CONSTRAINT "clause_families_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clause_families" ADD CONSTRAINT "clause_families_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "clause_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clause_library_versions" ADD CONSTRAINT "clause_library_versions_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clause_library_versions" ADD CONSTRAINT "clause_library_versions_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "clause_library_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playbook_positions" ADD CONSTRAINT "playbook_positions_libraryItemId_fkey" FOREIGN KEY ("libraryItemId") REFERENCES "clause_library_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One live default variant per family, and one default template per org and
-- contract type. Partial: deleted rows and non-defaults don't count.
CREATE UNIQUE INDEX "clause_library_items_one_family_default" ON "clause_library_items"("familyId") WHERE "isFamilyDefault" AND "deletedAt" IS NULL AND "familyId" IS NOT NULL;
CREATE UNIQUE INDEX "templates_one_default_per_type" ON "templates"("orgId", "contractType") WHERE "isDefaultForType" AND "deletedAt" IS NULL;

-- Every existing library clause's current words become its version 1.
INSERT INTO "clause_library_versions" ("id", "orgId", "itemId", "version", "title", "content", "createdById", "createdAt", "note")
SELECT 'clv_' || md5(i."id" || ':1'), i."orgId", i."id", 1, i."title", i."content", i."createdById", i."createdAt", 'Version when versions began'
FROM "clause_library_items" i;

-- Y1 — tenant isolation, as every table with an orgId column
-- (20260924100000_tenant_row_level_security).
GRANT SELECT, INSERT, UPDATE, DELETE ON "clause_families" TO clm_tenant_access;
ALTER TABLE "clause_families" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clause_families" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "clause_families"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON "clause_library_versions" TO clm_tenant_access;
ALTER TABLE "clause_library_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clause_library_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "clause_library_versions"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON "template_versions" TO clm_tenant_access;
ALTER TABLE "template_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "template_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "template_versions"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());
