import { createHash } from 'node:crypto'
import { z } from 'zod'

export const featureTargetingSchema = z
  .object({
    environments: z
      .array(z.enum(['local', 'test', 'preview', 'demo', 'staging', 'production']))
      .max(6)
      .default([]),
    percentage: z.number().int().min(0).max(100).default(100),
    roles: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    customerIds: z.array(z.string().uuid()).max(100).default([])
  })
  .strict()

export type FeatureEnvironment = z.infer<typeof featureTargetingSchema>['environments'][number]

export interface FeatureFlagContext {
  environment: FeatureEnvironment
  subjectId?: string | null
  roles?: string[]
  customerId?: string | null
}

export function featureFlagMatches(
  flag: { key: string; enabled: boolean; expiresAt: Date; targeting: z.infer<typeof featureTargetingSchema> },
  context: FeatureFlagContext,
  now = new Date()
) {
  if (!flag.enabled || flag.expiresAt <= now) return false
  const parsedTargeting = featureTargetingSchema.safeParse(flag.targeting)
  if (!parsedTargeting.success) return false
  const targeting = parsedTargeting.data
  if (targeting.environments.length && !targeting.environments.includes(context.environment)) return false
  if (targeting.roles.length && !context.roles?.some((role) => targeting.roles.includes(role))) return false
  if (targeting.customerIds.length && (!context.customerId || !targeting.customerIds.includes(context.customerId)))
    return false
  if (targeting.percentage === 100) return true
  if (targeting.percentage === 0 || !context.subjectId) return false
  const bucket = createHash('sha256').update(`${flag.key}:${context.subjectId}`).digest().readUInt32BE(0) % 100
  return bucket < targeting.percentage
}
