-- docs/41 Part 11 — obligations read from a draft are proposed (status
-- PROPOSED) until signing; the version they were read from decides which
-- become OPEN when the contract is signed.
ALTER TABLE "obligations" ADD COLUMN "versionId" TEXT;
