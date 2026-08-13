import { z } from 'zod'
import { useDatabase } from '../../db/client'
import { requestNewsletterSubscription } from '../../services/newsletter'
import { enforceRateLimit } from '../../utils/rate-limit'
import { sensitiveRateLimit } from '../../utils/abuse-limit'

const schema = z
  .object({
    email: z.string().trim().email().max(254),
    consent: z.literal(true),
    source: z.literal('footer').default('footer'),
    website: z.string().max(200).optional().default('')
  })
  .strict()

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  await enforceRateLimit(event, sensitiveRateLimit('newsletter-subscribe', body.email))
  if (body.website) {
    setResponseStatus(event, 202)
    return { ok: true, message: 'Si la dirección es elegible, recibirás un email para confirmar la suscripción.' }
  }
  const runtime = useRuntimeConfig(event)
  const sql = useDatabase()
  await sql.begin((transaction) =>
    requestNewsletterSubscription(transaction, {
      email: body.email,
      source: body.source,
      correlationId: event.context.correlationId ?? crypto.randomUUID(),
      secrets: {
        tokenPepper: String(runtime.auth.tokenPepper),
        encryptionKey: String(runtime.auth.encryptionKey)
      }
    })
  )
  setResponseStatus(event, 202)
  return { ok: true, message: 'Si la dirección es elegible, recibirás un email para confirmar la suscripción.' }
})
