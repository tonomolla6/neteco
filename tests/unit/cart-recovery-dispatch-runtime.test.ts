import { describe, expect, it } from 'vitest'
import { dispatchConfiguredCartRecoveries } from '../../workers/runtime/cart-recovery'
import { environment } from '../support/customer-operations-fixture'

const now = '2030-01-02T12:00:00Z'
const policy = { enabled: true, waitSeconds: 3600, frequencyCapSeconds: 86400, tokenTtlSeconds: 86400 }
const disabled = { disabled: true, processed: 0, created: 0, sent: 0, skipped: 0, manualReview: 0 }
const enabledEnv = () =>
  environment({
    AUTH_ENABLED: 'true',
    CART_RECOVERY_ENABLED: 'true',
    AUTH_TOKEN_PEPPER: 'synthetic-recovery-runtime-hmac-0123456789abcdef'
  })

describe('recovery scheduler explicit policy and provider boundary', () => {
  it.each([{ CART_RECOVERY_ENABLED: 'false' }, { AUTH_ENABLED: 'false' }])(
    'does no I/O while either authority is disabled: %j',
    async (overrides) => {
      const env = {
        ...enabledEnv(),
        ...overrides,
        CART_RECOVERY_POLICY: 'invalid',
        CART_RECOVERY_DELIVERY_ENABLED: 'true'
      }
      expect(await dispatchConfiguredCartRecoveries(env, now)).toEqual(disabled)
      expect(env.DB.prepare).not.toHaveBeenCalled()
    }
  )

  it.each([
    undefined,
    'null',
    '{}',
    '{',
    JSON.stringify({ ...policy, recipient: 'client@example.net' }),
    JSON.stringify({ ...policy, waitSeconds: 0 })
  ])('rejects absent or unapproved business policy instead of activating defaults: %s', async (value) => {
    const env = { ...enabledEnv(), CART_RECOVERY_POLICY: value }
    await expect(dispatchConfiguredCartRecoveries(env, now)).rejects.toThrow('cart_recovery_configuration_unavailable')
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('does no I/O when the explicit business policy is OFF', async () => {
    const env = { ...enabledEnv(), CART_RECOVERY_POLICY: JSON.stringify({ ...policy, enabled: false }) }
    expect(await dispatchConfiguredCartRecoveries(env, now)).toEqual(disabled)
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('does not disguise an enabled D1 evaluator outage as a successful disabled job', async () => {
    const env = { ...enabledEnv(), CART_RECOVERY_POLICY: JSON.stringify(policy) }
    await expect(dispatchConfiguredCartRecoveries(env, now)).rejects.toThrow()
    expect(env.DB.prepare).toHaveBeenCalled()
  })

  it('rejects external delivery in the local environment before evaluating or sending', async () => {
    const env = {
      ...enabledEnv(),
      CART_RECOVERY_POLICY: JSON.stringify(policy),
      CART_RECOVERY_DELIVERY_ENABLED: 'true'
    }
    await expect(dispatchConfiguredCartRecoveries(env, now)).rejects.toThrow()
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })
})
