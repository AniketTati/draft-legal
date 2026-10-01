import { describe, it, expect, vi } from 'vitest'

// approval-reset loads the queues, which open a Redis connection.
vi.mock('./queue.js', () => ({ queueNotification: vi.fn(), agentQueue: {} }))
import { idleMinutes, noteRefusal, revisionConflict, AUTO_NOTES, MIN_NOTE_LENGTH } from './working-copy.js'
import { sameDocumentHtml } from './version-create.js'

describe('docs/41 Part 16 — working copy rules', () => {
  describe('revisionConflict', () => {
    it('lets the first save in when there is no working copy', () => {
      expect(revisionConflict(null, 0)).toBe(false)
      expect(revisionConflict(null, undefined)).toBe(false)
    })
    it('lets a save on the revision it last saw in', () => {
      expect(revisionConflict({ revision: 4 }, 4)).toBe(false)
    })
    it('refuses a save on an older revision: someone saved since', () => {
      expect(revisionConflict({ revision: 5 }, 4)).toBe(true)
    })
    it('refuses a first save when someone else already started one', () => {
      expect(revisionConflict({ revision: 1 }, 0)).toBe(true)
    })
    it('refuses a save on a copy that was saved as a version or discarded meanwhile', () => {
      expect(revisionConflict(null, 3)).toBe(true)
    })
  })

  describe('noteRefusal', () => {
    it('asks for a note of at least three characters', () => {
      expect(noteRefusal(undefined)).toMatch(/at least 3/)
      expect(noteRefusal('ok')).toMatch(/at least 3/)
      expect(noteRefusal('   ok   ')).toMatch(/at least 3/)
      expect(MIN_NOTE_LENGTH).toBe(3)
    })
    it('accepts a real note', () => {
      expect(noteRefusal('Capped liability at 12 months of fees')).toBeNull()
    })
    it('the automatic notes are notes too', () => {
      for (const n of Object.values(AUTO_NOTES)) expect(noteRefusal(n)).toBeNull()
    })
    it('refuses an essay', () => {
      expect(noteRefusal('x'.repeat(2001))).toMatch(/2,000/)
    })
  })

  describe('idleMinutes', () => {
    it('is 30 minutes unless set', () => {
      expect(idleMinutes({}, {})).toBe(30)
      expect(idleMinutes(null, {})).toBe(30)
    })
    it('follows the environment', () => {
      expect(idleMinutes({}, { WORKING_COPY_IDLE_MINUTES: '10' })).toBe(10)
    })
    it("the org's setting wins, and 0 turns it off", () => {
      expect(idleMinutes({ workingCopyIdleMinutes: 5 }, { WORKING_COPY_IDLE_MINUTES: '10' })).toBe(5)
      expect(idleMinutes({ workingCopyIdleMinutes: 0 }, {})).toBe(0)
    })
    it('ignores nonsense', () => {
      expect(idleMinutes({ workingCopyIdleMinutes: 'soon' }, { WORKING_COPY_IDLE_MINUTES: '-3' })).toBe(30)
    })
  })

  describe('sameDocumentHtml (X47)', () => {
    it('ignores line breaks between tags only', () => {
      expect(sameDocumentHtml('<p>a</p>\n<p>b</p>', '<p>a</p><p>b</p>')).toBe(true)
      expect(sameDocumentHtml('<p>a</p>', '<p>a </p>')).toBe(false)
    })
  })
})
