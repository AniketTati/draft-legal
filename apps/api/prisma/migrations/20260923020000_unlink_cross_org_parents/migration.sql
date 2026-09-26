-- X20 repair: POST /contracts/upload stored a client-supplied parentContractId
-- without checking its org, so a contract could name another org's contract as
-- its parent — and that contract's family view then listed it. The route now
-- refuses such links; this clears any made before.
UPDATE "contracts" AS child
SET    "parentContractId" = NULL, "relationshipType" = NULL
FROM   "contracts" AS parent
WHERE  child."parentContractId" = parent."id"
  AND  parent."orgId" <> child."orgId";
