import {
  cloudflareClientAnalyticsEventSchema as clientAnalyticsEventSchema,
  clientAnalyticsPropertiesContainLikelyPii
} from './promotional-analytics'
import { catalogPolicyOwnJson } from './catalog-publication-policy'
import { isPrivateAnalyticsRoute } from './analytics-privacy'
import type { z } from 'zod'

export type ClientAnalyticsEvent = z.infer<typeof clientAnalyticsEventSchema>
export type ClientAnalyticsEventName = ClientAnalyticsEvent['name']
export const ANALYTICS_SEARCH_OMITTED = '[omitted]'

/** The Node v1 contract requires a nonempty search query. A fixed marker keeps
 * that input compatible without transmitting the user's search text. Unknown
 * keys and likely PII are rejected BEFORE sanitization, not hidden by it. */
export function prepareClientAnalyticsEvent(input: unknown): {
  event: ClientAnalyticsEvent
  layer: Readonly<Record<string, string | number | null>>
} | null {
  try {
    const parsed = clientAnalyticsEventSchema.parse(catalogPolicyOwnJson(input))
    if ('path' in parsed.properties && isPrivateAnalyticsRoute(parsed.properties.path, {})) return null
    if (clientAnalyticsPropertiesContainLikelyPii(parsed)) return null
    if (parsed.name === 'search_completed') {
      const properties = Object.freeze({ query: ANALYTICS_SEARCH_OMITTED, resultCount: parsed.properties.resultCount })
      return {
        event: Object.freeze({ ...parsed, properties }),
        layer: Object.freeze({ event: parsed.name, resultCount: properties.resultCount })
      }
    }
    Object.freeze(parsed.properties)
    return { event: Object.freeze(parsed), layer: Object.freeze({ event: parsed.name, ...parsed.properties }) }
  } catch {
    return null
  }
}

/** One validated event, one transport attempt. No retries, providers, storage,
 * identity joins or consent defaults are introduced by the browser boundary. */
export async function dispatchClientAnalytics(
  input: { consent: boolean; path: string; query: object; event: unknown },
  transport: (event: ClientAnalyticsEvent) => Promise<unknown>,
  layer?: unknown[]
): Promise<void> {
  if (input.consent !== true || isPrivateAnalyticsRoute(input.path, input.query)) return
  const prepared = prepareClientAnalyticsEvent(input.event)
  if (prepared === null) return
  try {
    if (Array.isArray(layer)) layer.push(prepared.layer)
  } catch {
    // The optional compatibility sink may be frozen or unavailable. Its
    // failure must not prevent the single validated transport attempt.
  }
  try {
    await transport(prepared.event)
  } catch {
    // Measurement failure must not interfere with the storefront or schedule a
    // blind resend. Never log the payload, query, cookies or error body.
  }
}
