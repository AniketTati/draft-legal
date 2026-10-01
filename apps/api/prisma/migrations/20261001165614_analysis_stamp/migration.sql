-- docs/41 P0.1 — every finished analysis is stamped with the version it read
-- (contracts.metadata._analysis), and a contract without that stamp shows as
-- "Not analysed". Contracts analysed before the stamp existed get one here,
-- so they don't all turn "Not analysed" at once: a DONE contract whose
-- current version has clauses is taken as analysed for that version, as it
-- was taken before. (An edited version's clauses were carried from the one
-- before it, so this can stamp an edit that was never read itself — the
-- same belief the product held until now; new edits are judged truthfully.)
--
-- DONE contracts with no clauses are left unstamped: they were never read
-- (scripts/backfill-unanalysed.ts queues their analysis).
UPDATE contracts c
SET metadata = jsonb_set(
  COALESCE(c.metadata, '{}'::jsonb),
  '{_analysis}',
  jsonb_build_object(
    'versionId',         v.id,
    'versionNumber',     v."versionNumber",
    'at',                to_char(c."updatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'clauses',           k.n,
    'baselineVersionId', NULL
  )
)
FROM contract_versions v,
     LATERAL (SELECT count(*)::int AS n FROM contract_clauses cl WHERE cl."versionId" = v.id AND cl."isSubChunk" = false) k
WHERE v.id = c."currentVersionId"
  AND c."analysisStatus" = 'DONE'
  AND c."deletedAt" IS NULL
  AND k.n > 0
  AND NOT (COALESCE(c.metadata, '{}'::jsonb) ? '_analysis');
