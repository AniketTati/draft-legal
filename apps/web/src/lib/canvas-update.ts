/**
 * X47 — what a document canvas reports as an edit.
 *
 * TipTap emits `update` for more than changes to the document: `setEditable`
 * emits one, carrying an empty transaction, unless told not to, and
 * DocumentCanvas calls it whenever an editor mounts. The contract page saves
 * every reported change as a new version, so merely opening a contract
 * created an "Edited in-place" version — and, since the save sends an
 * approved contract back to DRAFT (X42), viewing one would have undone its
 * approval. Only an update whose transaction changed the document is an
 * edit, whether typed or made by a command from view mode (a defined term
 * applied everywhere, an AI rewrite).
 */
export function editedHtml(update: {
  editor: { getHTML(): string }
  transaction: { docChanged: boolean }
}): string | null {
  return update.transaction.docChanged ? update.editor.getHTML() : null
}
