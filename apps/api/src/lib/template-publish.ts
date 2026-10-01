/**
 * docs/41 Part 1 — publishing a template, and its default-for-type flag.
 *
 * Publishing snapshots the template (lib/template-snapshot.ts) with its clause
 * slots' variants pinned, runs template lint (lib/template-lint.ts) and keeps
 * the warnings with the version they judged. Drafts are made from the newest
 * published snapshot; editing the template afterwards is a draft revision
 * (`hasUnpublishedChanges`) until it is published again.
 */
import { AuditAction } from '@clm/types'
import { prisma } from './prisma.js'
import { buildSnapshot } from './template-snapshot.js'
import { lintTemplate, type LintWarning } from './template-lint.js'
import { createAuditEvent } from './audit.js'

export async function publishTemplate(orgId: string, templateId: string, userId: string): Promise<{ versionId: string; version: number; lint: LintWarning[] } | null> {
  const last = await prisma.templateVersion.findFirst({ where: { orgId, templateId }, orderBy: { version: 'desc' }, select: { version: true } })
  const version = (last?.version ?? 0) + 1
  const snapshot = await buildSnapshot(orgId, templateId, version)
  if (!snapshot) return null
  const lint = await lintTemplate(orgId, snapshot)
  const created = await prisma.$transaction(async tx => {
    const v = await tx.templateVersion.create({
      data: { orgId, templateId, version, snapshot: snapshot as never, lint: lint as never, publishedById: userId },
    })
    await tx.template.update({ where: { id: templateId }, data: { isPublished: true, publishedVersionId: v.id, hasUnpublishedChanges: false } })
    return v
  })
  await createAuditEvent({
    orgId, userId, action: AuditAction.TEMPLATE_PUBLISHED, resourceType: 'template', resourceId: templateId,
    metadata: { version, templateVersionId: created.id, warnings: lint.length },
  }).catch(err => console.warn('[template-publish] audit failed templateId=%s: %s', templateId, (err as Error).message))
  return { versionId: created.id, version, lint }
}

export type DefaultResult = { ok: true } | { ok: false; status: 404 | 422; detail: string }

/**
 * Make a template (or stop it being) the org's default for its contract type.
 * One per org and type: the previous default stops being it in the same
 * transaction (and a partial unique index refuses two).
 */
export async function setDefaultForType(orgId: string, templateId: string, isDefault: boolean, userId: string): Promise<DefaultResult> {
  const t = await prisma.template.findFirst({ where: { id: templateId, orgId, deletedAt: null }, select: { id: true, contractType: true, isPublished: true } })
  if (!t) return { ok: false, status: 404, detail: 'Template not found' }
  if (isDefault && !t.contractType) return { ok: false, status: 422, detail: 'Set the template’s contract type before making it the default for that type.' }
  if (isDefault && !t.isPublished) return { ok: false, status: 422, detail: 'Publish the template before making it the default.' }
  await prisma.$transaction([
    ...(isDefault ? [prisma.template.updateMany({ where: { orgId, contractType: t.contractType, isDefaultForType: true, NOT: { id: t.id } }, data: { isDefaultForType: false } })] : []),
    prisma.template.update({ where: { id: t.id }, data: { isDefaultForType: isDefault } }),
  ])
  await createAuditEvent({
    orgId, userId, action: AuditAction.TEMPLATE_DEFAULT_CHANGED, resourceType: 'template', resourceId: t.id,
    metadata: { contractType: t.contractType, isDefault },
  }).catch(err => console.warn('[template-publish] audit failed templateId=%s: %s', t.id, (err as Error).message))
  return { ok: true }
}
