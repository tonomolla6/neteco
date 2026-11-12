import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { applyDeliveryPreferencesMigration } from '../support/delivery-preferences-migration'
import { returnsFixture, BUYER_CLAIMS, CLAIMS, REQUEST, ADMISSION, utc } from './d1-returns-fixture'
import { requestD1CustomerReturn, executeD1AdminReturnCommand } from '../../workers/returns/operations'
import { cancelD1UnpaidOrder } from '../../workers/catalog/order-cancellation'
import {
  dispatchTransactionalEmails,
  type TransactionalEmailSender
} from '../../workers/communications/transactional-email-delivery'
import { orderOperationsEmailRenderers } from '../../workers/communications/order-operations-email'
import { orderReturnEmailRenderers } from '../../workers/communications/order-return-email'
import { orderPaymentEmailRenderers } from '../../workers/communications/order-payment-email'
import { publishEmailOutbox, receiveEmailDispatch } from '../../workers/communications/email-outbox'
import { auditNativeOrderEmails, type NativeOrderEmailsInput } from '../../scripts/lib/audit-native-order-emails'
import { testUuid } from '../support/deterministic'
let f: Awaited<ReturnType<typeof returnsFixture>>,
  input: NativeOrderEmailsInput,
  messages: Parameters<TransactionalEmailSender['send']>[0][]
