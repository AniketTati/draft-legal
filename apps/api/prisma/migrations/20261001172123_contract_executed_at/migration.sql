-- docs/41 P0.10 — when a contract was executed, kept from now on whenever its
-- status becomes EXECUTED (lib/status-change.ts).
ALTER TABLE "contracts" ADD COLUMN "executedAt" TIMESTAMP(3);

-- Backfill for contracts executed before the column existed. Approximate, in
-- order of how good the evidence is:
--   1. the newest completed signature request's completedAt (the moment the
--      last signer signed — exact for contracts signed in the product);
--   2. the newest audit event recording a change to EXECUTED (a manual
--      "Mark executed" — exact to the second);
--   3. otherwise the row's updatedAt — only an upper bound: any later edit
--      moved it, so this can be later than the real execution.
-- Contracts that left EXECUTED (EXPIRED, TERMINATED, ARCHIVED) get 1 or 2
-- when there is evidence, and stay NULL otherwise: their updatedAt is when
-- they left, not when they were signed.
UPDATE "contracts" c
SET "executedAt" = sr."completedAt"
FROM (
  SELECT DISTINCT ON ("contractId") "contractId", "completedAt"
  FROM "signature_requests"
  WHERE "status" = 'COMPLETED' AND "completedAt" IS NOT NULL
  ORDER BY "contractId", "completedAt" DESC
) sr
WHERE sr."contractId" = c.id
  AND c."executedAt" IS NULL
  AND c."status" IN ('EXECUTED', 'EXPIRED', 'TERMINATED', 'ARCHIVED');

UPDATE "contracts" c
SET "executedAt" = ae."createdAt"
FROM (
  SELECT DISTINCT ON ("resourceId") "resourceId", "createdAt"
  FROM "audit_events"
  WHERE "resourceType" = 'contract'
    AND "action" = 'CONTRACT_STATUS_CHANGED'
    AND "metadata"->>'to' = 'EXECUTED'
  ORDER BY "resourceId", "createdAt" DESC
) ae
WHERE ae."resourceId" = c.id
  AND c."executedAt" IS NULL
  AND c."status" IN ('EXECUTED', 'EXPIRED', 'TERMINATED', 'ARCHIVED');

UPDATE "contracts"
SET "executedAt" = "updatedAt"
WHERE "executedAt" IS NULL AND "status" = 'EXECUTED';
