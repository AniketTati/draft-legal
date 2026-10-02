-- docs/41 Part 16 — comment visibility (internal | external) and text anchors.
ALTER TABLE "contract_comments" ADD COLUMN     "anchor" JSONB,
ADD COLUMN     "visibility" TEXT NOT NULL DEFAULT 'internal';

ALTER TABLE "contract_comments" ADD CONSTRAINT "contract_comments_visibility_check"
  CHECK ("visibility" IN ('internal', 'external'));

-- Threads the counterparty started in the portal were always theirs to see:
-- mark them, and every reply in them, external.
UPDATE "contract_comments" SET "visibility" = 'external'
 WHERE "authorId" LIKE 'portal:%'
    OR "parentId" IN (SELECT "id" FROM "contract_comments" WHERE "authorId" LIKE 'portal:%' AND "parentId" IS NULL);

-- CreateIndex
CREATE INDEX "contract_comments_contractId_visibility_idx" ON "contract_comments"("contractId", "visibility");
