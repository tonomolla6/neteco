import { z } from 'zod'
import { useDatabase } from '../../../../../db/client'
import { scheduleContentPublication } from '../../../../../services/content-publication'
import { madridLocalDateTimeToInstant } from '../../../../../utils/madrid-calendar'

const schema = z
  .object({
    publishAtLocal: z.string().min(1).nullable(),
    unpublishAtLocal: z.string().min(1).nullable(),
    repeatedHour: z.enum(['earlier', 'later']).default('later'),
    reason: z.string().trim().min(3).max(500)
  })
  .strict()

function parseMadridSchedule(value: string | null, repeatedHour: 'earlier' | 'later') {
  if (!value) return null
  try {
    return madridLocalDateTimeToInstant(value, repeatedHour)
  } catch (error) {
    throw createError({
      statusCode: 422,
      statusMessage: error instanceof Error ? error.message : 'Fecha local Europe/Madrid inválida'
    })
  }
}

export default defineEventHandler(async (event) => {
  const authenticated = await requirePermission(event, 'catalog.publish', { mfa: true })
  const pageId = z.string().uuid().parse(getRouterParam(event, 'id'))
  const body = await readValidatedBody(event, schema.parse)
  const publishAt = parseMadridSchedule(body.publishAtLocal, body.repeatedHour)
  const unpublishAt = parseMadridSchedule(body.unpublishAtLocal, body.repeatedHour)
  const sql = useDatabase()
  return sql.begin((transaction) =>
    scheduleContentPublication(transaction, {
      pageId,
      publishAt,
      unpublishAt,
      actorId: authenticated.profile.id,
      reason: body.reason,
      correlationId: event.context.correlationId ?? crypto.randomUUID()
    })
  )
})
