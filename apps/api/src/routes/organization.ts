/**
 * Organization management routes — org details and settings.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requireUserOrAdminKey } from '../middleware/auth.js'
import { requirePermission, permissionScopeFor } from '../middleware/permissions.js'
import { seedOrgDefaults, INDUSTRY_PACK_INFO } from '../lib/org-seed.js'
import type { IndustryPackId } from '../lib/org-seed.js'
import { createAuditEvent } from '../lib/audit.js'
import { clearOrgPiiModeCache } from '../lib/pii-policy.js'
import { mergeOrgSettings, addToOrgSettingsList, type OrgDb } from '../lib/org-settings.js'
import { clearOrgDateOrderCache, DATE_ORDERS } from '../lib/org-date-order.js'
import { ourNames, MAX_OUR_ENTITIES } from '../lib/counterparty-directory.js'
import { saveEntities, contractsNamingUs, pickOtherParty, PICK_MAX } from '../lib/our-entities.js'
import { portfolioWhere } from '../lib/own-scope-guard.js'
import { AuditAction } from '@clm/types'

// X59 — the settings form sends what its fields hold, so "no logo" arrives as
// ''. A blank clears the field; before, it failed the URL check and the org
// could not save its name or colour without a logo.
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v)

const UpdateOrgSchema = z.object({
  name: z.string().min(1).optional(),
  logoUrl: z.preprocess(blankToNull, z.string().url().optional().nullable()),
  brandColor: z.preprocess(blankToNull, z.string().optional().nullable()),
  settings: z.record(z.unknown()).optional(),
})

// Settings keys owned by dedicated admin routes (integrations.ts manages
// `slack`). PATCH /organization must not write them: its merge is shallow, so
// a client echoing back the redacted summary would wipe the real config.
const SERVER_MANAGED_SETTINGS = new Set(['slack', 'ourEntities', 'fieldChecks'])

// X5 — settings that protect data. This route is open to configure:integration
// (LEGAL_OPS), which could switch PII redaction off org-wide, unaudited. They
// need the permission the rest of the AI config needs, a valid value, and an
// audit row for every change.
const PROTECTED_SETTINGS: Record<string, readonly unknown[]> = {
  piiRedactionMode: ['redact', 'tokenize', 'off'],
  // docs/41 P0.8 — contracts may be sent for signature without an approval.
  // Off unless an admin turns it on; the change is audited like the others.
  allowSignWithoutApproval: [true, false],
}

// Settings with a fixed set of values: a value outside it is refused, not stored.
const ENUM_SETTINGS: Record<string, readonly string[]> = {
  // docs/39 A11 — how the org writes dates with numbers (lib/org-date-order.ts).
  dateOrder: DATE_ORDERS,
}

// Belt-and-braces: never serialize a credential-looking key, at any depth.
const SECRET_KEY = /secret|token|password|api[_-]?key|private[_-]?key/i

function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !SECRET_KEY.test(k))
        .map(([k, v]) => [k, stripSecrets(v)]),
    )
  }
  return value
}

/**
 * org.settings as any member may see it. GET /organization is readable by
 * every role, so the Slack signing secret and bot token are replaced by the
 * same non-secret summary GET /integrations/slack gives admins.
 */
function publicSettings(raw: unknown): Record<string, unknown> {
  const all = (raw ?? {}) as Record<string, unknown>
  const settings = stripSecrets(all) as Record<string, unknown>
  const slack = all.slack as
    { teamId?: string; signingSecret?: string; botToken?: string; configuredAt?: string } | undefined
  if (slack) {
    settings.slack = slack.teamId
      ? {
          connected:        true,
          teamId:           slack.teamId,
          configuredAt:     slack.configuredAt ?? null,
          hasSigningSecret: Boolean(slack.signingSecret),
          hasBotToken:      Boolean(slack.botToken),
        }
      : { connected: false }
  }
  return settings
}

// docs/39 A8 — the companies the org signs as (lib/our-entities.ts).
const EntityName = z.string().trim().min(1).max(200)
const EntitiesSchema = z.object({ entities: z.array(EntityName).max(MAX_OUR_ENTITIES) })
const AddEntitySchema = z.object({ name: EntityName })

/** Our names, and the contracts in the caller's scope that name one of them as the counterparty. */
async function entitiesView(req: FastifyRequest) {
  const { orgName, entities } = await ourNames(req.user.orgId)
  // Counted over what "Use the other party" would read; the first few listed.
  const naming = await contractsNamingUs(req.user.orgId, portfolioWhere(req), PICK_MAX)
  return { orgName, entities, max: MAX_OUR_ENTITIES, namingUs: { total: naming.total, fixable: naming.fixable, contracts: naming.contracts.slice(0, 20) } }
}

