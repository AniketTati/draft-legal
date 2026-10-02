-- docs/41 Part 14 — the calendar feed link's token, kept only as a hash, and revocable.
ALTER TABLE "calendar_feeds" ADD COLUMN "tokenHash" TEXT,
ADD COLUMN "revokedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "calendar_feeds_tokenHash_key" ON "calendar_feeds"("tokenHash");
