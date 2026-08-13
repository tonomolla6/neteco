import { z } from 'zod'

const base = {
  eventId: z.string().uuid(),
  taxonomyVersion: z.literal('v1'),
  occurredAt: z.string().datetime()
}

export const clientAnalyticsEventSchema = z.discriminatedUnion('name', [
  z
    .object({
      ...base,
      name: z.literal('page_view'),
      properties: z
        .object({
          path: z
            .string()
            .regex(/^\/[a-zA-Z0-9_/-]*$/)
            .max(240)
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...base,
      name: z.literal('catalog_viewed'),
      properties: z
        .object({
          category: z.string().max(120).nullable(),
          page: z.number().int().positive(),
          resultCount: z.number().int().nonnegative()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...base,
      name: z.literal('search_completed'),
      properties: z
        .object({ query: z.string().trim().min(1).max(80), resultCount: z.number().int().nonnegative() })
        .strict()
    })
    .strict(),
  z
    .object({
      ...base,
      name: z.literal('product_viewed'),
      properties: z
        .object({ productId: z.number().int().positive(), variantId: z.number().int().positive().nullable() })
        .strict()
    })
    .strict(),
  z
    .object({
      ...base,
      name: z.literal('cart_item_added'),
      properties: z
        .object({
          variantId: z.number().int().positive(),
          quantity: z.number().int().positive(),
          cartVersion: z.number().int().positive()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...base,
      name: z.literal('cart_item_removed'),
      properties: z
        .object({
          variantId: z.number().int().positive(),
          quantity: z.number().int().positive(),
          cartVersion: z.number().int().nonnegative()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...base,
      name: z.literal('checkout_started'),
      properties: z
        .object({ itemCount: z.number().int().nonnegative(), totalCents: z.number().int().nonnegative() })
        .strict()
    })
    .strict(),
  z
    .object({
      ...base,
      name: z.literal('web_vital'),
      properties: z
        .object({
          metric: z.enum(['LCP', 'CLS', 'INP']),
          value: z.number().nonnegative().max(120_000),
          rating: z.enum(['good', 'needs-improvement', 'poor']),
          path: z
            .string()
            .regex(/^\/[a-zA-Z0-9_/-]*$/)
            .max(240),
          navigationType: z.enum(['navigate', 'reload', 'back_forward', 'prerender', 'unknown'])
        })
        .strict()
    })
    .strict()
])

export function analyticsConsent(raw: string | undefined) {
  if (!raw) return false
  const values = new Set([raw])
  let decoded = raw
  for (let index = 0; index < 2; index += 1) {
    try {
      decoded = decodeURIComponent(decoded)
      values.add(decoded)
    } catch {
      break
    }
  }
  for (const value of values) {
    try {
      const first = JSON.parse(value.startsWith('j:') ? value.slice(2) : value) as
        string | { version?: string; analytics?: boolean }
      const parsed =
        typeof first === 'string' ? (JSON.parse(first) as { version?: string; analytics?: boolean }) : first
      if (parsed.version === 'v1' && parsed.analytics === true) return true
    } catch {
      // Try the next cookie serialization representation.
    }
  }
  return false
}

export function containsLikelyPii(value: unknown): boolean {
  const serialized = JSON.stringify(value)
  return /[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?34)?[ -]?[6789](?:[ -]?\d){8}|\b[XYZ]?\d{7,8}[A-Z]\b/i.test(serialized)
}
