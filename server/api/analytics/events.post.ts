import { z } from 'zod'
import { useDatabase } from '../../db/client'
import { analyticsConsent, clientAnalyticsEventSchema, containsLikelyPii } from '../../utils/analytics'
import { applicationNow } from '../../utils/application-clock'
import { privateCookieOptions } from '../../utils/private-cookie'

export default defineEventHandler(async (event) => {
  if (!analyticsConsent(getCookie(event, 'neteco-consent-v1'))) {
    throw createError({ statusCode: 403, statusMessage: 'Analytics consent is required' })
  }
  const body = await readValidatedBody(event, clientAnalyticsEventSchema.parse)
  if (containsLikelyPii(body.properties)) {
    throw createError({ statusCode: 400, statusMessage: 'Analytics properties contain prohibited personal data' })
  }
  if (/\b(bot|crawler|spider|lighthouse|pagespeed)\b/i.test(getHeader(event, 'user-agent') ?? '')) {
    setResponseStatus(event, 202)
    return { accepted: false }
  }
  let anonymousId = getCookie(event, 'neteco-analytics-id')
  if (!anonymousId || !z.string().uuid().safeParse(anonymousId).success) {
    anonymousId = crypto.randomUUID()
    setCookie(event, 'neteco-analytics-id', anonymousId, privateCookieOptions(180 * 24 * 60 * 60))
  }
  const occurredAt = new Date(body.occurredAt)
  if (Math.abs(applicationNow().getTime() - occurredAt.getTime()) > 24 * 60 * 60 * 1000) {
    throw createError({ statusCode: 400, statusMessage: 'Analytics timestamp is outside the accepted window' })
  }
  const sql = useDatabase()
  await sql`
    INSERT INTO analytics_events (
      event_id, event_name, taxonomy_version, source, anonymous_id, properties, occurred_at
    ) VALUES (
      ${body.eventId}, ${body.name}, ${body.taxonomyVersion}, 'client', ${anonymousId},
      ${sql.json(body.properties)}, ${occurredAt}
    ) ON CONFLICT (event_id) DO NOTHING
  `
  setResponseStatus(event, 202)
  return { accepted: true }
})
