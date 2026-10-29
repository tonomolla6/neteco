import { z } from 'zod'
import {
  evaluateD1ProductWatches,
  dispatchD1ProductWatchDeliveries,
  type ProductWatchSender
} from '../marketing/product-watch'
import { editorialMailbox } from '../marketing/newsletter-campaign-transport'
import { operationFlag, operationsEnvironment } from './operations-config'
import type { CustomerOperationsEnv } from './customer-operations-config'

function unavailable(): never {
  throw new Error('product_watch_configuration_unavailable')
}

/** The existing server-only authentication key is domain-separated by the
 * product-watch core. No new public secret or recipient-derived fallback. */
export function productWatchHmacKey(env: CustomerOperationsEnv): Uint8Array {
  if (typeof env.AUTH_TOKEN_PEPPER !== 'string') unavailable()
  const bytes = new TextEncoder().encode(env.AUTH_TOKEN_PEPPER)
  if (bytes.length < 32 || bytes.length > 128) unavailable()
  return bytes
}

/** Reuse the dedicated marketing binding, never the transactional sender.
 * Configuration is an explicit server opt-in, not newsletter subscription or
 * client input. A preproduction allowlist cannot turn into a production policy. */
export function configuredProductWatchSender(env: CustomerOperationsEnv): ProductWatchSender | null {
  if (!operationFlag(env.PRODUCT_WATCH_DELIVERY_ENABLED)) return null
  const environment = operationsEnvironment(env.APP_ENV)
  if (environment === 'local') unavailable()
  const origin = new URL(env.AUTH_ORIGIN)
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== env.AUTH_ORIGIN ||
    origin.username ||
    origin.password ||
    origin.hostname === 'localhost' ||
    origin.hostname.endsWith('.localhost') ||
    /\.(?:test|invalid)$/.test(origin.hostname) ||
    /^[\d.]+$/.test(origin.hostname) ||
    origin.hostname.includes(':')
  )
    unavailable()
  const from = env.NEWSLETTER_EMAIL_FROM
  if (
    !editorialMailbox(from) ||
    /\.(?:test|invalid)$/i.test(from) ||
    !env.NEWSLETTER_EMAIL ||
    typeof env.NEWSLETTER_EMAIL.send !== 'function'
  )
    unavailable()
  const raw = env.PRODUCT_WATCH_ALLOWED_RECIPIENTS ?? '[]'
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 4096) unavailable()
  let recipients: string[]
  try {
    recipients = z.array(z.string().max(254)).max(100).parse(JSON.parse(raw))
  } catch {
    unavailable()
  }
  if (
    recipients.some((value) => !editorialMailbox(value)) ||
    new Set(recipients).size !== recipients.length ||
    (environment !== 'production' && !recipients.length)
  )
    unavailable()
  return {
    async send(message) {
      // Refuse disallowed recipients before entering the provider boundary.
      // The durable dispatcher classifies this obligation for manual review.
      if (!editorialMailbox(message.to) || (environment !== 'production' && !recipients.includes(message.to)))
        unavailable()
      return env.NEWSLETTER_EMAIL.send({ ...message, from })
    }
  }
}

/** One bounded cursor batch and one bounded delivery batch per scheduled tick.
 * No I/O whatsoever while disabled; provider ambiguity remains manual_review
 * in the canonical durable dispatcher rather than an automatic resend. */
export async function dispatchConfiguredProductWatches(env: CustomerOperationsEnv, now: string) {
  if (!operationFlag(env.PRODUCT_WATCH_ENABLED) || env.AUTH_ENABLED !== 'true')
    return { disabled: true, processed: 0, created: 0, sent: 0, skipped: 0, manualReview: 0 }
  const hmacKey = productWatchHmacKey(env),
    adapter = configuredProductWatchSender(env)
  const options = { now: () => now, hmacKey, limit: 5 }
  const evaluated = await evaluateD1ProductWatches(env.DB, options)
  const deliveries = adapter
    ? await dispatchD1ProductWatchDeliveries(env.DB, adapter, { ...options, origin: env.AUTH_ORIGIN })
    : { sent: 0, skipped: 0, manualReview: 0 }
  return { disabled: false, processed: evaluated.processed, created: evaluated.created, ...deliveries }
}
