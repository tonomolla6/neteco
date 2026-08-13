import { z } from 'zod'
import { useDatabase } from '../../../db/client'
import { featureTargetingSchema } from '../../../utils/feature-flags'

export default defineEventHandler(async (event) => {
  const administrator = await requireAdmin(event)
  const key = z
    .string()
    .regex(/^[a-z][a-z0-9._-]{2,79}$/)
    .parse(getRouterParam(event, 'key'))
  const reason = z.string().trim().min(3).max(500).parse(getQuery(event).reason)
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const removed = await sql.begin(async (transaction) => {
    const [flag] = await transaction<
      { description: string; owner: string; enabled: boolean; targeting: unknown; expiresAt: Date }[]
    >`
      SELECT description, owner, enabled, targeting, expires_at AS "expiresAt"
      FROM feature_flags WHERE key = ${key} FOR UPDATE
    `
    if (!flag) return false
    if (flag.enabled) throw createError({ statusCode: 409, statusMessage: 'Desactiva la flag antes de eliminarla' })
    const snapshot = {
      description: flag.description,
      owner: flag.owner,
      enabled: flag.enabled,
      targeting: featureTargetingSchema.parse(flag.targeting),
      expiresAt: flag.expiresAt.toISOString()
    }
    await transaction`
      INSERT INTO audit_log (actor_type, actor_id, action, resource_type, resource_id,
        before_redacted, reason, correlation_id)
      VALUES ('staff', ${administrator.id}, 'feature_flag.delete', 'feature_flag', ${key},
        ${transaction.json(snapshot)}, ${reason}, ${correlationId})
    `
    await transaction`DELETE FROM feature_flags WHERE key = ${key}`
    return true
  })
  if (!removed) throw createError({ statusCode: 404, statusMessage: 'Feature flag no encontrada' })
  setResponseStatus(event, 204)
  return null
})
