-- BB3 — the "Editing in Google Docs" lock (lib/external-edit.ts): who took the
-- working copy, when, and from which version. Null when no copy is out.
ALTER TABLE "contracts" ADD COLUMN "externalEdit" JSONB;
