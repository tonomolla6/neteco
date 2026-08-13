import { z } from 'zod'
import { useDatabase } from '../../db/client'
import { confirmNewsletterSubscription } from '../../services/newsletter'
import { enforceRateLimit } from '../../utils/rate-limit'

const schema = z.object({ token: z.string().min(32).max(256) }).strict()

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  await enforceRateLimit(event, { scope: 'newsletter-confirm', limit: 10, windowSeconds: 900 })
  const runtime = useRuntimeConfig(event)
  const sql = useDatabase()
  const result = await sql.begin((transaction) =>
    confirmNewsletterSubscription(transaction, {
      token: body.token,
      tokenPepper: String(runtime.auth.tokenPepper),
      correlationId: event.context.correlationId ?? crypto.randomUUID()
    })
  )
  if (!result) throw createError({ statusCode: 400, statusMessage: 'El enlace no es válido o ha caducado' })
  return { ok: true }
})
