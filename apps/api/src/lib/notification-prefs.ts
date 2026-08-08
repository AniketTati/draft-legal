/**
 * Notification delivery preferences — L6 #3.
 *
 * Settings → Notifications persists eleven controls, and until now nothing
 * anywhere read them: a grep for `preferences` across apps/api/src returned
 * exactly one hit — users.ts echoing the blob back to the client. The worker's
 * handleNotify emailed unconditionally. So a user could turn email off, see a
 * green "Saved", and keep receiving the same mail forever, which reads as a
 * broken product rather than a missing feature. The comment in SettingsPage
 * claiming the delivery side already honoured these flags was simply false.
 *
 * This lives in its own module rather than inside notification.worker.ts
 * because importing that file constructs a BullMQ Worker as a side effect: it
 * connects to Redis and never exits, so nothing can import it just to ask a
 * question. A pure decision function is both testable and reusable.
 */
import { prisma } from './prisma.js'

// Mirrors SettingsPage's DEFAULT_NOTIFS. These matter: a user who has never
// opened the settings page has no stored preferences at all, and the ABSENCE
// of a preference must mean "send", not "suppress".
export const NOTIFICATION_PREF_DEFAULTS: Record<string, boolean> = {
  approvalRequested:    true,
  approvalDecided:      true,
  contractUpdated:      false,
  contractExpiringSoon: true,
  mentioned:            true,
}

// Which stored toggle governs which notification type. A type with no entry is
// deliberately unmapped and always sends — ESCALATION and DELEGATION are
// direct, time-sensitive assignments to a named person rather than digestible
// updates, and the settings page offers no control to switch them off.
export const TYPE_TO_PREF: Record<string, string> = {
  APPROVAL_REQUEST: 'approvalRequested',
  APPROVAL_DECIDED: 'approvalDecided',
  CONTRACT_UPDATED: 'contractUpdated',
  OBLIGATION_DUE:   'contractExpiringSoon',
  RENEWAL_DUE:      'contractExpiringSoon',
  MENTION:          'mentioned',
}

/**
 * Should this notification type be emailed to this user?
 *
 * Returns a reason as well as a verdict so the worker can log WHY something
 * was suppressed — "no email arrived" is otherwise indistinguishable from a
 * broken mailer, which is the class of bug this whole fix is about.
 */
export async function shouldEmail(
  userId: string,
  type: string,
): Promise<{ emailed: boolean; reason: string }> {
  let prefs: Record<string, unknown> = {}
  try {
    const user = await prisma.user.findUnique({
      where:  { id: userId },
      select: { preferences: true },
    })
    const raw = user?.preferences
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const notif = (raw as Record<string, unknown>).notifications
      if (notif && typeof notif === 'object' && !Array.isArray(notif)) {
        prefs = notif as Record<string, unknown>
      }
    }
  } catch (err) {
    // Fail OPEN. A duplicate email is recoverable; a missed approval request
    // is not, and a preference lookup failure must not silently suppress one.
    return { emailed: true, reason: `preference lookup failed, defaulting to send: ${(err as Error).message}` }
  }

  // 'off' is offered in the UI as a digest cadence and means suppress-all.
  if (prefs.digest === 'off') return { emailed: false, reason: 'digest is off' }

  const key = TYPE_TO_PREF[type]
  if (!key) return { emailed: true, reason: `type ${type} is not user-suppressible` }

  const value = typeof prefs[key] === 'boolean'
    ? prefs[key] as boolean
    : NOTIFICATION_PREF_DEFAULTS[key] ?? true

  return value
    ? { emailed: true,  reason: `${key} is on` }
    : { emailed: false, reason: `${key} is off` }
}
