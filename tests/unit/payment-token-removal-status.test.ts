import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { BUYER_CLAIMS, CUSTOMER, returnsFixture, utc } from './d1-returns-fixture'
import { listPaymentTokens, requestPaymentTokenRemoval } from '../../workers/payments/token-removal'
import { recoverPaymentTokenRemovals } from '../../workers/payments/token-removal-recovery'
it('lets the owner see pending deletion until provider confirmation without exposing its reference', async () => {
  const f = await returnsFixture(),
    id = '40000000-0000-4000-8000-000000000022',
    commandId = '50000000-0000-4000-8000-000000000022'
  try {
    f.sqlite.exec(await readFile('db/d1/migrations/0126_payment_extended.sql', 'utf8'))
    f.sqlite
      .prepare(
        `INSERT INTO payment_saved_tokens(id,customer_id,provider_token,status,version,consent_version,consented_at,created_at,updated_at) VALUES(?,?,?,'active',1,'v1',?,?,?)`
      )
      .run(id, CUSTOMER, 'sensitive-reference', utc(), utc(), utc())
    await requestPaymentTokenRemoval(
      f.database,
      BUYER_CLAIMS,
      { tokenId: id, commandId, expectedVersion: 1 },
      { now: () => utc() }
    )
    const result = await listPaymentTokens(f.database, BUYER_CLAIMS, { now: () => utc() })
    expect(result).toMatchObject({ tokens: [], pending: [{ id, status: 'removal_pending', version: 2 }] })
    expect(JSON.stringify(result)).not.toContain('sensitive-reference')
    await recoverPaymentTokenRemovals(f.database, { remove: async () => 'deleted' }, { now: utc(), limit: 1 })
    expect(await listPaymentTokens(f.database, BUYER_CLAIMS, { now: () => utc() })).toMatchObject({
      tokens: [],
      pending: []
    })
  } finally {
    f.sqlite.close()
  }
})
