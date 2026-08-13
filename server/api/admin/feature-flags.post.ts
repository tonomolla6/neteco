import { z } from 'zod'
import { useDatabase } from '../../db/client'
import { featureTargetingSchema } from '../../utils/feature-flags'

const schema = z
  .object({
    key: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9._-]{2,79}$/),
    description: z.string().trim().min(3).max(500),
    owner: z.string().trim().min(2).max(160),
    enabled: z.boolean().default(false),
    targeting: featureTargetingSchema,
    expiresAt: z.string().datetime()
  })
  .strict()

export default defineEventHandler(async (event) => {
  const administrator = await requireAdmin(event)
  const body = await readValidatedBody(event, schema.parse)
  if (new Date(body.expiresAt) <= new Date()) {
    throw createError({ statusCode: 422, statusMessage: 'La fecha de caducidad debe estar en el futuro' })
  }
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO feature_flags (key, description, owner, enabled, targeting, expires_at, created_by, updated_by)
      VALUES (${body.key}, ${body.description}, ${body.owner}, ${body.enabled},
              ${transaction.json(body.targeting)}, ${body.expiresAt}, ${administrator.id}, ${administrator.id})
    `
    await transaction`
      INSERT INTO audit_log (actor_type, actor_id, action, resource_type, resource_id,
        after_redacted, correlation_id)
      VALUES ('staff', ${administrator.id}, 'feature_flag.create', 'feature_flag', ${body.key},
        ${transaction.json({
          description: body.description,
          owner: body.owner,
          enabled: body.enabled,
          targeting: body.targeting,
          expiresAt: body.expiresAt
        })},
        ${correlationId})
    `
  })
  setResponseStatus(event, 201)
  return { key: body.key }
})
