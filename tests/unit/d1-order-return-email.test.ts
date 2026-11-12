import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { applyDeliveryPreferencesMigration } from '../support/delivery-preferences-migration'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, REQUEST, ADMISSION } from './d1-returns-fixture'
import { requestD1CustomerReturn, executeD1AdminReturnCommand } from '../../workers/returns/operations'
import { prepareOrderReturnEmail, orderReturnEmailRenderers } from '../../workers/communications/order-return-email'
import { publishEmailOutbox, receiveEmailDispatch } from '../../workers/communications/email-outbox'
import {
  dispatchTransactionalEmails,
  type TransactionalEmailSender
} from '../../workers/communications/transactional-email-delivery'
import { testNow, testUuid } from '../support/deterministic'

vi.mock('../support/d1-sqlite', async (importOriginal) => {
  const original = await importOriginal<typeof import('../support/d1-sqlite')>()
  return {
    ...original,
    openMigratedDatabase: async (...args: Parameters<typeof original.openMigratedDatabase>) => {
      const sqlite = await original.openMigratedDatabase(...args)
      sqlite.function('synthetic_return_email_clock', () => {
        const clock = vi.getMockedSystemTime()
        if (!clock) throw new Error('missing_synthetic_return_email_clock')
        return clock.toISOString().replace(/\.\d{3}Z$/, 'Z')
      })
      const nativeExec = sqlite.exec.bind(sqlite)
      sqlite.exec = (sql: string) => nativeExec(sql.replaceAll("'now'", 'synthetic_return_email_clock()'))
      return sqlite
    },
    d1OverSqlite: (sqlite: Parameters<typeof original.d1OverSqlite>[0]) => {
      const database = original.d1OverSqlite(sqlite),
        nativePrepare = database.prepare.bind(database)
      database.prepare = (sql: string) => nativePrepare(sql.replaceAll("'now'", 'synthetic_return_email_clock()'))
      return database
    }
  }
})
let f: Awaited<ReturnType<typeof returnsFixture>>, orderId: string, publicRef: string
function instant(offset = 0) {
  const clock = vi.getMockedSystemTime()
  if (!clock) throw new Error('missing_synthetic_return_email_clock')
  return new Date(clock.getTime() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
}
const from = 'returns@example.invalid',
  context = { appEnvironment: 'local' as const, validationEnabled: false },
  secret = 'PRIVATE_REASON_NOT_FOR_EMAIL',
  publicMessage = 'Información pública <b>sintética</b> para el comprador.'
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(testNow() + 1000)
  f = await returnsFixture()
  await applyDeliveryPreferencesMigration(f.sqlite)
  orderId = await f.order()
})
afterEach(() => {
  f?.sqlite.close()
  vi.useRealTimers()
})
async function request(key = testUuid()) {
  const result = await requestD1CustomerReturn(
    f.database,
    BUYER_CLAIMS,
    orderId,
    { ...REQUEST, reason: secret },
    { idempotencyKey: key }
  )
  publicRef = result.publicRef
  return result
}
function event() {
  const row = f.sqlite
    .prepare(
      "SELECT e.id FROM email_outbox_events e JOIN order_return_commands c ON c.id=e.source_event_id WHERE e.source_kind='return' ORDER BY c.result_version DESC LIMIT 1"
    )
    .get() as { id: string } | undefined
  expect(row).toBeDefined()
  return row!.id
}
it.each(['requested', 'approved', 'rejected', 'received', 'inspected', 'resolution_ready'])(
  'renders confirmed customer-visible %s without private command/custody facts',
  async (state) => {
    await request()
    if (state === 'rejected')
      await executeD1AdminReturnCommand(
        f.database,
        CLAIMS,
        publicRef,
        { action: 'rejected', expectedVersion: 1, reason: secret, publicMessage, evidence: secret },
        { idempotencyKey: testUuid() }
      )
    else if (state !== 'requested') {
      for (const [index, action] of ['approved', 'received', 'inspected', 'resolution_ready'].entries()) {
        const input =
          action === 'approved'
            ? { ...ADMISSION, reason: secret, publicMessage, evidence: secret }
            : action === 'received'
              ? {
                  action,
                  expectedVersion: index + 1,
                  reason: secret,
                  publicMessage,
                  evidence: secret,
                  lines: [{ lineIndex: 0, quantity: 2 }]
                }
              : action === 'inspected'
                ? {
                    action,
                    expectedVersion: index + 1,
                    reason: secret,
                    publicMessage,
                    evidence: secret,
                    lines: [{ lineIndex: 0, quantity: 2, condition: 'sealed', disposition: 'quarantine', note: secret }]
                  }
                : {
                    action,
                    expectedVersion: index + 1,
                    reason: secret,
                    publicMessage,
                    evidence: secret,
                    resolution: secret
                  }
        await executeD1AdminReturnCommand(f.database, CLAIMS, publicRef, input, { idempotencyKey: testUuid() })
        if (action === state) break
      }
    }
    const prepared = await prepareOrderReturnEmail(f.database, event(), from, context)
    if ('error' in prepared) throw new Error(prepared.error)
    expect(prepared.message.to).toBe('buyer@example.invalid')
    expect(prepared.message.text).toContain(publicRef)
    expect(prepared.message.text).not.toContain(secret)
    expect(prepared.message.html).not.toContain(secret)
    expect(prepared.message.text).toContain('no confirma un reembolso')
    expect(prepared.message.text).toContain('no repone existencias')
    if (state !== 'requested') {
      expect(prepared.message.html).toContain('&lt;b&gt;')
      expect(prepared.message.html).not.toContain('<b>')
    }
    expect(JSON.stringify(f.sqlite.prepare('SELECT * FROM email_outbox_events WHERE id=?').get(event()))).not.toContain(
      'buyer@'
    )
  }
)
it('same request key replays without duplicate metadata', async () => {
  const key = testUuid()
  await request(key)
  await request(key)
  expect(f.sqlite.prepare("SELECT count(*) n FROM email_outbox_events WHERE source_kind='return'").get()).toEqual({
    n: 1
  })
})
it('rolls back RMA claim/projection/audit when same-batch email insert fails', async () => {
  f.sqlite.exec(
    "CREATE TRIGGER reject_rma_email BEFORE INSERT ON email_outbox_events WHEN NEW.source_kind='return' BEGIN SELECT RAISE(ABORT,'synthetic-rma-outbox-failure'); END"
  )
  await expect(request()).rejects.toThrow()
  for (const table of ['order_returns', 'order_return_commands', 'order_return_events', 'order_return_lines'])
    expect(f.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({ n: 0 })
})
it('superseded request is never sent as current and is manual-review only when explicitly enabled', async () => {
  await request()
  const obsolete = event()
  await executeD1AdminReturnCommand(
    f.database,
    CLAIMS,
    publicRef,
    { ...ADMISSION, publicMessage, evidence: secret },
    { idempotencyKey: testUuid() }
  )
  expect(await prepareOrderReturnEmail(f.database, obsolete, from, context)).toEqual({ error: 'source_not_found' })
  await publishEmailOutbox(
    f.database,
    {
      send: async (message) => {
        await receiveEmailDispatch(f.database, message, instant())
      }
    },
    { now: instant(), limit: 100 }
  )
  const sender = { send: vi.fn<TransactionalEmailSender['send']>(async () => ({ messageId: 'local-rma' })) },
    config = { enabled: true, from, now: instant(), appEnvironment: 'local' as const }
  await dispatchTransactionalEmails(f.database, sender, config, { renderers: orderReturnEmailRenderers })
  expect(f.sqlite.prepare('SELECT status FROM transactional_email_deliveries WHERE event_id=?').get(obsolete)).toEqual({
    status: 'pending'
  })
  await dispatchTransactionalEmails(
    f.database,
    sender,
    { ...config, rendererOptIns: orderReturnEmailRenderers.map((item) => item.key) },
    { renderers: orderReturnEmailRenderers }
  )
  expect(f.sqlite.prepare('SELECT status FROM transactional_email_deliveries WHERE event_id=?').get(obsolete)).toEqual({
    status: 'manual_review'
  })
})
it('final source guard rejects advancement after preparation', async () => {
  await request()
  const id = event(),
    prepared = await prepareOrderReturnEmail(f.database, id, from, context)
  if ('error' in prepared) throw new Error(prepared.error)
  await executeD1AdminReturnCommand(
    f.database,
    CLAIMS,
    publicRef,
    { ...ADMISSION, publicMessage },
    { idempotencyKey: testUuid() }
  )
  await expect(
    f.database.batch(
      orderReturnEmailRenderers[0]!.authorityStatements(
        f.database,
        { eventId: id, leaseToken: testUuid(), sendingAt: instant(), leaseUntil: instant(60000) },
        prepared
      )
    )
  ).rejects.toThrow()
})
it.each([false, true])('local sender acknowledgement/loss %s never automatically sends twice', async (lost) => {
  await request()
  const id = event()
  await publishEmailOutbox(
    f.database,
    {
      send: async (message) => {
        await receiveEmailDispatch(f.database, message, instant())
      }
    },
    { now: instant(), limit: 100 }
  )
  const sender = {
    send: vi.fn<TransactionalEmailSender['send']>(async (message) => {
      if (message.subject.includes('Solicitud de devolución')) {
        if (lost) throw new Error('synthetic-response-lost')
        return { messageId: 'local-return' }
      }
      return { messageId: 'local-other' }
    })
  }
  const config = {
    enabled: true,
    from,
    now: instant(),
    appEnvironment: 'local' as const,
    rendererOptIns: orderReturnEmailRenderers.map((item) => item.key)
  }
  await dispatchTransactionalEmails(f.database, sender, config, { renderers: orderReturnEmailRenderers })
  await dispatchTransactionalEmails(f.database, sender, config, { renderers: orderReturnEmailRenderers })
  expect(
    sender.send.mock.calls.filter(([message]) => message.subject.includes('Solicitud de devolución'))
  ).toHaveLength(1)
  expect(f.sqlite.prepare('SELECT status FROM transactional_email_deliveries WHERE event_id=?').get(id)).toEqual({
    status: lost ? 'manual_review' : 'sent'
  })
})
it('rejects altered immutable input/receipt without disclosing private command content', async () => {
  await request()
  const id = event()
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args))
        if (key === 'first')
          return async () => {
            const raw = await target.first<Record<string, unknown>>()
            return raw?.input
              ? {
                  ...raw,
                  input: JSON.stringify({
                    ...JSON.parse(raw.input as string),
                    reason: 'Corrupted immutable private reason'
                  })
                }
              : raw
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  const corrupted = new Proxy(f.database, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql))
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  expect(await prepareOrderReturnEmail(corrupted, id, from, context)).toEqual({ error: 'invalid_source' })
})
