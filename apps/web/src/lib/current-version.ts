/**
 * DD4 — the version a contract stands on: `currentVersionId`, which an undo
 * moves back to the version before. The contract page showed the newest
 * version instead, so after "Undo" on an applied redline it still showed the
 * undone text, and an edit saved on top of it brought the change back.
 * The newest version is only the fallback, for a contract with no pointer.
 */
export function currentVersionOf<V extends { id: string }>(
  versions: readonly V[] | null | undefined,
  currentVersionId: string | null | undefined,
): V | null {
  const list = versions ?? []
  return list.find(v => v.id === currentVersionId) ?? list[0] ?? null
}
