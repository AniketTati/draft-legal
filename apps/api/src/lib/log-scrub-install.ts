/**
 * Y4 — imported first by each entrypoint (index.ts, worker-entrypoint.ts), so
 * every line the process prints passes the scrubber, from its first.
 */
import { installLogScrub } from './log-scrub.js'

installLogScrub()
