-- docs/39 G4 — an obligation the AI found is a suggestion until a person
-- confirms or dismisses it. Obligations already in use stay confirmed.

-- AlterTable
ALTER TABLE "obligations" ADD COLUMN "reviewState" TEXT NOT NULL DEFAULT 'CONFIRMED',
ADD COLUMN "reviewedAt" TIMESTAMP(3),
ADD COLUMN "reviewedById" TEXT;

-- CreateIndex
CREATE INDEX "obligations_orgId_reviewState_idx" ON "obligations"("orgId", "reviewState");
