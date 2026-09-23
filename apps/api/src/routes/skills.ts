/**
 * Skills routes (D.4.1+)
 *
 * Skills are the reusable workflow layer above the agent — named prompts
 * with a narrowed tool set the user can invoke via `@slug` mention, a
 * quick-action chip, or the Skills admin page.
 *
 * Endpoint surface:
 *   GET    /api/v1/skills                 — list visible skills (built-in + org)
 *   GET    /api/v1/skills/:id             — read one
 *   POST   /api/v1/skills                 — create org skill (admin only)
 *   PATCH  /api/v1/skills/:id             — edit (built-in: only admin; org: author or admin)
 *   DELETE /api/v1/skills/:id             — soft-delete (admin only; blocks built-in delete)
 *
 * Design reference:
 *   - Claude.ai Skills (2025) — slug-keyed reusable prompts
 *   - Cursor Rules — repo-level named instructions
 *   - GPT Store — system-prompt + allowed-tool bundles users can publish
 *
 * RBAC:
 *   - Reads are open to any authed user in the org (built-ins are global).
 *   - Writes (create/edit/delete) require the `ADMIN` role until D6
 *     opens user-level skill creation to non-admins.
 *
 * Version bump: every edit of `systemPrompt` / `allowedTools` /
 * `contextScope` / `modelTier` / `triggerTypes` bumps `version` so
 * `SkillInvocation.skillVersion` snapshots correctly (D.4.5).
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireUserOrAdminKey } from '../middleware/auth.js'
// Wave 1.7 — skills define agent system prompts + tool allowlists (security-
// sensitive), so create/update/delete are admin-gated; reads stay open.
import { requirePermission } from '../middleware/permissions.js'
import { prisma } from '../lib/prisma.js'
import { SystemRole } from '@clm/types'

const OWNER_TYPES = ['built_in', 'org', 'user'] as const
const CONTEXT_SCOPES = [
  'dashboard', 'current_contract', 'current_request',
  'selection', 'portfolio', 'any',
] as const
const MODEL_TIERS = ['reasoning', 'default', 'fast'] as const
const TRIGGER_TYPES = ['mention', 'chip', 'button'] as const

const CreateSkillSchema = z.object({
  name:          z.string().min(1).max(80),
  slug:          z.string().regex(/^@[a-z0-9][a-z0-9-]{1,40}$/, 'slug must be "@lower-kebab"'),
  description:   z.string().min(1).max(500),
  contextScope:  z.enum(CONTEXT_SCOPES),
  systemPrompt:  z.string().min(10).max(10_000),
  allowedTools:  z.array(z.string().min(1)).max(30).default([]),
  modelTier:     z.enum(MODEL_TIERS).default('default'),
  triggerTypes:  z.array(z.enum(TRIGGER_TYPES)).default(['mention']),
  followUps:     z.array(z.string().max(200)).default([]),
  requiresRole:  z.array(z.string().max(40)).default([]),
})

const UpdateSkillSchema = CreateSkillSchema.partial()

/** Fields whose edits should bump the version (audit + invocation-snapshot safety). */
const VERSIONED_FIELDS: Array<keyof z.infer<typeof UpdateSkillSchema>> = [
  'systemPrompt', 'allowedTools', 'contextScope', 'modelTier', 'triggerTypes',
]

function isAdmin(roles: string[] | undefined): boolean {
  if (!roles) return false
  return roles.includes(SystemRole.ADMIN) || roles.includes('ADMIN')
}

