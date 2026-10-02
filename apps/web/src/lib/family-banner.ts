/**
 * docs/41 P0.9 — the line a child contract shows about its parent.
 *
 * Every child showed "Split from binder", an amendment included, because the
 * banner only checked that a parent existed. Only a contract the binder split
 * carved out of a scanned bundle says it was split from it, in plain words;
 * an amendment says what it amends; anything else that it is linked.
 */
export interface FamilyLine {
  kind: 'split' | 'amendment' | 'linked'
  /** The words before the parent's title. */
  lead: string
  /** A quieter note after it, when there is one. */
  note: string | null
}

export function familyLine(family: {
  parent?: { id: string; title: string } | null
  relationshipType?: string | null
  /** docs/41 Part 13 — "Amendment No. 2", when it is numbered. */
  label?: string | null
  splitFromParent?: boolean
  siblings?: unknown[]
} | null | undefined): FamilyLine | null {
  if (!family?.parent) return null
  if (family.splitFromParent) {
    const n = (family.siblings?.length ?? 0) + 1
    return { kind: 'split', lead: 'Split from scanned file', note: `${n} agreement${n === 1 ? '' : 's'} were in that file` }
  }
  if (family.relationshipType === 'amendment') return { kind: 'amendment', lead: `${family.label ?? 'Amendment'} to`, note: null }
  if (family.label) return { kind: 'linked', lead: `${family.label} under`, note: null }
  return { kind: 'linked', lead: 'Linked to', note: null }
}
