import type { CustomerOperationsEnv } from './customer-operations-config'
import { z } from 'zod'
import { evaluateD1CartRecoveries, dispatchD1CartRecoveries } from '../marketing/cart-recovery'
import { operationFlag } from './operations-config'
import { configuredProductWatchSender, productWatchHmacKey } from './product-watch'

const disabled = () => ({ disabled: true, processed: 0, created: 0, sent: 0, skipped: 0, manualReview: 0 })
const seconds = z.number().int().min(1).max(2592000)
const policySchema = z
  .object({ enabled: z.boolean(), waitSeconds: seconds, frequencyCapSeconds: seconds, tokenTtlSeconds: seconds })
  .strict()

/** No inferred consent, default business policy, transactional sender or unbounded sweep. */
export async function dispatchConfiguredCartRecoveries(env: CustomerOperationsEnv, now: string) {
  if (!operationFlag(env.CART_RECOVERY_ENABLED) || env.AUTH_ENABLED !== 'true') return disabled()
  let policy: z.infer<typeof policySchema>
  try {
    if (
      typeof env.CART_RECOVERY_POLICY !== 'string' ||
      new TextEncoder().encode(env.CART_RECOVERY_POLICY).length > 1024
    )
      throw new Error()
    policy = policySchema.parse(JSON.parse(env.CART_RECOVERY_POLICY))
  } catch {
    throw new Error('cart_recovery_configuration_unavailable')
  }
  if (!policy.enabled) return disabled()
  const hmacKey = productWatchHmacKey(env)
  // Reuse the existing dedicated marketing transport and its environment/recipient
  // checks. Recovery has its own opt-in and allowlist; watch opt-ins cannot enable it.
  const adapter = configuredProductWatchSender({
    ...env,
    PRODUCT_WATCH_DELIVERY_ENABLED: env.CART_RECOVERY_DELIVERY_ENABLED,
    PRODUCT_WATCH_ALLOWED_RECIPIENTS: env.CART_RECOVERY_ALLOWED_RECIPIENTS
  })
  const options = { now: () => now, hmacKey, policy, limit: 5 }
  const evaluated = await evaluateD1CartRecoveries(env.DB, options)
  const deliveries = adapter
    ? await dispatchD1CartRecoveries(env.DB, adapter, { ...options, origin: env.AUTH_ORIGIN })
    : { sent: 0, skipped: 0, manualReview: 0 }
  return { disabled: false, ...evaluated, ...deliveries }
}
