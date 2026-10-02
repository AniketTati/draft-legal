-- docs/41 fix-up 9: when a category's presence rule last changed, so a version
-- reviewed before it is reviewed again the next time it is read.
ALTER TABLE "clause_categories" ADD COLUMN "presenceChangedAt" TIMESTAMP(3);
