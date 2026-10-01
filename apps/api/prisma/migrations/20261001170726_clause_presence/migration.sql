-- docs/41 P0.3 — presence rules: whether a contract must have a clause of a
-- category (required | not_allowed | optional), for the contract types listed
-- ([] = every type).
ALTER TABLE "clause_categories" ADD COLUMN     "presence" TEXT NOT NULL DEFAULT 'optional',
ADD COLUMN     "presenceContractTypes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- The small required set the org seed now carries, for orgs seeded before it:
-- confidentiality for NDAs; limitation of liability for services, vendor and
-- licence (SaaS) agreements; the term, and the governing law, for the types
-- that stand on their own (an SOW or order form takes them from its master).
-- Matched by the category names the seed uses. Governing law sits in
-- "Dispute Resolution" in the seed (its positions are about governing law
-- and venue), unless the org has a category of its own for it.
UPDATE "clause_categories"
SET "presence" = 'required', "presenceContractTypes" = ARRAY['NDA']
WHERE lower(trim("name")) = 'confidentiality' AND "presence" = 'optional';

UPDATE "clause_categories"
SET "presence" = 'required', "presenceContractTypes" = ARRAY['MSA', 'VENDOR_AGREEMENT', 'LICENSE']
WHERE lower(trim("name")) = 'limitation of liability' AND "presence" = 'optional';

UPDATE "clause_categories"
SET "presence" = 'required', "presenceContractTypes" = ARRAY['NDA', 'MSA', 'VENDOR_AGREEMENT', 'LICENSE', 'PARTNERSHIP', 'SLA', 'EMPLOYMENT', 'DATA_PROCESSING']
WHERE lower(trim("name")) IN ('term & termination', 'term and termination', 'governing law') AND "presence" = 'optional';

UPDATE "clause_categories" c
SET "presence" = 'required', "presenceContractTypes" = ARRAY['NDA', 'MSA', 'VENDOR_AGREEMENT', 'LICENSE', 'PARTNERSHIP', 'SLA', 'EMPLOYMENT', 'DATA_PROCESSING']
WHERE lower(trim(c."name")) = 'dispute resolution' AND c."presence" = 'optional'
  AND NOT EXISTS (
    SELECT 1 FROM "clause_categories" g
    WHERE g."orgId" = c."orgId" AND lower(trim(g."name")) = 'governing law'
  );
