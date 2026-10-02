-- docs/39 A14 — other names contracts give a counterparty, so a contract
-- naming one links to it (lib/counterparty-directory.ts).

-- AlterTable
ALTER TABLE "counterparties" ADD COLUMN     "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[];
