import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { BUYER_CLAIMS, CUSTOMER, returnsFixture, utc } from './d1-returns-fixture'
import { requestPaymentTokenRemoval } from '../../workers/payments/token-removal'
import { testNow } from '../support/deterministic'
it('scheduled worker dispatches an enabled internal deletion job without outbound fetch', async () => {
  const f = await returnsFixture(),
    id = '40000000-0000-4000-8000-000000000022',
    commandId = '50000000-0000-4000-8000-000000000022'
  const outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('external_forbidden'))
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  try {
    f.sqlite.exec(await readFile('db/d1/migrations/0126_payment_extended.sql', 'utf8'))
    f.sqlite
      .prepare(
        `INSERT INTO payment_saved_tokens(id,customer_id,provider_token,status,version,consent_version,consented_at,created_at,updated_at) VALUES(?,?,?,'active',1,'v1',?,?,?)`
      )
      .run(id, CUSTOMER, 'synthetic-ref', utc(), utc(), utc())
    await requestPaymentTokenRemoval(
      f.database,
      BUYER_CLAIMS,
      { tokenId: id, commandId, expectedVersion: 1 },
      { now: () => utc() }
    )
    const provider = vi.fn(async () => Response.json({ outcome: 'deleted' }))
    const env = {
      APP_ENV: 'local',
      AUTH_ENABLED: 'false',
      DB: f.database,
      ASYNC_JOBS: { send: async () => undefined },
      MEDIA: {},
      EMAIL: {},
      NEWSLETTER_EMAIL: {},
      PAYMENT_TOKEN_REMOVAL_ENABLED: 'true',
      PAYMENT_TOKEN_DELETION: { fetch: provider }
    } as unknown as CloudflareEnv
    // The small fixture omits independent scheduled subsystems. Their failure is
    // observable and must not starve this durable deletion job.
    const error = await worker
      .scheduled({ scheduledTime: testNow() } as ScheduledController, env)
      .catch((cause: unknown) => cause)
    if (error !== undefined) expect(error).toBeInstanceOf(AggregateError)
    expect(provider).toHaveBeenCalledTimes(1)
    expect(f.sqlite.prepare('SELECT status,provider_token FROM payment_saved_tokens WHERE id=?').get(id)).toMatchObject(
      { status: 'removed', provider_token: null }
    )
    expect(outbound).not.toHaveBeenCalled()
    expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-ref')
  } finally {
    f.sqlite.close()
    outbound.mockRestore()
    log.mockRestore()
  }
})