export async function skillsRoutes(app: FastifyInstance) {
  // ── GET /api/v1/skills ──────────────────────────────────────────────────────
  // Lists every skill visible to this caller: built-ins (orgId=null) + their
  // org's own skills (orgId match) + their own user-private skills.
  // `scope` filter lets the rail fetch only skills relevant to the page
  // they're on (current_contract | dashboard | portfolio | any).
  app.get('/', { preHandler: requireUserOrAdminKey }, async (req, reply) => {
    const { orgId, sub: userId } = req.user
    const q = z.object({
      scope:     z.enum([...CONTEXT_SCOPES, 'all']).default('all'),
      ownerType: z.enum([...OWNER_TYPES, 'all']).default('all'),
    }).parse(req.query)

    const where: Record<string, unknown> = {
      deletedAt: null,
      isPublished: true,
      OR: [
        { orgId: null, ownerType: 'built_in' },
        { orgId, ownerType: 'org' },
        { ownerUserId: userId, ownerType: 'user' },
      ],
    }
    if (q.scope !== 'all') (where as any).contextScope = q.scope
    if (q.ownerType !== 'all') (where as any).ownerType = q.ownerType

    const skills = await prisma.skill.findMany({
      where: where as never,
      orderBy: [{ ownerType: 'asc' }, { name: 'asc' }], // built_in first, then org, then user
      select: {
        id: true, name: true, slug: true, description: true,
        ownerType: true, contextScope: true, modelTier: true,
        triggerTypes: true, allowedTools: true, followUps: true,
        requiresRole: true, version: true, updatedAt: true,
      },
    })
    return reply.send({ skills })
  })

  // ── GET /api/v1/skills/:id ──────────────────────────────────────────────────
  // Full skill including systemPrompt. Admin-only visibility for built-in
  // prompts (they're effectively our IP + the UI needs the raw text only
  // in the admin editor).
  app.get('/:id', { preHandler: requireUserOrAdminKey }, async (req, reply) => {
    const { orgId, sub: userId, roles } = req.user
    const { id } = req.params as { id: string }

    const skill = await prisma.skill.findFirst({
      where: {
        id,
        deletedAt: null,
        OR: [
          { orgId: null, ownerType: 'built_in' },
          { orgId, ownerType: 'org' },
          { ownerUserId: userId, ownerType: 'user' },
        ],
      },
    })
    if (!skill) return reply.status(404).send({ detail: 'Skill not found' })

    // Non-admins can see the slug + description + tools, but not the raw
    // systemPrompt of built-in skills — that's the admin editor's domain.
    if (skill.ownerType === 'built_in' && !isAdmin(roles as string[] | undefined)) {
      return reply.send({ ...skill, systemPrompt: '[hidden — admin-only]' })
    }
    return reply.send(skill)
  })

  // ── POST /api/v1/skills ─────────────────────────────────────────────────────
  // Create an org skill. Requires SYSTEM_ADMIN until D.6 lands user skills.
  app.post('/', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { orgId, sub: userId, roles } = req.user
    if (!isAdmin(roles as string[] | undefined)) {
      return reply.status(403).send({ detail: 'Only admins can create org skills' })
    }

    let body
    try { body = CreateSkillSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid body', issues: (err as { issues?: unknown }).issues })
    }

    // Slugs are unique per org. Built-in slugs are globally reserved —
    // don't let an admin create an org skill with the same slug as a
    // built-in (would shadow it confusingly).
    const builtIn = await prisma.skill.findFirst({
      where: { slug: body.slug, orgId: null, ownerType: 'built_in' },
    })
    if (builtIn) {
      return reply.status(409).send({ detail: `Slug ${body.slug} is reserved by a built-in skill` })
    }

    const existing = await prisma.skill.findFirst({
      where: { slug: body.slug, orgId, deletedAt: null },
    })
    if (existing) {
      return reply.status(409).send({ detail: `Slug ${body.slug} already exists in this org` })
    }

    const skill = await prisma.skill.create({
      data: {
        orgId,
        ownerUserId: userId,
        ownerType: 'org',
        name: body.name,
        slug: body.slug,
        description: body.description,
        contextScope: body.contextScope,
        systemPrompt: body.systemPrompt,
        allowedTools: body.allowedTools,
        modelTier: body.modelTier,
        triggerTypes: body.triggerTypes,
        followUps: body.followUps,
        requiresRole: body.requiresRole,
      },
    })
    return reply.status(201).send(skill)
  })

  // ── PATCH /api/v1/skills/:id ────────────────────────────────────────────────
  // Admins can edit any skill (built-in system prompts included). If any
  // versioned field changes, bump version + log the edit.
  app.patch('/:id', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { orgId, roles } = req.user
    const { id } = req.params as { id: string }
    if (!isAdmin(roles as string[] | undefined)) {
      return reply.status(403).send({ detail: 'Only admins can edit skills' })
    }

    const skill = await prisma.skill.findFirst({
      where: {
        id,
        deletedAt: null,
        OR: [
          { orgId: null, ownerType: 'built_in' }, // admins of any org can edit built-ins
          { orgId, ownerType: 'org' },
        ],
      },
    })
    if (!skill) return reply.status(404).send({ detail: 'Skill not found' })

    let patch
    try { patch = UpdateSkillSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid body', issues: (err as { issues?: unknown }).issues })
    }

    // Version bump when any behaviour-defining field changed.
    const shouldBump = VERSIONED_FIELDS.some(f => patch[f] !== undefined)

    const updated = await prisma.skill.update({
      where: { id: skill.id },
      data: {
        ...patch,
        ...(shouldBump ? { version: skill.version + 1 } : {}),
      },
    })
    return reply.send(updated)
  })

  // ── DELETE /api/v1/skills/:id ───────────────────────────────────────────────
  // Soft-delete. Built-in skills are refused — an admin who doesn't like a
  // built-in should edit the prompt or unpublish, not delete.
  app.delete('/:id', { preHandler: requirePermission('configure', 'organization') }, async (req, reply) => {
    const { orgId, roles } = req.user
    const { id } = req.params as { id: string }
    if (!isAdmin(roles as string[] | undefined)) {
      return reply.status(403).send({ detail: 'Only admins can delete skills' })
    }

    const skill = await prisma.skill.findFirst({
      where: { id, orgId, ownerType: 'org', deletedAt: null },
    })
    if (!skill) return reply.status(404).send({ detail: 'Org skill not found' })

    await prisma.skill.update({
      where: { id: skill.id },
      data:  { deletedAt: new Date(), isPublished: false },
    })
    return reply.status(204).send()
  })
}
