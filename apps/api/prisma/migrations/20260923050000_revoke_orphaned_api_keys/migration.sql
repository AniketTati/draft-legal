-- X46 repair: an API key now works only while the user behind it could still
-- make it (lib/acting-user.ts keyMaker). Keys of users deactivated or deleted
-- before X43 began revoking keys on deactivation, and keys made through a key
-- that has since been revoked or has expired, stay live in the key list
-- though they no longer authenticate. Revoke them, with every key made
-- through them, so the list says so and reactivating a user doesn't bring
-- their old keys back.
WITH RECURSIVE dead AS (
  SELECT k."id", k."orgId"
  FROM   "api_keys" k
  LEFT   JOIN "users" u ON u."id" = k."createdById" AND u."orgId" = k."orgId"
  WHERE  k."createdById" NOT LIKE 'apikey:%'
    AND  (u."id" IS NULL OR u."deletedAt" IS NOT NULL OR u."status" = 'DEACTIVATED')
  UNION
  SELECT k."id", k."orgId"
  FROM   "api_keys" k
  JOIN   "api_keys" p ON k."createdById" = 'apikey:' || p."id" AND p."orgId" = k."orgId"
  WHERE  p."revokedAt" IS NOT NULL OR p."expiresAt" < NOW()
  UNION
  SELECT k."id", k."orgId"
  FROM   "api_keys" k
  JOIN   dead d ON k."createdById" = 'apikey:' || d."id" AND k."orgId" = d."orgId"
)
UPDATE "api_keys"
SET    "revokedAt" = NOW()
WHERE  "id" IN (SELECT "id" FROM dead)
  AND  "revokedAt" IS NULL;
