-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "amendmentNumber" INTEGER,
ADD COLUMN     "noticeDays" INTEGER,
ADD COLUMN     "noticeDeadline" TIMESTAMP(3),
ADD COLUMN     "optOutWindowStart" TIMESTAMP(3),
ADD COLUMN     "priceUpliftCap" DOUBLE PRECISION,
ADD COLUMN     "renewalConfirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "renewalTermMonths" INTEGER,
ADD COLUMN     "renewalType" TEXT;

-- AlterTable
ALTER TABLE "obligations" ADD COLUMN     "supersededAt" TIMESTAMP(3),
ADD COLUMN     "supersededById" TEXT;

-- CreateTable
CREATE TABLE "contract_term_values" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT,
    "value" JSONB,
    "display" TEXT NOT NULL DEFAULT '',
    "quote" TEXT,
    "sourceContractId" TEXT,
    "effectiveFrom" TIMESTAMP(3),
    "supersededById" TEXT,
    "supersededAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_term_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "renewal_decisions" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "decidedById" TEXT NOT NULL,
    "reason" TEXT,
    "actionContractId" TEXT,
    "noticeDeadline" TIMESTAMP(3),
    "decidedInTime" BOOLEAN,
    "noticeSentAt" TIMESTAMP(3),
    "noticeSentInTime" BOOLEAN,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "renewal_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_watchers" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_watchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_feeds" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_feeds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contract_term_values_orgId_contractId_key_idx" ON "contract_term_values"("orgId", "contractId", "key");

-- CreateIndex
CREATE INDEX "contract_term_values_sourceContractId_idx" ON "contract_term_values"("sourceContractId");

-- CreateIndex
CREATE INDEX "renewal_decisions_orgId_contractId_idx" ON "renewal_decisions"("orgId", "contractId");

-- CreateIndex
CREATE INDEX "renewal_decisions_orgId_createdAt_idx" ON "renewal_decisions"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "contract_watchers_orgId_userId_idx" ON "contract_watchers"("orgId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "contract_watchers_contractId_userId_key" ON "contract_watchers"("contractId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_feeds_userId_key" ON "calendar_feeds"("userId");

-- CreateIndex
CREATE INDEX "calendar_feeds_orgId_idx" ON "calendar_feeds"("orgId");

-- CreateIndex
CREATE INDEX "contracts_orgId_noticeDeadline_idx" ON "contracts"("orgId", "noticeDeadline");

-- CreateIndex
CREATE INDEX "contracts_orgId_executedAt_idx" ON "contracts"("orgId", "executedAt");

-- CreateIndex
CREATE INDEX "contracts_parentContractId_idx" ON "contracts"("parentContractId");

-- AddForeignKey
ALTER TABLE "contract_term_values" ADD CONSTRAINT "contract_term_values_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewal_decisions" ADD CONSTRAINT "renewal_decisions_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_watchers" ADD CONSTRAINT "contract_watchers_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── docs/41 Part 13 — relationshipType is one of a fixed set ───────────────
-- `exhibit_only` meant two things: a part the binder split carved out of a
-- scanned file (the parent lists it in metadata._splitInto) and an exhibit.
UPDATE "contracts" c SET "relationshipType" = 'split_part'
 WHERE c."relationshipType" = 'exhibit_only'
   AND EXISTS (
     SELECT 1 FROM "contracts" p
      WHERE p."id" = c."parentContractId"
        AND jsonb_typeof(p."metadata"->'_splitInto') = 'array'
        AND p."metadata"->'_splitInto' ? c."id"
   );
UPDATE "contracts" SET "relationshipType" = 'exhibit' WHERE "relationshipType" IN ('exhibit_only', 'schedule', 'appendix');
UPDATE "contracts" SET "relationshipType" = lower(trim("relationshipType")) WHERE "relationshipType" IS NOT NULL;
UPDATE "contracts" SET "relationshipType" = 'sow' WHERE "relationshipType" = 'statement_of_work';
UPDATE "contracts" SET "relationshipType" = 'amendment' WHERE "relationshipType" = 'addendum';
UPDATE "contracts" SET "relationshipType" = 'other'
 WHERE "relationshipType" IS NOT NULL
   AND "relationshipType" NOT IN ('amendment', 'renewal', 'sow', 'order_form', 'exhibit', 'split_part', 'nda', 'other');
-- A link with no kind on a child reads as "related".
UPDATE "contracts" SET "relationshipType" = 'other' WHERE "relationshipType" IS NULL AND "parentContractId" IS NOT NULL;
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_relationshipType_check"
  CHECK ("relationshipType" IS NULL OR "relationshipType" IN ('amendment', 'renewal', 'sow', 'order_form', 'exhibit', 'split_part', 'nda', 'other'));

-- Numbers per parent and relationship, in the order they took effect.
WITH numbered AS (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "parentContractId", "relationshipType"
    ORDER BY COALESCE("effectiveDate", "createdAt"), "createdAt", "id"
  ) AS n
  FROM "contracts"
  WHERE "parentContractId" IS NOT NULL AND "deletedAt" IS NULL
    AND "relationshipType" IN ('amendment', 'renewal', 'sow', 'order_form')
)
UPDATE "contracts" c SET "amendmentNumber" = numbered.n FROM numbered WHERE c."id" = numbered."id";

-- ─── Y1 — tenant isolation for the new tables (20260924100000_tenant_row_level_security)
GRANT SELECT, INSERT, UPDATE, DELETE ON "contract_term_values" TO clm_tenant_access;
ALTER TABLE "contract_term_values" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contract_term_values" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "contract_term_values"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON "renewal_decisions" TO clm_tenant_access;
ALTER TABLE "renewal_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "renewal_decisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "renewal_decisions"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON "contract_watchers" TO clm_tenant_access;
ALTER TABLE "contract_watchers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contract_watchers" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "contract_watchers"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON "calendar_feeds" TO clm_tenant_access;
ALTER TABLE "calendar_feeds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "calendar_feeds" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "calendar_feeds"
  USING (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant())
  WITH CHECK (current_user <> 'clm_tenant_access' OR "orgId" = clm_current_tenant());

-- Older writers (seeds, scripts, API clients) still send `exhibit_only` and
-- other spellings: read each as the relationship it means instead of
-- refusing it (packages/types family.ts normaliseRelationshipType).
CREATE OR REPLACE FUNCTION contracts_relationship_normalise() RETURNS trigger AS $$
BEGIN
  IF NEW."relationshipType" IS NOT NULL THEN
    NEW."relationshipType" := lower(regexp_replace(trim(NEW."relationshipType"), '[\s-]+', '_', 'g'));
    NEW."relationshipType" := CASE
      WHEN NEW."relationshipType" IN ('amendment', 'renewal', 'sow', 'order_form', 'exhibit', 'split_part', 'nda', 'other') THEN NEW."relationshipType"
      WHEN NEW."relationshipType" IN ('exhibit_only', 'schedule', 'appendix') THEN 'exhibit'
      WHEN NEW."relationshipType" = 'statement_of_work' THEN 'sow'
      WHEN NEW."relationshipType" IN ('orderform', 'order') THEN 'order_form'
      WHEN NEW."relationshipType" IN ('addendum', 'amended_and_restated') THEN 'amendment'
      WHEN NEW."relationshipType" = '' THEN NULL
      ELSE 'other'
    END;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER contracts_relationship_normalise
  BEFORE INSERT OR UPDATE OF "relationshipType" ON "contracts"
  FOR EACH ROW EXECUTE FUNCTION contracts_relationship_normalise();
