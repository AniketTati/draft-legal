-- docs/41 Part 14 — a renewal decision is a row of its own (renewal_decisions),
-- not metadata on the contract. Decisions recorded before move across, with
-- the old "let_expire" read as "let_lapse"; "pause" and "unknown" were not
-- decisions and are dropped. Who decided wasn't kept: the owner stands in.
INSERT INTO "renewal_decisions" ("id", "orgId", "contractId", "decision", "decidedById", "reason", "noticeDeadline", "createdAt")
SELECT
  'rd_' || md5(c."id" || '-metadata-decision'),
  c."orgId",
  c."id",
  CASE c."metadata"->>'renewalDecision' WHEN 'let_expire' THEN 'let_lapse' ELSE c."metadata"->>'renewalDecision' END,
  c."ownerId",
  NULLIF(c."metadata"->>'renewalDecisionNote', ''),
  c."noticeDeadline",
  COALESCE(
    CASE WHEN c."metadata"->>'renewalDecisionAt' ~ '^\d{4}-\d{2}-\d{2}' THEN (c."metadata"->>'renewalDecisionAt')::timestamptz END,
    c."updatedAt"
  )
FROM "contracts" c
WHERE c."metadata"->>'renewalDecision' IN ('renew', 'renegotiate', 'let_expire', 'let_lapse', 'terminate')
  AND NOT EXISTS (SELECT 1 FROM "renewal_decisions" d WHERE d."contractId" = c."id");

UPDATE "contracts"
   SET "metadata" = "metadata" - 'renewalDecision' - 'renewalDecisionAt' - 'renewalDecisionNote'
 WHERE "metadata" ?| ARRAY['renewalDecision', 'renewalDecisionAt', 'renewalDecisionNote'];
