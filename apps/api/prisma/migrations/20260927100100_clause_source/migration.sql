-- docs/39 E2 — who made a clause row (re-analysis replaces only `ai` rows),
-- and B2 — where it sits in its version's plainText. Existing rows were all
-- made by extraction.
ALTER TABLE "contract_clauses" ADD COLUMN     "docEnd" INTEGER,
ADD COLUMN     "docStart" INTEGER,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'ai';
