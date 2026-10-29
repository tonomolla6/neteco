import { describe, expect, it } from 'vitest'
import { creditWorld } from './d1-b2b-credit-fixture'
import { CLAIMS, BUYER_CLAIMS } from './d1-returns-fixture'
import { placeOrder } from '../../workers/catalog/checkout'
import { listD1B2BTransferSimulations, reconcileD1B2BTransfer } from '../../workers/catalog/b2b-transfer-reconciliation'

async function world() {
  const f = await creditWorld(),
    input = await f.input()
  f.terms(input.expectedTotalGrossCents)
  const result = await placeOrder(f.database, input)
  if (result.outcome !== 'order_created') throw new Error(result.outcome)
  const orderId = result.body.id as string,
    total = input.expectedTotalGrossCents
  const options = { environment: 'local', idempotencyKey: crypto.randomUUID(), now: () => f.now }
  const command = {
    expectedOutstandingCents: total,
    amountCents: total,
    bankReference: 'FAKE-EXAMPLE-1',
    reason: 'Prueba de conciliación'
  }
  return { ...f, orderId, total, options, command }
}
describe('local transfer reconciliation', () => {
  it('records a simulated full transfer while keeping actual credit and payment unchanged', async () => {
    const f = await world()
    try {
      const receipt = await reconcileD1B2BTransfer(f.database, CLAIMS, f.orderId, f.command, f.options)
      expect(receipt).toMatchObject({ orderId: f.orderId, validationOnly: true, simulatedOutstandingCents: 0 })
      expect(await listD1B2BTransferSimulations(f.database, CLAIMS, f.options)).toMatchObject([
        { orderId: f.orderId, outstandingCents: f.total, simulatedOutstandingCents: 0 }
      ])
      expect(
        f.sqlite.prepare('SELECT outstanding_cents FROM b2b_credit_open_amounts WHERE order_id=?').get(f.orderId)
      ).toMatchObject({ outstanding_cents: f.total })
      expect(
        f.sqlite.prepare('SELECT status FROM order_payment_states WHERE order_id=?').get(f.orderId)
      ).toBeUndefined()
    } finally {
      f.sqlite.close()
    }
  })
  it('replays identical commands and rejects changed payloads', async () => {
    const f = await world()
    try {
      const one = await reconcileD1B2BTransfer(f.database, CLAIMS, f.orderId, f.command, f.options)
      expect(await reconcileD1B2BTransfer(f.database, CLAIMS, f.orderId, f.command, f.options)).toEqual(one)
      await expect(
        reconcileD1B2BTransfer(f.database, CLAIMS, f.orderId, { ...f.command, amountCents: 1 }, f.options)
      ).rejects.toMatchObject({ code: 'conflict' })
    } finally {
      f.sqlite.close()
    }
  })
  it('serializes competing partial simulations against the same balance', async () => {
    const f = await world()
    try {
      const command = { ...f.command, amountCents: Math.ceil(f.total / 2) }
      const results = await Promise.allSettled([
        reconcileD1B2BTransfer(f.database, CLAIMS, f.orderId, command, f.options),
        reconcileD1B2BTransfer(
          f.database,
          CLAIMS,
          f.orderId,
          { ...command, bankReference: 'FAKE-EXAMPLE-2' },
          { ...f.options, idempotencyKey: crypto.randomUUID() }
        )
      ])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    } finally {
      f.sqlite.close()
    }
  })
  it.each(['production', 'preview', 'test', ''])('refuses execution outside local: %s', async (environment) => {
    const f = await world()
    try {
      await expect(
        reconcileD1B2BTransfer(f.database, CLAIMS, f.orderId, f.command, { ...f.options, environment })
      ).rejects.toMatchObject({ code: 'unavailable' })
      expect(f.sqlite.prepare('SELECT count(*) n FROM b2b_transfer_simulations').get()).toMatchObject({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects an unprivileged actor and invalid or duplicated references', async () => {
    const f = await world()
    try {
      await expect(
        reconcileD1B2BTransfer(f.database, BUYER_CLAIMS, f.orderId, f.command, f.options)
      ).rejects.toMatchObject({ code: 'mfa_required' })
      await expect(
        reconcileD1B2BTransfer(
          f.database,
          CLAIMS,
          f.orderId,
          { ...f.command, bankReference: 'REAL-BANK-REF' },
          f.options
        )
      ).rejects.toMatchObject({ code: 'invalid_input' })
      await reconcileD1B2BTransfer(f.database, CLAIMS, f.orderId, { ...f.command, amountCents: 1 }, f.options)
      await expect(
        reconcileD1B2BTransfer(
          f.database,
          CLAIMS,
          f.orderId,
          { ...f.command, expectedOutstandingCents: f.total - 1, amountCents: 1 },
          { ...f.options, idempotencyKey: crypto.randomUUID() }
        )
      ).rejects.toMatchObject({ code: 'conflict' })
    } finally {
      f.sqlite.close()
    }
  })
})
