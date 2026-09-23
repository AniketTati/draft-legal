/**
 * Prometheus metrics (X3) — a few counters kept in process memory and
 * rendered in the text exposition format by GET /api/v1/metrics. No client
 * library: HTTP traffic, process memory, and the job queues' depths are what
 * an operator needs to see first, and they fit in this file.
 *
 * Labels use the route PATTERN (`/api/v1/contracts/:id`), never the URL, so
 * the series count stays bounded; requests that matched no route share one.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'

const requests = new Map<string, number>()                              // method|route|status
const durations = new Map<string, { sum: number; count: number }>()     // method|route
const startedAt = Date.now()

export function recordRequest(req: FastifyRequest, reply: FastifyReply): void {
  const route = req.routeOptions?.url ?? 'unmatched'
  const key = `${req.method}|${route}`
  const withStatus = `${key}|${reply.statusCode}`
  requests.set(withStatus, (requests.get(withStatus) ?? 0) + 1)
  const d = durations.get(key) ?? { sum: 0, count: 0 }
  d.sum += reply.elapsedTime / 1000
  d.count += 1
  durations.set(key, d)
}

const label = (v: string | number) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')

export type QueueCounts = Record<string, Record<string, number>>

export function renderMetrics(queues: QueueCounts | null): string {
  const out: string[] = []
  const metric = (name: string, type: string, help: string) => out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)

  metric('http_requests_total', 'counter', 'HTTP requests served, by route pattern and status code.')
  for (const [k, n] of requests) {
    const [method, route, status] = k.split('|')
    out.push(`http_requests_total{method="${label(method)}",route="${label(route)}",status_code="${label(status)}"} ${n}`)
  }
  metric('http_request_duration_seconds', 'summary', 'Time to serve HTTP requests, by route pattern.')
  for (const [k, d] of durations) {
    const [method, route] = k.split('|')
    const l = `method="${label(method)}",route="${label(route)}"`
    out.push(`http_request_duration_seconds_sum{${l}} ${d.sum}`, `http_request_duration_seconds_count{${l}} ${d.count}`)
  }

  const mem = process.memoryUsage()
  metric('process_resident_memory_bytes', 'gauge', 'Resident set size.')
  out.push(`process_resident_memory_bytes ${mem.rss}`)
  metric('nodejs_heap_used_bytes', 'gauge', 'V8 heap in use.')
  out.push(`nodejs_heap_used_bytes ${mem.heapUsed}`)
  metric('process_uptime_seconds', 'gauge', 'Seconds since this process started.')
  out.push(`process_uptime_seconds ${(Date.now() - startedAt) / 1000}`)

  if (queues) {
    metric('bullmq_jobs', 'gauge', 'Jobs per queue and state.')
    for (const [queue, counts] of Object.entries(queues)) {
      for (const [state, n] of Object.entries(counts)) {
        out.push(`bullmq_jobs{queue="${label(queue)}",state="${label(state)}"} ${n}`)
      }
    }
  }
  return out.join('\n') + '\n'
}
