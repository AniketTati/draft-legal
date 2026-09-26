/**
 * Atomic writes to organization.settings (X4).
 *
 * `settings` is one JSON blob that several routes own parts of (the org PATCH,
 * industry packs, the Slack integration). Each used to read the whole blob and
 * write the whole blob back, so two writes racing — e.g. an ADMIN tightening
 * piiRedactionMode while an industry-pack install (which awaits a slow seed
 * between its read and its write) finishes — silently undid one of them.
 * These touch only the keys they name, in one statement.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from './prisma.js'

export type OrgDb = PrismaClient | Prisma.TransactionClient
type Db = OrgDb

/** Set top-level keys, leaving every other key as it is in the row now. */
export async function mergeOrgSettings(orgId: string, patch: Record<string, unknown>, db: Db = prisma): Promise<void> {
  await db.$executeRaw`
    UPDATE organizations
    SET    settings = COALESCE(settings, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb, "updatedAt" = NOW()
    WHERE  id = ${orgId}`
}

/** Remove one top-level key. */
export async function removeOrgSetting(orgId: string, key: string, db: Db = prisma): Promise<void> {
  await db.$executeRaw`
    UPDATE organizations
    SET    settings = COALESCE(settings, '{}'::jsonb) - ${key}::text, "updatedAt" = NOW()
    WHERE  id = ${orgId}`
}

/** Add a string to a top-level list key (created if missing), once. */
export async function addToOrgSettingsList(orgId: string, key: string, value: string, db: Db = prisma): Promise<void> {
  await db.$executeRaw`
    UPDATE organizations
    SET    settings = jsonb_set(
             COALESCE(settings, '{}'::jsonb),
             ARRAY[${key}::text],
             (SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb)
              FROM jsonb_array_elements_text(
                     (CASE WHEN jsonb_typeof(settings -> ${key}::text) = 'array' THEN settings -> ${key}::text ELSE '[]'::jsonb END)
                     || jsonb_build_array(${value}::text)
                   ) AS v)
           ),
           "updatedAt" = NOW()
    WHERE  id = ${orgId}`
}
