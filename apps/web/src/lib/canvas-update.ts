/**
 * X47 — what a document canvas reports as an edit.
 *
 * TipTap emits `update` for more than typing: `setEditable` emits one unless
 * told not to, and DocumentCanvas calls it whenever an editor mounts. The
 * contract page saves every reported change as a new version, so merely
 * opening a contract created an "Edited in-place" version — and, since the
 * save sends an approved contract back to DRAFT (X42), viewing one would
 * have undone its approval. A canvas reports a change only while it can be
 * edited.
 */
export function editedHtml(editor: { isEditable: boolean; getHTML(): string }): string | null {
  return editor.isEditable ? editor.getHTML() : null
}
