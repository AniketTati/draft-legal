-- X19 repair: POST /invoices stored a client-supplied contractId without
-- checking its org, so an invoice could point at another org's contract — and
-- the invoice list and detail then showed that contract's title and
-- counterparty. The route now refuses such links; this unlinks any made before.
-- (The auto-matcher only ever matched within the org, so these rows carry no
-- obligation; the second statement is a defensive no-op for the same case.)
UPDATE "invoices" AS i
SET    "contractId" = NULL
FROM   "contracts" AS c
WHERE  i."contractId" = c."id"
  AND  c."orgId" <> i."orgId";

UPDATE "invoices" AS i
SET    "matchedObligationId" = NULL
FROM   "obligations" AS o
WHERE  i."matchedObligationId" = o."id"
  AND  o."orgId" <> i."orgId";
