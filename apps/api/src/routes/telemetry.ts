/**
 * Telemetry sink — L6 #13.
 *
 * `apps/web/src/lib/telemetry.ts` has posted to `/api/v1/telemetry/events`
 * from nine live call sites since B.5.17. The route was never registered in
 * app.ts, so every one of those posts 404'd. Nobody noticed because `flush()`
 * short-circuits to `console.debug` on localhost — the only place anyone
 * watches — so in development it looked like it was working, and in
 * production it silently dropped everything. Any product decision made on
 * "nobody uses Compare" therefore rested on no data at all.
 *
 * Deliberately unauthenticated. The client's primary transport is
 * `navigator.sendBeacon` on unload, which cannot attach an Authorization
 * header, and requiring auth here would just reinstate the silent failure in a
 * new form. Nothing in the payload is trusted or used for authorization, and
 * no identity is read from the body.
 *
 * The sink is the application log. That is a real destination — queryable
 * wherever logs already go — and it avoids a schema migration for data whose
 * retention policy has not been decided. If these events ever need to be
 * aggregated in-product, this is the one place to change.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

// Hard caps on everything. This endpoint is open to the internet, and an
// unbounded body that gets written to logs is both a flooding and a
// log-injection vector. Anything outside these bounds is rejected rather than
// truncated, so a client bug surfaces as a 400 instead of as quietly mangled
// analytics.
const MAX_EVENTS_PER_BATCH = 50

const TelemetryEventSchema = z.object({
  event: z.string().min(1).max(80).regex(/^[a-z0-9_]+$/, 'event names are lowercase_snake_case'),
  at:    z.number().int().nonnegative().optional(),
  props: z.record(
    z.string().max(60),
    z.union([z.string().max(200), z.number(), z.boolean(), z.null()]),
  ).refine(p => Object.keys(p).length <= 25, 'at most 25 properties').optional(),
})

const TelemetryBatchSchema = z.object({
  events: z.array(TelemetryEventSchema).min(1).max(MAX_EVENTS_PER_BATCH),
})

export async function telemetryRoutes(app: FastifyInstance) {
  app.post('/events', async (req, reply) => {
    let body
    try { body = TelemetryBatchSchema.parse(req.body) }
    catch (err) {
      return reply.status(400).send({ detail: 'Invalid telemetry batch', issues: (err as { issues?: unknown }).issues })
    }

    for (const e of body.events) {
      // Structured, one line per event, under a stable marker so these are
      // filterable. Event names are already constrained to
      // lowercase_snake_case by the schema, so nothing here can forge a log
      // line or inject control characters.
      app.log.info({
        telemetry: true,
        event:     e.event,
        props:     e.props ?? {},
        at:        e.at ?? Date.now(),
      }, 'telemetry.event')
    }

    // 202: accepted, not necessarily durable. Telemetry is best-effort by
    // design and the client drops on unload, so promising more would be a lie.
    return reply.status(202).send({ accepted: body.events.length })
  })
}
