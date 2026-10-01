-- docs/41 P1 (Part 3) — a Playbook: a named set of positions for the contract
-- types it covers, with a default per type (lib/playbooks.ts).

-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "playbookId" TEXT;

-- AlterTable
ALTER TABLE "playbook_positions" ADD COLUMN     "playbookId" TEXT;

-- CreateTable
CREATE TABLE "playbooks" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "contractTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isDefaultForType" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "playbooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "playbooks_orgId_idx" ON "playbooks"("orgId");

-- CreateIndex
CREATE INDEX "playbook_positions_playbookId_idx" ON "playbook_positions"("playbookId");

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_playbookId_fkey" FOREIGN KEY ("playbookId") REFERENCES "playbooks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playbook_positions" ADD CONSTRAINT "playbook_positions_playbookId_fkey" FOREIGN KEY ("playbookId") REFERENCES "playbooks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Y1 — tenant isolation, as every table with an orgId column
-- (20260924100000_tenant_row_level_security).
GRANT SELECT, INSERT, UPDATE, DELETE ON "playbooks" TO clm_tenant_access;
ALTER TABLE "playbooks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "playbooks" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "playbooks"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

-- Every org's existing positions move under one "Default playbook", the
-- default for every type: what each review already used.
INSERT INTO "playbooks" ("id", "orgId", "name", "contractTypes", "isDefaultForType", "version", "createdAt", "updatedAt")
SELECT 'pb' || substr(md5(o."id" || clock_timestamp()::text), 1, 23), o."id", 'Default playbook', ARRAY[]::TEXT[], true, 1, now(), now()
FROM "organizations" o
WHERE EXISTS (SELECT 1 FROM "playbook_positions" p WHERE p."orgId" = o."id")
  AND NOT EXISTS (SELECT 1 FROM "playbooks" b WHERE b."orgId" = o."id");

UPDATE "playbook_positions" p
SET "playbookId" = b."id"
FROM "playbooks" b
WHERE b."orgId" = p."orgId" AND b."name" = 'Default playbook' AND p."playbookId" IS NULL;
