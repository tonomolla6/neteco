import { describe, expect, it, vi } from 'vitest'
import { handleCartCommand, type CoordinatorDeps } from '../../workers/cart-coordinator'
import { CartRecoveryError } from '../../workers/marketing/cart-recovery'

const cartId = '10000000-0000-4000-8000-000000000091'
const commandId = '10000000-0000-4000-8000-000000000092'
const claims = {
  identityId: '10000000-0000-4000-8000-000000000093',
  sessionId: '10000000-0000-4000-8000-000000000094',
  sessionVersion: 1
}
const input = { id: '10000000-0000-4000-8000-000000000095', token: 'cr1.' + 'a'.repeat(64), expectedCartVersion: 2 }
const command = { type: 'cart-recovery-resume', commandId, cartId, payload: { claims, input } }

function dependencies(resumeRecovery?: ReturnType<typeof vi.fn>) {
  const deps = {
    database: { prepare: vi.fn(), batch: vi.fn() },
    getResponse: vi.fn(),
    putResponse: vi.fn(),
    setAlarm: vi.fn(),
    resumeRecovery
  }
  return { deps, call: () => handleCartCommand(command, deps as unknown as CoordinatorDeps) }
}

describe('recovery resumes use the cart serial executor without persisting possession', () => {
  it('returns the internal grant without reading or writing a Durable Object response cache', async () => {
    const result = {
      receipt: { source: 'cloudflare', commandId },
      cart: { cartId, token: 'private-internal-cart-grant', expiresAt: '2030-01-03T12:00:00Z' }
    }
    const resume = vi.fn(async () => result)
    const { deps, call } = dependencies(resume)
    expect(await call()).toEqual({ status: 200, body: result })
    expect(resume).toHaveBeenCalledWith(claims, input, commandId, cartId)
    expect(deps.getResponse).not.toHaveBeenCalled()
    expect(deps.putResponse).not.toHaveBeenCalled()
  })

  it('fails closed if the trusted runtime recovery adapter is unavailable', async () => {
    const { deps, call } = dependencies()
    expect(await call()).toEqual({ status: 503, body: { error: { code: 'service_unavailable' } } })
    expect(deps.database.prepare).not.toHaveBeenCalled()
    expect(deps.getResponse).not.toHaveBeenCalled()
  })

  it.each([
    { ...command, commandId: 'not-a-uuid' },
    { ...command, cartId: 'not-a-cart' },
    { ...command, payload: { claims, input: { ...input, price: 1 } } },
    { ...command, payload: { claims, input, now: '2099-01-01T00:00:00Z' } },
    { ...command, payload: { claims: { ...claims, sessionVersion: 0 }, input } }
  ])('rejects untrusted command data before entering recovery: %j', async (invalid) => {
    const resume = vi.fn()
    const { deps } = dependencies(resume)
    expect(await handleCartCommand(invalid, deps as unknown as CoordinatorDeps)).toEqual({
      status: 400,
      body: { error: { code: 'invalid_input' } }
    })
    expect(resume).not.toHaveBeenCalled()
    expect(deps.getResponse).not.toHaveBeenCalled()
  })

  it('reauthorizes a replay through the core and preserves its denial without a cache bypass', async () => {
    const resume = vi.fn(async () => {
      throw new CartRecoveryError('unauthenticated')
    })
    const { deps, call } = dependencies(resume)
    expect(await call()).toEqual({ status: 401, body: { error: { code: 'unauthenticated' } } })
    expect(deps.getResponse).not.toHaveBeenCalled()
    expect(deps.putResponse).not.toHaveBeenCalled()
  })
})
