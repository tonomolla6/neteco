import { z } from 'zod'
import { useDatabase } from '../../../db/client'
import { featureTargetingSchema } from '../../../utils/feature-flags'

const schema = z
  .object({
    description: z.string().trim().min(3).max(500),
    owner: z.string().trim().min(2).max(160),
    enabled: z.boolean(),
    targeting: featureTargetingSchema,
    expiresAt: z.string().datetime(),
    reason: z.string().trim().min(3).max(500)
  })
  .strict()

export default defineEventHandler(async (event) => {
  const administrator = await requireAdmin(event)
  const key = z
    .string()
    .regex(/^[a-z][a-z0-9._-]{2,79}$/)
    .parse(getRouterParam(event, 'key'))
  const body = await readValidatedBody(event, schema.parse)
  if (body.enabled && new Date(body.expiresAt) <= new Date()) {
    throw createError({ statusCode: 422, statusMessage: 'No se puede activar una flag caducada' })
  }
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const result = await sql.begin(async (transaction) => {
    const [before] = await transaction<
      { description: string; owner: string; enabled: boolean; targeting: unknown; expiresAt: Date }[]
    >`
      SELECT description, owner, enabled, targeting, expires_at AS "expiresAt"
      FROM feature_flags WHERE key = ${key} FOR UPDATE
    `
    if (!before) return null
    const beforeSnapshot = {
      description: before.description,
      owner: before.owner,
      enabled: before.enabled,
      targeting: featureTargetingSchema.parse(before.targeting),
      expiresAt: before.expiresAt.toISOString()
    }
    await transaction`
      UPDATE feature_flags SET description = ${body.description}, owner = ${body.owner}, enabled = ${body.enabled},
        targeting = ${transaction.json(body.targeting)}, expires_at = ${body.expiresAt},
        updated_by = ${administrator.id}, updated_at = now() WHERE key = ${key}
    `
    await transaction`
      INSERT INTO audit_log (actor_type, actor_id, action, resource_type, resource_id,
        before_redacted, after_redacted, reason, correlation_id)
      VALUES ('staff', ${administrator.id}, 'feature_flag.update', 'feature_flag', ${key},
        ${transaction.json(beforeSnapshot)},
        ${transaction.json({
          description: body.description,
          owner: body.owner,
          enabled: body.enabled,
          targeting: body.targeting,
          expiresAt: body.expiresAt
        })},
        ${body.reason}, ${correlationId})
    `
    return { key }
  })
  if (!result) throw createError({ statusCode: 404, statusMessage: 'Feature flag no encontrada' })
  return result
})
