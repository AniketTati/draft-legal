/**
 * docs/41 P1 (Part 3) — which playbook a contract is reviewed against, and
 * why, decided in code.
 *
 * "The playbook" used to be every position the org had, filtered by the
 * contract's type: two playbooks for one type couldn't exist, and no screen
 * could say which one a review used. A Playbook is now a named set of
 * positions for the types it covers, and the one that applies is, in order:
 *
 *   1. the one a person chose on the contract (`explicit`);
 *   2. the default for the contract's type — a default naming the type
 *      before an all-types default (`default_for_type`);
 *   3. the only playbook that covers the type (`only_one`);
 *   4. otherwise nobody can say: the person is asked (`ambiguous`), or there
 *      is none to use (`none`).
 *
 * Every reader of positions for a contract (the automatic review, the rules
 * check, the redline, the findings) takes them from here, so they can't
 * disagree about which playbook applies.
 *
 * A position written by an older path has no playbook; it is read as part of
 * the org's all-types default playbook (or, when the org has no playbook at
 * all, as the only one) until it is moved.
 */
import type { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { moduleLogger } from './logger.js'

const log = moduleLogger('playbook')

export type PlaybookWhy = 'explicit' | 'default_for_type' | 'only_one' | 'ambiguous' | 'none'

export interface PlaybookSummary {
  id: string
  name: string
  contractTypes: string[]
  isDefaultForType: boolean
  version: number
}

export interface PlaybookResolution {
  playbook: PlaybookSummary | null
  why: PlaybookWhy
  /** The playbooks that cover the contract's type (to choose from when ambiguous). */
  candidates: PlaybookSummary[]
  /** One sentence for the screen. */
  explanation: string
  /** Positions with no playbook are read with this one (it is the org's all-types default, or there is no playbook). */
  includesUnfiled: boolean
}

const SUMMARY = { id: true, name: true, contractTypes: true, isDefaultForType: true, version: true } as const

const covers = (p: PlaybookSummary, type: string) => p.contractTypes.length === 0 || p.contractTypes.includes(type)
const typeName = (t: string) => t.replace(/_/g, ' ')

/**
 * Pure: the resolution for a contract of `contractType`, given the org's
 * live playbooks and the contract's explicit choice.
 */
export function choosePlaybook(playbooks: PlaybookSummary[], contractType: string, explicitId: string | null | undefined): Omit<PlaybookResolution, 'includesUnfiled'> {
  const candidates = playbooks.filter(p => covers(p, contractType))
  const explicit = explicitId ? playbooks.find(p => p.id === explicitId) : undefined
  if (explicit) return { playbook: explicit, why: 'explicit', candidates, explanation: `Using ${explicit.name}, chosen for this contract.` }
  const defaults = candidates.filter(p => p.isDefaultForType)
  const forType = defaults.find(p => p.contractTypes.includes(contractType)) ?? defaults.find(p => p.contractTypes.length === 0)
  if (forType) {
    const others = candidates.length - 1
    return {
      playbook: forType, why: 'default_for_type', candidates,
      explanation: others > 0
        ? `${candidates.length} playbooks apply — using ${forType.name} (the default for ${typeName(contractType)} contracts).`
        : `Using ${forType.name}, the default for ${typeName(contractType)} contracts.`,
    }
  }
  if (candidates.length === 1) return { playbook: candidates[0], why: 'only_one', candidates, explanation: `Using ${candidates[0].name}, the only playbook for ${typeName(contractType)} contracts.` }
  if (candidates.length > 1) {
    return { playbook: null, why: 'ambiguous', candidates, explanation: `${candidates.length} playbooks cover ${typeName(contractType)} contracts and none is the default. Choose one for this contract.` }
  }
  return { playbook: null, why: 'none', candidates, explanation: `No playbook covers ${typeName(contractType)} contracts.` }
}

/** The playbook a contract (or, with no contract, a contract type) is reviewed against. */
export async function resolvePlaybook(orgId: string, target: { type: string; playbookId?: string | null; id?: string }): Promise<PlaybookResolution> {
  const playbooks = await prisma.playbook.findMany({
    where: { orgId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: SUMMARY,
  })
  const chosen = choosePlaybook(playbooks, target.type, target.playbookId)
  // An org from before playbooks, with positions and no playbook row: its
  // positions are the playbook, as they always were.
  if (playbooks.length === 0) {
    const unfiled = await prisma.playbookPosition.count({ where: { orgId, playbookId: null, ...typeFilter(target.type) } })
    if (unfiled > 0) {
      const res: PlaybookResolution = {
        playbook: { id: '', name: 'Your playbook', contractTypes: [], isDefaultForType: true, version: 1 },
        why: 'only_one', candidates: [], includesUnfiled: true,
        explanation: 'Using your playbook.',
      }
      log.info({ orgId, contractId: target.id ?? null, contractType: target.type, why: res.why }, 'playbook.resolve')
      return res
    }
  }
  const res: PlaybookResolution = {
    ...chosen,
    includesUnfiled: !!chosen.playbook && chosen.playbook.isDefaultForType && chosen.playbook.contractTypes.length === 0,
  }
  log.info({ orgId, contractId: target.id ?? null, contractType: target.type, playbookId: res.playbook?.id ?? null, why: res.why }, 'playbook.resolve')
  return res
}

/** Positions that apply to a contract type ([] = every type). */
function typeFilter(contractType: string | null | undefined): Prisma.PlaybookPositionWhereInput {
  return contractType ? { OR: [{ contractTypes: { isEmpty: true } }, { contractTypes: { has: contractType } }] } : {}
}

/**
 * The Prisma filter for the positions of the resolved playbook that apply to
 * this contract type. Null when no playbook applies: there is nothing to read.
 */
export function positionWhere(orgId: string, resolution: PlaybookResolution, contractType: string | null | undefined): Prisma.PlaybookPositionWhereInput | null {
  if (!resolution.playbook) return null
  const ofPlaybook: Prisma.PlaybookPositionWhereInput = resolution.playbook.id
    ? (resolution.includesUnfiled ? { OR: [{ playbookId: resolution.playbook.id }, { playbookId: null }] } : { playbookId: resolution.playbook.id })
    : { playbookId: null }
  return { orgId, AND: [ofPlaybook, typeFilter(contractType)] }
}

/** The resolution and the position filter for one contract, together. */
export async function contractPlaybook(orgId: string, contract: { id?: string; type: string; playbookId?: string | null }): Promise<{ resolution: PlaybookResolution; where: Prisma.PlaybookPositionWhereInput | null }> {
  const resolution = await resolvePlaybook(orgId, contract)
  return { resolution, where: positionWhere(orgId, resolution, contract.type) }
}

/** The playbook new positions go into when none is named: the org's all-types default, made if missing. */
export async function defaultPlaybookId(orgId: string, createdById?: string | null): Promise<string> {
  const existing = await prisma.playbook.findFirst({
    where: { orgId, deletedAt: null, isDefaultForType: true, contractTypes: { isEmpty: true } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  }) ?? await prisma.playbook.findFirst({ where: { orgId, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } })
  if (existing) return existing.id
  const created = await prisma.playbook.create({
    data: { orgId, name: 'Default playbook', contractTypes: [], isDefaultForType: true, createdById: createdById ?? null },
    select: { id: true },
  })
  return created.id
}

/** Positions changed: the playbook's version goes up, so a review can say which it read. */
export async function bumpPlaybookVersion(playbookId: string | null | undefined): Promise<void> {
  if (!playbookId) return
  await prisma.playbook.update({ where: { id: playbookId }, data: { version: { increment: 1 } } }).catch(() => {})
}
