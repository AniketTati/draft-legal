/**
 * scan.worker — daily obligation + renewal scan (Phase 08 Step 6).
 *
 * Three repeatable BullMQ jobs are registered on startup:
 *   • obligation-scan-daily — runs scanObligations() every day at 09:00 UTC
 *   • renewal-scan-daily    — runs scanRenewals()    every day at 09:15 UTC
 *   • notification-digest   — runs sendDueDigests()  every 15 minutes (Z4):
 *     each person's daily digest goes from 9am in their own timezone
 *
 * Idempotent registration: BullMQ dedups repeatable jobs by their
 * pattern + jobId, so re-importing this module on every API restart is
 * safe — it'll either insert a new repeatable record or replace the
 * existing one's nextRunAt without orphaning entries.
 *
 * Why repeatable jobs (not setInterval): repeatable jobs survive
 * process restarts via Redis, fan out to multiple worker replicas, and
 * are visible in the Bull Board UI for ops to inspect/replay.
 */
import { Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { scanQueue } from '../lib/queue.js'
import { scanObligations, scanRenewals } from '../lib/obligation-scanner.js'
import { scanStageDates } from '../lib/lifecycle-dates.js'
import { sendDueDigests } from '../lib/notification-digest.js'

const OBLIGATION_PATTERN = process.env.OBLIGATION_SCAN_PATTERN ?? '0 9 * * *'   // 09:00 UTC daily
const RENEWAL_PATTERN    = process.env.RENEWAL_SCAN_PATTERN    ?? '15 9 * * *'  // 09:15 UTC daily
const DIGEST_PATTERN     = process.env.DIGEST_PATTERN          ?? '*/15 * * * *' // every 15 minutes

async function registerRepeatable(name: string, pattern: string, payload: Record<string, unknown> = {}) {
  // BullMQ uses the jobId so repeated invocations from process restart
  // don't create duplicate schedules. Removing first ensures pattern
  // changes (e.g. via env override) take effect on next deploy.
  try {
    await scanQueue.removeRepeatable(name, { pattern })
  } catch {/* ignore */}
  await scanQueue.add(name, payload, {
    repeat: { pattern },
    removeOnComplete: 50,
    removeOnFail:     50,
    jobId: `repeat-${name}`,
  })
}

// Run the registration at module-load. Wrapped so we don't crash the
// API on Redis hiccups during cold start — an exception just means the
// next scan will be scheduled on the next process tick.
;(async () => {
  try {
    await registerRepeatable('obligation-scan-daily', OBLIGATION_PATTERN)
    await registerRepeatable('renewal-scan-daily',    RENEWAL_PATTERN)
    await registerRepeatable('notification-digest',   DIGEST_PATTERN)
    console.info(
      '[scan-worker] registered repeatable jobs · obligations=%s renewals=%s digests=%s',
      OBLIGATION_PATTERN, RENEWAL_PATTERN, DIGEST_PATTERN,
    )
  } catch (err) {
    console.error('[scan-worker] failed to register repeatable jobs:', err)
  }
})()

export const scanWorker = new Worker(
  'scans',
  async (job) => {
    const start = Date.now()
    if (job.name === 'obligation-scan-daily') {
      const result = await scanObligations({ leadDays: 7 })
      console.info(
        '[scan-worker] obligation-scan-daily · %dms · scanned=%d notified=%d skippedAcked=%d skippedCooldown=%d errors=%d',
        Date.now() - start,
        result.scannedContracts, result.notified, result.skippedAcked,
        result.skippedCooldown,  result.errors.length,
      )
      return result
    }
    if (job.name === 'renewal-scan-daily') {
      // docs/41 Part 18 — dates move contracts first (Expiring, Expired), then renewals are noticed.
      const dates = await scanStageDates()
      console.info('[scan-worker] stage dates · scanned=%d moved=%j errors=%d', dates.scanned, dates.moved, dates.errors.length)
      const result = await scanRenewals({ leadDays: 90 })
      console.info(
        '[scan-worker] renewal-scan-daily · %dms · scanned=%d notified=%d skippedCooldown=%d errors=%d',
        Date.now() - start,
        result.scannedContracts, result.notified, result.skippedCooldown,
        result.errors.length,
      )
      return result
    }
    if (job.name === 'notification-digest') {
      const result = await sendDueDigests()
      if (result.users > 0) {
        console.info(
          '[scan-worker] notification-digest · %dms · users=%d sent=%d notifications=%d waiting=%d errors=%d',
          Date.now() - start, result.users, result.sent, result.notifications, result.waiting, result.errors.length,
        )
      }
      return result
    }
  },
  { connection: redis, concurrency: 1 }, // serial — these are bulk passes
)

scanWorker.on('failed', (job, err) => {
  console.error('[scan-worker] job %s/%s failed: %s', job?.name, job?.id, err.message)
})
