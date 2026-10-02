-- docs/41 Part 16 (C4) — a portal comment's typed author name gets its own
-- column. It was kept in "resolvedById", where resolving the thread
-- overwrote it with the resolver's id. Unresolved portal comments move the
-- name across; resolved ones had already lost it.
ALTER TABLE "contract_comments" ADD COLUMN "authorName" TEXT;

UPDATE "contract_comments"
SET "authorName" = "resolvedById", "resolvedById" = NULL
WHERE "authorId" LIKE 'portal:%' AND "resolved" = false AND "resolvedById" IS NOT NULL;
