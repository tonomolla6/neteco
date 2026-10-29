import { z } from 'zod'
import { clientAnalyticsEventSchema, containsLikelyPii } from '../server/utils/analytics'

const base = {
  eventId: z.string().uuid(),
  taxonomyVersion: z.literal('v1'),
  occurredAt: z.string().datetime()
}
const properties = {
  pageId: z.string().uuid(),
  publicationId: z.string().uuid(),
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  placement: z.enum(['home', 'catalog', 'category', 'product'])
}

/** Additive Cloudflare browser taxonomy. The legacy Node endpoint deliberately
 * keeps its own v1 schema. These are client-reported observations, not proof of
 * publication, purchase, consent or any financial fact. */
export const cloudflareClientAnalyticsEventSchema = z.discriminatedUnion('name', [
  ...clientAnalyticsEventSchema.options,
  z
    .object({
      ...base,
      name: z.literal('promotional_impression'),
      properties: z.object({ ...properties, blockId: z.null() }).strict()
    })
    .strict(),
  z
    .object({
      ...base,
      name: z.literal('promotional_click'),
      properties: z.object({ ...properties, blockId: z.string().uuid() }).strict()
    })
    .strict()
])

/** Call only AFTER strict schema validation. Promotional properties admit only
 * UUIDs, a fixed enum and an integer: regex-scanning them would mistake UUIDs
 * for telephone numbers. All legacy free-text fields retain their PII check. */
export function clientAnalyticsPropertiesContainLikelyPii(
  event: z.infer<typeof cloudflareClientAnalyticsEventSchema>
): boolean {
  if (event.name === 'promotional_impression' || event.name === 'promotional_click') return false
  return containsLikelyPii(event.properties)
}
