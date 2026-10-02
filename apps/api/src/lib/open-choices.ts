/**
 * docs/41 P0.4 — terms a draft left as choices to make.
 *
 * A legal choice the request didn't name and the org hasn't made its own
 * default (governing law, venue…) is left as the template's blank — the
 * unfilled-variable span — rather than guessed. Until each is filled, the
 * draft can't go out: not for signature, not to the counterparty.
 */
import { slotChoiceKey, type DraftOrigin } from '@clm/types'
import { prisma } from './prisma.js'
import { labelOfKey, templateOf, variablesIn } from './draft-variables.js'

/** `slot`: a clause choice (docs/41 Part 1), made in the Origin panel rather than the Variables panel. */
export interface OpenChoice { key: string; label: string; slot?: string }

/** The blanks in the version the contract stands on, each once, named as its template names it. */
export async function openChoices(contractId: string): Promise<OpenChoice[]> {
  const c = await prisma.contract.findUnique({ where: { id: contractId }, select: { currentVersionId: true, metadata: true } })
  if (!c?.currentVersionId) return []
  const v = await prisma.contractVersion.findUnique({ where: { id: c.currentVersionId }, select: { htmlContent: true } })
  const template = templateOf(c.metadata)
  const slots = ((c.metadata as { _origin?: DraftOrigin } | null)?._origin?.slots ?? [])
  return variablesIn(v?.htmlContent)
    .filter(p => p.unfilled)
    .map(p => {
      const slot = slots.find(s => slotChoiceKey(s.familyId) === p.key)
      if (slot) return { key: p.key, label: slot.familyName, slot: slot.familyId }
      return { key: p.key, label: template?.variables?.find(d => d.key === p.key)?.label?.trim() || labelOfKey(p.key) }
    })
}

/** Why a draft with open choices can't be sent, in one sentence. */
export function openChoicesMessage(choices: OpenChoice[], action: string): string {
  const names = choices.map(c => c.label)
  const list = names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
  const panels = choices.every(c => c.slot) ? 'the Origin panel' : choices.some(c => c.slot) ? 'the Variables and Origin panels' : 'the Variables panel'
  return `${choices.length === 1 ? '1 choice is' : `${choices.length} choices are`} still open in the draft (${list}). Choose ${choices.length === 1 ? 'it' : 'them'} in ${panels} before ${action}.`
}