function measuredDatabase(): D1Database {
  const changes = () => Number(f.sqlite.prepare('SELECT total_changes() n').get()!.n)
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args))
        if (key === 'all')
          return async () => {
            const before = changes(),
              result = await target.all()
            return { ...result, meta: { ...result.meta, rows_written: changes() - before } }
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  return new Proxy(f.database, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql))
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}
beforeEach(async () => {
  f = await returnsFixture()
  await applyDeliveryPreferencesMigration(f.sqlite)
  const paid = await f.order(),
    cancelled = await f.order({ paid: false, delivered: false })
  await cancelD1UnpaidOrder(
    f.database,
    BUYER_CLAIMS,
    cancelled,
    testUuid(),
    { expectedStatus: 'awaiting_payment', reason: 'Synthetic cancellation audit reason' },
    { audience: 'customer', now: () => utc() }
  )
  const returned = await requestD1CustomerReturn(f.database, BUYER_CLAIMS, paid, REQUEST, {
    idempotencyKey: testUuid()
  })
  await executeD1AdminReturnCommand(f.database, CLAIMS, returned.publicRef, ADMISSION, {
    idempotencyKey: testUuid()
  })
  const common = {
    reason: 'Synthetic private reason not for email',
    publicMessage: 'Información pública de revisión documentada.',
    evidence: 'Synthetic private warehouse evidence'
  }
  await executeD1AdminReturnCommand(
    f.database,
    CLAIMS,
    returned.publicRef,
    { ...common, action: 'received', expectedVersion: 2, lines: [{ lineIndex: 0, quantity: 2 }] },
    { idempotencyKey: testUuid() }
  )
  await executeD1AdminReturnCommand(
    f.database,
    CLAIMS,
    returned.publicRef,
    {
      ...common,
      action: 'inspected',
      expectedVersion: 3,
      lines: [{ lineIndex: 0, quantity: 2, condition: 'sealed', disposition: 'quarantine' }]
    },
    { idempotencyKey: testUuid() }
  )
  await executeD1AdminReturnCommand(
    f.database,
    CLAIMS,
    returned.publicRef,
    {
      ...common,
      action: 'resolution_ready',
      expectedVersion: 4,
      resolution: 'Synthetic private resolution no economic effect'
    },
    { idempotencyKey: testUuid() }
  )
  messages = []
  const sender: TransactionalEmailSender = {
    send: async (message) => {
      messages.push(message)
      return { messageId: testUuid() }
    }
  }
  input = {
    database: measuredDatabase(),
    origin: 'https://shop-audit.neteco.test',
    orderIds: { fulfillment: [paid], returns: paid, cancelled, payment: paid },
    runEmails: (config) =>
      dispatchTransactionalEmails(f.database, sender, config, {
        renderers: [...orderOperationsEmailRenderers, ...orderReturnEmailRenderers, ...orderPaymentEmailRenderers]
      }),
    deliverEmailTransport: async (eventId) => {
      await publishEmailOutbox(
        f.database,
        {
          send: async (message) => {
            await receiveEmailDispatch(f.database, message, utc())
          }
        },
        { now: utc(), limit: 100 }
      )
      expect(f.sqlite.prepare('SELECT event_id FROM email_dispatch_inbox WHERE event_id=?').get(eventId)).toBeDefined()
      expect(
        await receiveEmailDispatch(f.database, { type: 'email.dispatch.requested', version: 1, eventId }, utc())
      ).toBe('replayed')
    },
    sentMessages: () => messages,
    scenario: vi.fn()
  }
})
afterEach(() => f?.sqlite.close())
it('accepts real domain producers and local delivery, exact replay and obsolete review without domain effects', async () => {
  const result = await auditNativeOrderEmails(input)
  expect(result).toMatchObject({
    targets: 4,
    obsolete: 6,
    domainDigestUnchanged: true,
    productionAcceptance: false,
    providerOperation: false,
    unknownSendNative: 'not_exercised'
  })
  expect(result.pendingStates).toEqual(['fulfillment:in_transit', 'return:rejected'])
  expect(input.scenario).toHaveBeenCalledTimes(result.scenarios)
  expect(JSON.stringify(result)).not.toContain('buyer@')
  expect(JSON.stringify(result)).not.toContain(input.orderIds.payment)
})
it('rejects foreign origin before SQL/transport/sender', async () => {
  const prepare = vi.spyOn(f.database, 'prepare'),
    transport = vi.fn(input.deliverEmailTransport),
    run = vi.fn(input.runEmails)
  await expect(
    auditNativeOrderEmails({
      ...input,
      origin: 'https://foreign.invalid',
      deliverEmailTransport: transport,
      runEmails: run
    })
  ).rejects.toThrow('isolated origin')
  expect(prepare).not.toHaveBeenCalled()
  expect(transport).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
})
it('detects money/stock/history writes hidden in a delivery callback', async () => {
  const run = input.runEmails
  await expect(
    auditNativeOrderEmails({
      ...input,
      runEmails: async (config) => {
        const result = await run(config)
        f.sqlite.prepare('UPDATE inventory_balances SET physical_quantity=physical_quantity+1').run()
        return result
      }
    })
  ).rejects.toThrow('domain snapshot changed')
})
it('detects a sender duplicating an acknowledged target without relying on renderer output as oracle', async () => {
  const run = input.runEmails
  await expect(
    auditNativeOrderEmails({
      ...input,
      runEmails: async (config) => {
        const before = messages.length,
          result = await run(config)
        const target = messages.slice(before).find((message) => message.subject.includes('Captura registrada'))
        if (target) messages.push(target)
        return result
      }
    })
  ).rejects.toThrow('exact target delivery')
})
it('local unknown-send complement is held for manual review and never automatically resent', async () => {
  const unknown: TransactionalEmailSender = {
    send: async (message) => {
      messages.push(message)
      if (message.subject.includes('Captura registrada')) throw new Error('synthetic-response-lost')
      return { messageId: testUuid() }
    }
  }
  const run: NativeOrderEmailsInput['runEmails'] = (config) =>
    dispatchTransactionalEmails(f.database, unknown, config, {
      renderers: [...orderOperationsEmailRenderers, ...orderReturnEmailRenderers, ...orderPaymentEmailRenderers]
    })
  await expect(auditNativeOrderEmails({ ...input, runEmails: run })).rejects.toThrow('current confirmed email not sent')
  const calls = messages.filter((message) => message.subject.includes('Captura registrada')).length
  expect(calls).toBe(1)
  await run({
    enabled: true,
    from: 'synthetic-orders@example.test',
    now: utc(),
    appEnvironment: 'local',
    rendererOptIns: [
      'order.operations.fulfillment.v1',
      'order.operations.cancelled.v1',
      'order.return.requested.v1',
      'order.return.status.v1',
      'order.payment.confirmed.v1'
    ]
  })
  expect(messages.filter((message) => message.subject.includes('Captura registrada'))).toHaveLength(1)
  expect(
    f.sqlite
      .prepare(
        "SELECT d.status FROM transactional_email_deliveries d JOIN email_outbox_events e ON e.id=d.event_id WHERE e.event_type='order.confirmed'"
      )
      .get()
  ).toEqual({ status: 'manual_review' })
})
