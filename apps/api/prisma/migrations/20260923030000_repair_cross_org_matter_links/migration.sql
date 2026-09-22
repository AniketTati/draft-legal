-- X25 repair: matter links were stored without checking their org, so a
-- contract, request or thread could sit in another org's matter (and show in
-- its view), and a matter could point at another org's counterparty or user.
-- The routes now refuse such ids; this clears the ones stored before.
UPDATE "contracts" AS c
SET    "matterId" = NULL
FROM   "matters" AS m
WHERE  c."matterId" = m."id" AND m."orgId" <> c."orgId";

UPDATE "contract_requests" AS r
SET    "matterId" = NULL
FROM   "matters" AS m
WHERE  r."matterId" = m."id" AND m."orgId" <> r."orgId";

UPDATE "agent_threads" AS t
SET    "matterId" = NULL
FROM   "matters" AS m
WHERE  t."matterId" = m."id" AND m."orgId" <> t."orgId";

UPDATE "matters" AS m
SET    "counterpartyId" = NULL
FROM   "counterparties" AS cp
WHERE  m."counterpartyId" = cp."id" AND cp."orgId" <> m."orgId";

-- A matter must have an owner: a foreign one falls back to its creator.
UPDATE "matters" AS m
SET    "ownerId" = m."createdById"
FROM   "users" AS u
WHERE  m."ownerId" = u."id" AND u."orgId" <> m."orgId";
