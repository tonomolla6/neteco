import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { applyDeliveryPreferencesMigration } from '../support/delivery-preferences-migration'
import { supportFixture, CONTACT, CLAIMS, BUYER_CLAIMS, utc } from './d1-support-fixture'
import { prepareSupportEmail, supportEmailRenderers } from '../../workers/support/email'
import { executeSupportAdminCommand, createSupportTicket } from '../../workers/support/operations'
import { publishEmailOutbox, receiveEmailDispatch } from '../../workers/communications/email-outbox'
import { dispatchTransactionalEmails } from '../../workers/communications/transactional-email-delivery'
let f: Awaited<ReturnType<typeof supportFixture>>
beforeEach(async () => {
  f = await supportFixture()
  await applyDeliveryPreferencesMigration(f.sqlite)
})
afterEach(() => {
  f.sqlite.close()
})
const context = { appEnvironment: 'local' as const, validationEnabled: false }
async function publish() {
  await publishEmailOutbox(
    f.database,
    {
      send: async (message) => {
        expect(await receiveEmailDispatch(f.database, message, utc())).toMatch(/stored|duplicate/)
      }
    },
    { now: utc(), limit: 100 }
  )
}
describe('support email renderer source fencing', () => {
  it('prepares acknowledgement from real ledger without body/order/private facts', async () => {
    await f.ticket()
    const event = f.sqlite.prepare("SELECT id FROM email_outbox_events WHERE source_kind='support'").get() as {
      id: string
    }
    const prepared = await prepareSupportEmail(f.database, event.id, 'support@example.invalid', context)
    expect(prepared).toHaveProperty('message')
    if ('error' in prepared) throw new Error(prepared.error)
    expect(prepared.message.to).toBe('buyer@example.invalid')
    expect(prepared.message.text).not.toContain(CONTACT.message)
    expect(prepared.message.text).not.toContain(f.order)
    expect(prepared.rendererVersion).toBe('support-public-v1')
  })
  it('never trusts alternate submitted email as verified order recipient', async () => {
    await f.ticket({ ...CONTACT, email: 'other@example.invalid', orderId: f.order })
    const event = f.sqlite.prepare("SELECT id FROM email_outbox_events WHERE source_kind='support'").get() as {
      id: string
    }
    const prepared = await prepareSupportEmail(f.database, event.id, 'support@example.invalid', context)
    expect('message' in prepared && prepared.message.to).toBe('buyer@example.invalid')
  })
  it('anonymous public response escapes HTML; internal notes never become outbox sources', async () => {
    const ticket = await createSupportTicket(
      f.database,
      { kind: 'anonymous', claims: null, customerId: null, key: 'anonymous:' + 'a'.repeat(64) },
      CONTACT,
      { idempotencyKey: crypto.randomUUID() }
    )
    await executeSupportAdminCommand(
      f.database,
      CLAIMS,
      ticket.publicRef,
      { action: 'note', expectedVersion: 1, reason: 'Internal note', message: 'SECRET_INTERNAL' },
      { idempotencyKey: crypto.randomUUID() }
    )
    await executeSupportAdminCommand(
      f.database,
      CLAIMS,
      ticket.publicRef,
      {
        action: 'reply',
        expectedVersion: 2,
        reason: 'Public reply',
        message: 'Public <script>unsafe</script> & response'
      },
      { idempotencyKey: crypto.randomUUID() }
    )
    const event = f.sqlite
      .prepare("SELECT id FROM email_outbox_events WHERE event_type='support.ticket.reply'")
      .get() as { id: string }
    const prepared = await prepareSupportEmail(f.database, event.id, 'support@example.invalid', context)
    expect('message' in prepared && prepared.message.html).toContain('&lt;script&gt;')
    expect('message' in prepared && prepared.message.html).not.toContain('SECRET_INTERNAL')
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM email_outbox_events WHERE source_kind='support'").get()).toEqual(
      { n: 2 }
    )
  })
  it('follows genuine publisher/inbox/dispatcher with local sender, opt-in required', async () => {
    const before = f.economic()
    await f.ticket()
    await publish()
    const sender = { send: vi.fn(async () => ({ messageId: 'synthetic-local-support-message' })) }
    expect(
      await dispatchTransactionalEmails(f.database, sender, { now: utc() }, { renderers: supportEmailRenderers })
    ).toMatchObject({ disabled: true, sent: 0 })
    expect(sender.send).not.toHaveBeenCalled()
    expect(
      await dispatchTransactionalEmails(
        f.database,
        sender,
        {
          enabled: true,
          from: 'support@example.invalid',
          now: utc(),
          appEnvironment: 'local',
          rendererOptIns: supportEmailRenderers.map((item) => item.key)
        },
        { renderers: supportEmailRenderers }
      )
    ).toMatchObject({ disabled: false, sent: 2 })
    // The genuine checkout fixture also produced its order.created email.
    expect(sender.send).toHaveBeenCalledTimes(2)
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM transactional_email_preparations').get()).toEqual({ n: 1 })
    expect(f.economic()).toEqual(before)
  })
  it('invalid/currently unverified customer fails preparation and cannot expose content', async () => {
    await f.ticket()
    const event = f.sqlite.prepare("SELECT id FROM email_outbox_events WHERE source_kind='support'").get() as {
      id: string
    }
    f.sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(BUYER_CLAIMS.identityId)
    expect(await prepareSupportEmail(f.database, event.id, 'support@example.invalid', context)).toEqual({
      error: 'source_not_found'
    })
  })
  it('recipient changes after preparation atomically abort sending authority', async () => {
    await f.ticket()
    const event = f.sqlite.prepare("SELECT id FROM email_outbox_events WHERE source_kind='support'").get() as {
        id: string
      },
      prepared = await prepareSupportEmail(f.database, event.id, 'support@example.invalid', context)
    if ('error' in prepared) throw new Error(prepared.error)
    f.sqlite.prepare('UPDATE identities SET email=? WHERE id=?').run('changed@example.invalid', BUYER_CLAIMS.identityId)
    const statements = supportEmailRenderers[0]!.authorityStatements(
      f.database,
      { eventId: event.id, leaseToken: crypto.randomUUID(), sendingAt: utc(), leaseUntil: utc(60000) },
      prepared
    )
    await expect(f.database.batch(statements)).rejects.toThrow()
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_guards').get()).toEqual({ n: 0 })
  })
})
