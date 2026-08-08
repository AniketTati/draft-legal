/**
 * CoachMarks — first-visit guidance (U.3.1, doc 32 §10 + §14 decision 11).
 *
 * Per the locked decision: ONE coach mark, ever. No multi-step tour.
 *
 * What shows: a small pulsing toast in the bottom-right above the rail
 * with copy: "I'm focused on this contract — ask me anything or press
 * ⌘K." Auto-dismiss after 5 seconds OR on first interaction (any click /
 * keypress / scroll). Never re-shown after dismissal.
 *
 * Storage: `clm.coach.contract-detail.v2` flag. Bumping the suffix
 * shows it again to existing users.
 */
import { useEffect, useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { track } from '@/lib/telemetry'

const STORAGE_KEY = 'clm.coach.contract-detail.v2'
const AUTO_DISMISS_MS = 5_000

export function CoachMarks() {
  const [show, setShow] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(STORAGE_KEY) !== 'seen'
  })

  // Auto-dismiss after 5s + on any user interaction.
  useEffect(() => {
    if (!show) return
    const dismiss = (reason: string) => {
      window.localStorage.setItem(STORAGE_KEY, 'seen')
      track('coach_dismissed', { reason })
      setShow(false)
    }
    const t = window.setTimeout(() => dismiss('timeout'), AUTO_DISMISS_MS)
    const onAnyKey = () => dismiss('keydown')
    const onAnyScroll = () => dismiss('scroll')
    window.addEventListener('keydown', onAnyKey)
    window.addEventListener('scroll', onAnyScroll, { passive: true })
    track('coach_shown', {})
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('keydown', onAnyKey)
      window.removeEventListener('scroll', onAnyScroll)
    }
  }, [show])

  if (!show) return null

  const dismiss = () => {
    window.localStorage.setItem(STORAGE_KEY, 'seen')
    track('coach_dismissed', { reason: 'close' })
    setShow(false)
  }

  return (
    <div
      data-testid="coach-mark-rail-hint"
      role="status"
      aria-live="polite"
      className="fixed bottom-6 right-[400px] z-40 pointer-events-auto"
    >
      {/* The one coach mark is an "ask draftLegal" affordance, so it keeps the
          machine accent rather than becoming generic chrome. */}
      <div className="bg-assist-600 text-white rounded-card shadow-e2 px-4 py-3 max-w-xs flex items-start gap-2.5 animate-pulse-once">
        <Sparkles className="size-4 text-assist-200 mt-0.5 shrink-0" />
        <div className="flex-1 text-[12.5px] leading-relaxed">
          I'm focused on this contract — ask me anything or press <kbd className="px-1 py-0.5 rounded-chip bg-assist-700 text-[10.5px] font-mono">⌘K</kbd>
        </div>
        <button
          onClick={dismiss}
          className="text-assist-200 hover:text-white p-0.5"
          aria-label="Dismiss"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <style>{`
        @keyframes pulse-once {
          0%   { opacity: 0; transform: translateY(8px); }
          15%  { opacity: 1; transform: translateY(0); }
          85%  { opacity: 1; transform: translateY(0); }
          100% { opacity: 0; transform: translateY(8px); }
        }
        .animate-pulse-once {
          animation: pulse-once 5s ease-in-out forwards;
        }
      `}</style>
    </div>
  )
}