async function auditEntities(req: FastifyRequest, from: string[], to: string[]) {
  if (from.join('\n') === to.join('\n')) return
  await createAuditEvent({
    orgId: req.user.orgId, userId: req.user.sub, action: AuditAction.AI_SETTINGS_UPDATED,
    resourceType: 'organization', resourceId: req.user.orgId,
    metadata: { changed: { ourEntities: { from, to } } }, ipAddress: req.ip,
  }).catch(() => {})
}

const InstallPackSchema = z.object({
  packId: z.enum(['saas', 'healthcare', 'manufacturing', 'biotech', 'logistics']),
})

export async function organizationRoutes(app: FastifyInstance) {
  // GET /api/v1/organization — current org details
  app.get('/', { preHandler: requireUserOrAdminKey }, async (req, reply) => {
    const org = await prisma.organization.findUnique({
      where: { id: req.user.orgId },
    })
    if (!org) return reply.status(404).send({ detail: 'Organization not found' })

    return reply.send({
      id: org.id,
      name: org.name,
      slug: org.slug,
      subscriptionTier: org.subscriptionTier,
      logoUrl: org.logoUrl,
      brandColor: org.brandColor,
      settings: publicSettings(org.settings),
      createdAt: org.createdAt,
      updatedAt: org.updatedAt,
    })
  })

  // PATCH /api/v1/organization — update org settings
  app.patch('/', { preHandler: requirePermission('configure', 'integration') }, async (req, reply) => {
    const body = UpdateOrgSchema.parse(req.body)

    const org = await prisma.organization.findUnique({
      where: { id: req.user.orgId },
    })
    if (!org) return reply.status(404).send({ detail: 'Organization not found' })

    // Merge settings if provided, never touching server-managed keys
    const currentSettings = (org.settings as Record<string, unknown>) ?? {}
    const incoming = Object.fromEntries(
      Object.entries(body.settings ?? {}).filter(([k]) => !SERVER_MANAGED_SETTINGS.has(k)),
    )
    for (const [k, allowed] of Object.entries(ENUM_SETTINGS)) {
      if (Object.hasOwn(incoming, k) && !allowed.includes(incoming[k] as string)) {
        return reply.status(400).send({ detail: `${k} must be one of: ${allowed.join(', ')}` })
      }
    }
    const protectedChanges = Object.keys(incoming).filter(k => Object.hasOwn(PROTECTED_SETTINGS, k))
    if (protectedChanges.length) {
      if (!await permissionScopeFor(req, 'configure', 'organization')) {
        return reply.status(403).send({ detail: `Changing ${protectedChanges.join(', ')} requires configure:organization` })
      }
      for (const k of protectedChanges) {
        if (!PROTECTED_SETTINGS[k].includes(incoming[k])) {
          return reply.status(400).send({ detail: `${k} must be one of: ${PROTECTED_SETTINGS[k].join(', ')}` })
        }
      }
    }

    const changed: Record<string, { from: unknown; to: unknown }> = {}
    for (const k of protectedChanges) {
      if (currentSettings[k] !== incoming[k]) changed[k] = { from: currentSettings[k] ?? null, to: incoming[k] }
    }
    // X4 — merge only the keys this request sets, in SQL: writing back a copy
    // read earlier undid concurrent changes (an install-industry-pack racing an
    // ADMIN's piiRedactionMode change reverted it).
    const write = async (db: OrgDb) => {
      if (Object.keys(incoming).length) await mergeOrgSettings(req.user.orgId, incoming, db)
      return db.organization.update({
        where: { id: req.user.orgId },
        data: {
          ...(body.name && { name: body.name }),
          ...(body.logoUrl !== undefined && { logoUrl: body.logoUrl }),
          ...(body.brandColor !== undefined && { brandColor: body.brandColor }),
        },
      })
    }
    let updated: Awaited<ReturnType<typeof write>> | undefined
    if (Object.keys(changed).length) {
      // The change and its audit row commit together.
      await createAuditEvent({
        orgId:        req.user.orgId,
        userId:       req.user.sub,
        action:       AuditAction.AI_SETTINGS_UPDATED,
        resourceType: 'organization',
        resourceId:   req.user.orgId,
        metadata:     { changed },
        ipAddress:    req.ip,
      }, { within: async tx => { updated = await write(tx) } })
      clearOrgPiiModeCache(req.user.orgId)
    } else {
      updated = await write(prisma)
    }
    if (!updated) return reply.status(500).send({ detail: 'Organization update failed' })
    if (Object.hasOwn(incoming, 'dateOrder')) clearOrgDateOrderCache(req.user.orgId)

    return reply.send({
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
      subscriptionTier: updated.subscriptionTier,
      logoUrl: updated.logoUrl,
      brandColor: updated.brandColor,
      settings: publicSettings(updated.settings),
    })
  })

  // GET /api/v1/organization/industry-packs — list available packs
  app.get('/industry-packs', { preHandler: requireUserOrAdminKey }, async (_req, reply) => {
    const packs = (Object.keys(INDUSTRY_PACK_INFO) as IndustryPackId[]).map(id => ({
      id,
      label:       INDUSTRY_PACK_INFO[id].label,
      description: INDUSTRY_PACK_INFO[id].description,
    }))
    return reply.send({ data: packs })
  })

  // docs/39 A8 — Settings › Our entities: the names the org signs as. The
  // extraction never takes one for the counterparty; contracts that already
  // name one can be put right.
  //   GET  /organization/entities                    { orgName, entities, namingUs }
  //   PUT  /organization/entities                    { entities }  the whole list
  //   POST /organization/entities                    { name }      add one (offered on a correction)
  //   POST /organization/entities/pick-other-party   the other party as counterparty where one of ours is named
  app.get('/entities', { preHandler: requirePermission('view', 'contract') }, async (req, reply) => {
    return reply.send(await entitiesView(req))
  })

  app.put('/entities', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const { entities } = EntitiesSchema.parse(req.body ?? {})
    const before = (await ourNames(req.user.orgId)).entities
    await auditEntities(req, before, await saveEntities(req.user.orgId, entities))
    return reply.send(await entitiesView(req))
  })

  app.post('/entities', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const { name } = AddEntitySchema.parse(req.body ?? {})
    const before = (await ourNames(req.user.orgId)).entities
    if (before.length >= MAX_OUR_ENTITIES) return reply.status(400).send({ detail: `At most ${MAX_OUR_ENTITIES} names. Remove one in Settings › Organization first.` })
    await auditEntities(req, before, await saveEntities(req.user.orgId, [...before, name]))
    return reply.send(await entitiesView(req))
  })

  app.post('/entities/pick-other-party', { preHandler: requirePermission('configure', 'contract') }, async (req, reply) => {
    const r = await pickOtherParty({ orgId: req.user.orgId, userId: req.user.sub, where: portfolioWhere(req) })
    if (r.fixed) {
      await createAuditEvent({
        orgId: req.user.orgId, userId: req.user.sub, action: AuditAction.CONTRACT_UPDATED,
        resourceType: 'organization', resourceId: req.user.orgId,
        metadata: { source: 'our_entities', action: 'counterparty_repicked', contracts: r.fixed, runId: r.runId },
        ipAddress: req.ip,
      }).catch(() => {})
    }
    return reply.send({ fixed: r.fixed, runId: r.runId, left: r.left.slice(0, 50), leftTotal: r.left.length, max: PICK_MAX })
  })

  // POST /api/v1/organization/install-industry-pack — layer a vertical pack
  // on top of the universal seed. Idempotent — calling twice is safe.
  app.post(
    '/install-industry-pack',
    { preHandler: requirePermission('configure', 'integration') },
    async (req, reply) => {
      const body = InstallPackSchema.parse(req.body)
      const org = await prisma.organization.findUnique({ where: { id: req.user.orgId } })
      if (!org) return reply.status(404).send({ detail: 'Organization not found' })

      // seedOrgDefaults includes the universal pack call; calling it with an
      // industryPack option re-runs the universal seed (no-op due to upserts)
      // and then layers the industry pack content.
      await seedOrgDefaults(org.id, org.slug, req.user.sub, { industryPack: body.packId })

      // Persist which pack was installed, so the wizard / settings page can show
      // it. X4 — appended in SQL: the copy of settings read before the (slow)
      // seed was written back whole, undoing any change made in between.
      await addToOrgSettingsList(org.id, 'installedIndustryPacks', body.packId)

      return reply.send({
        ok: true,
        packId: body.packId,
        label: INDUSTRY_PACK_INFO[body.packId].label,
      })
    },
  )
}
