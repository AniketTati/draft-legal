-- docs/39 E4 — wording saved to the clause library from a contract keeps
-- where it came from (routes/clauses.ts POST /clauses/from-contract).

-- AlterTable
ALTER TABLE "clause_library_items" ADD COLUMN     "sourceContractId" TEXT,
ADD COLUMN     "sourceSection" TEXT,
ADD COLUMN     "sourceVersionId" TEXT;

-- CreateIndex
CREATE INDEX "clause_library_items_sourceContractId_idx" ON "clause_library_items"("sourceContractId");
