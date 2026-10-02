/**
 * docs/41 Part 16 (C1) — the editor's draft changes: typing autosaves to the
 * working copy (debounced), never to a version. Holds the revision the
 * editor last saved on, so a save on top of someone else's is refused (409)
 * and offered back as a choice instead of overwriting them silently.
 */
import { useCallback, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  conflictOf, discardWorkingCopy, fetchWorkingCopy, putWorkingCopy, saveVersionFromWorkingCopy, workingCopyKey,
  type SaveVersionBody, type SaveVersionResult, type WorkingCopy, type WorkingCopyConflict,
} from '@/lib/working-copy'

export type DraftSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

/** How long typing pauses before it is saved. */
export const AUTOSAVE_MS = 1500

export function useWorkingCopy(contractId: string | undefined, opts: { onSaveError?: (err: unknown) => void } = {}) {
  const qc = useQueryClient()
  const revision = useRef(0)
  const baseVersionId = useRef<string | null>(null)
  const pending = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // One save at a time: a save made while another is out would carry its old revision.
  const inFlight = useRef<Promise<boolean> | null>(null)
  const [saveState, setSaveState] = useState<DraftSaveState>('idle')
  const [hasCopy, setHasCopy] = useState(false)
  // The same, for handlers that run before a re-render (a click, a save that just landed).
  const hasCopyNow = useRef(false)
  const [conflict, setConflict] = useState<WorkingCopyConflict | null>(null)
  const refused = useRef<string | null>(null)
  const onSaveError = useRef(opts.onSaveError)
  onSaveError.current = opts.onSaveError

  const adopt = useCallback((copy: WorkingCopy | null) => {
    revision.current = copy?.revision ?? 0
    if (copy) baseVersionId.current = copy.baseVersionId
    setHasCopy(!!copy)
    hasCopyNow.current = !!copy
    if (contractId) qc.setQueryData(workingCopyKey(contractId), copy)
  }, [contractId, qc])

  /** Read the draft changes, and save on top of them from now on. */
  const load = useCallback(async (versionId: string | null): Promise<WorkingCopy | null> => {
    if (!contractId) return null
    baseVersionId.current = versionId
    const copy = await fetchWorkingCopy(contractId)
    adopt(copy)
    setSaveState(copy ? 'saved' : 'idle')
    return copy
  }, [adopt, contractId])

  const put = useCallback(async (html: string, rev: number): Promise<boolean> => {
    if (!contractId) return false
    setSaveState('saving')
    try {
      adopt(await putWorkingCopy(contractId, { html, revision: rev, baseVersionId: baseVersionId.current }))
      setSaveState(pending.current == null ? 'saved' : 'dirty')
      return true
    } catch (err) {
      const c = conflictOf(err)
      if (c) {
        refused.current = html
        setConflict(c)
      } else {
        pending.current ??= html
        onSaveError.current?.(err)
      }
      setSaveState('error')
      return false
    }
  }, [adopt, contractId])

  /** Save what was typed now (⌘S, leaving, before a version is made). */
  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    if (inFlight.current) await inFlight.current
    const html = pending.current
    if (html == null) return true
    if (conflict) return false
    pending.current = null
    const p = put(html, revision.current)
    inFlight.current = p
    try { return await p } finally { inFlight.current = null }
  }, [conflict, put])

  const flushRef = useRef(flush)
  flushRef.current = flush

  /** The editor changed: save it once typing pauses. */
  const change = useCallback((html: string) => {
    pending.current = html
    setSaveState('dirty')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void flushRef.current() }, AUTOSAVE_MS)
  }, [])

  /** 409 → keep theirs: returns their HTML for the editor to show. */
  const reloadTheirs = useCallback(async (): Promise<string | null> => {
    pending.current = null
    refused.current = null
    setConflict(null)
    const copy = await load(baseVersionId.current)
    return copy?.html ?? null
  }, [load])

  /** 409 → keep mine: save this editor's text on top of theirs. */
  const overwrite = useCallback(async (): Promise<boolean> => {
    const html = pending.current ?? refused.current
    const theirs = conflict?.current?.revision ?? 0
    pending.current = null
    refused.current = null
    setConflict(null)
    return html == null ? true : put(html, theirs)
  }, [conflict, put])

  /** Make a version of the draft changes (the typing not yet saved included). */
  const saveVersion = useCallback(async (body: SaveVersionBody): Promise<SaveVersionResult> => {
    if (!contractId) throw new Error('No contract')
    if (!await flush()) throw new Error('Your latest changes could not be saved, so no version was made.')
    const result = await saveVersionFromWorkingCopy(contractId, body)
    adopt(null)
    baseVersionId.current = result.version.id
    setSaveState('idle')
    for (const key of ['contract', 'contract-versions', 'contract-stage']) qc.invalidateQueries({ queryKey: [key, contractId] })
    return result
  }, [adopt, contractId, flush, qc])

  /** Throw the draft changes away. */
  const discard = useCallback(async () => {
    if (!contractId) return
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    if (inFlight.current) await inFlight.current.catch(() => {})
    pending.current = null
    refused.current = null
    setConflict(null)
    await discardWorkingCopy(contractId)
    adopt(null)
    setSaveState('idle')
  }, [adopt, contractId])

  /** Typing not yet saved, or saved draft changes not yet a version. */
  const hasDraft = useCallback(() => hasCopyNow.current || pending.current != null || refused.current != null, [])
  /** Typing not yet sent to the server. */
  const hasPendingTyping = useCallback(() => pending.current != null || inFlight.current != null, [])

  return { saveState, hasCopy, hasDraft, hasPendingTyping, conflict, load, change, flush, reloadTheirs, overwrite, saveVersion, discard, dismissConflict: () => setConflict(null) }
}
