/**
 * Marketing routes — public endpoints called from the marketing site
 * (draftlegal-marketing.web.app / draft-legal.com).
 *
 * No auth required: these are pre-signup touchpoints. Cross-origin from the
 * marketing site, so CORS in app.ts allows the marketing origins.
 *
 * Tight per-route rate-limit (5/hour/IP) keeps the contact form from
 * becoming a spam vector even with the lax cross-origin policy.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { sendEmail, isEmailConfigured } from '../lib/mailer.js'

const ContactSchema = z.object({
  name:    z.string().trim().min(1, 'name is required').max(200),
  email:   z.string().trim().email('valid work email is required').max(320),
  company: z.string().trim().max(200).optional().or(z.literal('').transform(() => undefined)),
  message: z.string().trim().min(5, 'message is too short').max(5000),
  source:  z.string().trim().max(120).optional().or(z.literal('').transform(() => undefined)),
})

export async function marketingRoutes(app: FastifyInstance) {
  // POST /api/v1/marketing/contact — public, rate-limited.
  app.post(
    '/contact',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 hour',
        },
      },
    },
    async (req, reply) => {
      const parsed = ContactSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid form data',
          details: parsed.error.flatten().fieldErrors,
        })
      }

      const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
        ?? req.ip
      const userAgent = (req.headers['user-agent'] as string | undefined) ?? null

      const row = await prisma.marketingContact.create({
        data: {
          name:    parsed.data.name,
          email:   parsed.data.email,
          company: parsed.data.company ?? null,
          message: parsed.data.message,
          source:  parsed.data.source ?? null,
          ip:      ip ?? null,
          userAgent,
        },
        select: { id: true, createdAt: true },
      })

      // Log so submissions show up in Cloud Run logs even before we wire an
      // email notification. Avoid logging the full message body to keep PII
      // out of log retention.
      app.log.info(
        {
          marketingContactId: row.id,
          email: parsed.data.email,
          company: parsed.data.company,
          source: parsed.data.source,
        },
        '[marketing] new contact submission',
      )

      // H1 — tell a human. The page promises a reply, but submissions used to
      // land in the table with nobody told. Fire-and-forget: a mail failure
      // must not fail the visitor's submission (it is already saved).
      const notifyTo = process.env.MARKETING_CONTACT_EMAIL
      if (notifyTo && isEmailConfigured()) {
        sendEmail({
          to: notifyTo,
          subject: `New contact: ${parsed.data.name}${parsed.data.company ? ` (${parsed.data.company})` : ''}`,
          text: `${parsed.data.name} <${parsed.data.email}>${parsed.data.company ? `, ${parsed.data.company}` : ''}`
            + `${parsed.data.source ? `\nSource: ${parsed.data.source}` : ''}\n\n${parsed.data.message}\n\n(submission ${row.id})`,
        }).catch(err => app.log.warn({ err, marketingContactId: row.id }, '[marketing] contact notification failed'))
      } else {
        app.log.warn({ marketingContactId: row.id }, '[marketing] contact saved but nobody notified — set MARKETING_CONTACT_EMAIL and an email provider')
      }

      return reply.status(201).send({ ok: true, id: row.id, createdAt: row.createdAt })
    },
  )

  // GET /api/v1/marketing/contact/health — cheap smoke probe (no DB read)
  app.get('/contact/health', async (_req, reply) => {
    return reply.send({ ok: true })
  })
}
