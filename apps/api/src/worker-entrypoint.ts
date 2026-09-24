/**
 * worker-entrypoint.ts — runs the BullMQ workers as a standalone process, with
 * no Fastify API attached.
 *
 * Wave 4: in prod the API runs on Cloud Run with `--min-instances 0` (scale to
 * zero). Because the workers were imported into the API process, the time-based
 * jobs — approval escalation (48h), signature reminders (T-3d/T-1d), and the
 * daily obligation/renewal scans — silently never fired while the service was
 * idle. This entrypoint is deployed as a dedicated always-on worker service
 * (`--min-instances 1`), and the API service sets `WORKERS_ENABLED=false` so
 * jobs aren't double-consumed.
 *
 * Cloud Run still requires the container to listen on $PORT for its health
 * check, so we expose a tiny HTTP endpoint alongside the workers.
 */
import './lib/log-scrub-install.js'   // Y4 — first: every line this process prints is scrubbed
import http from 'node:http'
import './workers/index.js' // starts every BullMQ worker as an import side effect

const PORT = Number(process.env.PORT ?? 8080)

const server = http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('workers-ok\n')
    return
  }
  res.writeHead(404)
  res.end()
})

server.listen(PORT, '0.0.0.0', () => {
  console.info('[workers] BullMQ workers running; health endpoint on :%d', PORT)
})

// Cloud Run sends SIGTERM before stopping an instance — close the health server
// so in-flight jobs get a chance to settle, then exit.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.info('[workers] %s received — shutting down', sig)
    server.close(() => process.exit(0))
  })
}
