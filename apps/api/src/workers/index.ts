// Start all BullMQ workers — imported from index.ts so they run with the API process
export { parseWorker } from './parse.worker.js'
export { agentWorker } from './agent.worker.js'
export { notificationWorker } from './notification.worker.js'
// P8 Step 6 — daily obligation + renewal scans
export { scanWorker } from './scan.worker.js'
// P10A — webhook delivery
export { webhookWorker } from './webhook.worker.js'
// Retryable sealing of executed contracts into their signed PDF
export { signingWorker } from './signing.worker.js'

// ─── Stuck-contract recovery ─────────────────────────────────────────────────
// Contracts stuck in an in-progress status (e.g. agents service restarted
// mid-flight), or whose parse job was lost while PENDING (C13), are reset to
// FAILED so users can retry. The rules live in lib/stuck-contracts.ts.

import { recoverStuckContracts, STUCK_THRESHOLD_MS } from '../lib/stuck-contracts.js'

// Run once on startup to catch any from a previous crash, then every 5 min
recoverStuckContracts().catch(err => console.error('[recovery] startup scan failed:', err))
setInterval(() => recoverStuckContracts().catch(err => console.error('[recovery] scan failed:', err)), STUCK_THRESHOLD_MS)
