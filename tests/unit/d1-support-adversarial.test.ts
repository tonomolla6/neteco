import { beforeEach, afterEach, describe, it, expect } from 'vitest'
import { supportFixture, CLAIMS, BUYER_CLAIMS, utc, CONTACT } from './d1-support-fixture'
import {
  executeSupportAdminCommand,
  readSupportTicket,
  supportActor,
  supportClock,
  createSupportTicket
} from '../../workers/support/operations'
let f: Awaited<ReturnType<typeof supportFixture>>
beforeEach(async () => {
  f = await supportFixture()
})
afterEach(() => {
  f.sqlite.close()
})
const reply = {
  action: 'reply',
  expectedVersion: 1,
  reason: 'Public reply reason',
  message: 'Respuesta pública confirmable'
}
function intercepted(hook: (sql: string) => void): D1Database {
  return {
    ...f.database,
    prepare(sql: string) {
      hook(sql)
      return f.database.prepare(sql)
    }
  }
}
function revokeMfa() {
  f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CLAIMS.sessionId)
}
describe('support adversarial authority and immutable snapshots', () => {
  it('assigns actual authorized staff without granting access or requiring an online assignee', async () => {
    f.sqlite
      .prepare('INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?,?,?)')
      .run(BUYER_CLAIMS.identityId, 'operator', utc(-1000))
    const ticket = await f.ticket(),
      assigned = await executeSupportAdminCommand(
        f.database,
        CLAIMS,
        ticket.publicRef,
        {
          action: 'update',
          expectedVersion: 1,
          reason: 'Documented staff assignment',
          state: 'open',
          priority: 'high',
          ownerId: BUYER_CLAIMS.identityId,
          nextActionAt: null,
          slaDueAt: null
        },
        { idempotencyKey: crypto.randomUUID() }
      )
    expect(assigned.version).toBe(2)
    expect(f.sqlite.prepare('SELECT mfa_verified FROM auth_sessions WHERE id=?').get(BUYER_CLAIMS.sessionId)).toEqual({
      mfa_verified: 0
    })
    expect((await f.request('/api/admin/support', 'GET', undefined, f.customerCookie)).status).toBe(403)
    f.sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(BUYER_CLAIMS.identityId)
    const response = await executeSupportAdminCommand(
      f.database,
      CLAIMS,
      ticket.publicRef,
      { ...reply, expectedVersion: 2 },
      { idempotencyKey: crypto.randomUUID() }
    )
    expect(response.version).toBe(3)
    expect(f.sqlite.prepare('SELECT owner_id FROM support_tickets').get()).toEqual({
      owner_id: BUYER_CLAIMS.identityId
    })
  })
  it('MFA lost while preparing outbox before mutation leaves no command/event/email', async () => {
    const ticket = await f.ticket(),
      before = f.sqlite.prepare('SELECT count(*) AS n FROM email_outbox_events').get()
    let once = false
    const db = intercepted((sql) => {
      if (!once && sql.includes('INSERT INTO email_outbox_events')) {
        once = true
        revokeMfa()
      }
    })
    await expect(
      executeSupportAdminCommand(db, CLAIMS, ticket.publicRef, reply, { idempotencyKey: crypto.randomUUID() })
    ).rejects.toMatchObject({ code: 'mfa_required' })
    expect(f.sqlite.prepare('SELECT version FROM support_tickets').get()).toEqual({ version: 1 })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM email_outbox_events').get()).toEqual(before)
  })
  it('authority lost immediately before atomic batch is fenced by real SQL', async () => {
    const ticket = await f.ticket(),
      before = f.economic()
    const db: D1Database = {
      ...f.database,
      batch: async (statements) => {
        revokeMfa()
        return f.database.batch(statements)
      }
    }
    await expect(
      executeSupportAdminCommand(db, CLAIMS, ticket.publicRef, reply, { idempotencyKey: crypto.randomUUID() })
    ).rejects.toMatchObject({ code: 'mfa_required' })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_commands').get()).toEqual({ n: 1 })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_events').get()).toEqual({ n: 1 })
    expect(f.economic()).toEqual(before)
  })
  it('authority lost after committed batch suppresses receipt, same-key reauth recovers', async () => {
    const ticket = await f.ticket(),
      key = crypto.randomUUID()
    const db: D1Database = {
      ...f.database,
      batch: async (statements) => {
        const result = await f.database.batch(statements)
        revokeMfa()
        return result
      }
    }
    await expect(
      executeSupportAdminCommand(db, CLAIMS, ticket.publicRef, reply, { idempotencyKey: key })
    ).rejects.toMatchObject({ code: 'mfa_required' })
    expect(f.sqlite.prepare('SELECT version FROM support_tickets').get()).toEqual({ version: 2 })
    f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=1 WHERE id=?').run(CLAIMS.sessionId)
    expect(
      (await executeSupportAdminCommand(f.database, CLAIMS, ticket.publicRef, reply, { idempotencyKey: key })).version
    ).toBe(2)
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_commands').get()).toEqual({ n: 2 })
  })
  it('ambiguous acknowledgement after batch returns only confirmed persisted replay', async () => {
    const ticket = await f.ticket(),
      key = crypto.randomUUID()
    const db: D1Database = {
      ...f.database,
      batch: async (statements) => {
        await f.database.batch(statements)
        throw new Error('lost_D1_ack')
      }
    }
    const result = await executeSupportAdminCommand(db, CLAIMS, ticket.publicRef, reply, { idempotencyKey: key })
    expect(result.version).toBe(2)
    expect(
      await executeSupportAdminCommand(f.database, CLAIMS, ticket.publicRef, reply, { idempotencyKey: key })
    ).toEqual(result)
  })
  it('same-key concurrent publication commits one event/outbox all-or-nothing', async () => {
    const ticket = await f.ticket(),
      key = crypto.randomUUID(),
      results = await Promise.all([
        executeSupportAdminCommand(f.database, CLAIMS, ticket.publicRef, reply, { idempotencyKey: key }),
        executeSupportAdminCommand(f.database, CLAIMS, ticket.publicRef, reply, { idempotencyKey: key })
      ])
    expect(results[0]).toEqual(results[1])
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_commands').get()).toEqual({ n: 2 })
    expect(
      f.sqlite.prepare("SELECT count(*) AS n FROM email_outbox_events WHERE event_type='support.ticket.reply'").get()
    ).toEqual({ n: 1 })
  })
  it('owned customer lost before creation batch cannot persist binding/outbox', async () => {
    const actor = await supportActor(f.database, BUYER_CLAIMS, 'customer', supportClock())
    const db: D1Database = {
      ...f.database,
      batch: async (statements) => {
        f.sqlite.prepare('UPDATE identities SET customer_id=NULL WHERE id=?').run(BUYER_CLAIMS.identityId)
        return f.database.batch(statements)
      }
    }
    await expect(
      createSupportTicket(db, actor, { ...CONTACT, orderId: f.order }, { idempotencyKey: crypto.randomUUID() })
    ).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_tickets').get()).toEqual({ n: 0 })
  })
  it('orders.read enrichment requires its exact live grant; losing it never returns facts', async () => {
    f.sqlite.exec(
      "INSERT INTO permissions VALUES('orders.read','orders','read','Synthetic existing read');INSERT INTO role_permissions VALUES('operator','orders.read')"
    )
    const ticket = await f.ticket(),
      detail = await readSupportTicket(f.database, CLAIMS, 'admin', ticket.publicRef, { page: 1, perPage: 25 })
    expect(detail.context.order?.id).toBe(f.order)
    expect(detail.context.payment).toBeNull()
    expect(detail.context.redacted).toEqual(['payment', 'fiscal'])
    let once = false
    const db = intercepted((sql) => {
      if (!once && sql.includes('SELECT line_index AS')) {
        once = true
        f.sqlite.exec("DELETE FROM role_permissions WHERE permission_code='orders.read'")
      }
    })
    await expect(readSupportTicket(db, CLAIMS, 'admin', ticket.publicRef, { page: 1, perPage: 25 })).rejects.toThrow(
      'support_context_unconfirmed'
    )
  })
  it('permissions payments.read/invoices.read enrich only safe historical summaries', async () => {
    f.sqlite.exec(
      "INSERT INTO permissions VALUES('orders.read','orders','read','Synthetic existing read');" +
        "INSERT INTO permissions VALUES('payments.read','payments','read','Synthetic existing read');" +
        "INSERT INTO permissions VALUES('invoices.read','invoices','read','Synthetic existing read');" +
        "INSERT INTO role_permissions VALUES('operator','orders.read');" +
        "INSERT INTO role_permissions VALUES('operator','payments.read');INSERT INTO role_permissions VALUES('operator','invoices.read')"
    )
    const ticket = await f.ticket(),
      before = f.economic(),
      detail = await readSupportTicket(f.database, CLAIMS, 'admin', ticket.publicRef, { page: 1, perPage: 25 })
    expect(detail.context.payment?.status).toBe('paid')
    expect(detail.context.fulfillment?.status).toBe('delivered')
    expect(JSON.stringify(detail.context)).not.toMatch(/provider_payload|merchant|contact_email|pan|bank_account/)
    expect(f.economic()).toEqual(before)
  })
  it('elapsed documented retention disables mutation while the session remains valid', async () => {
    const actor = await supportActor(f.database, BUYER_CLAIMS, 'customer', supportClock())
    const ticket = await createSupportTicket(f.database, actor, CONTACT, {
      idempotencyKey: crypto.randomUUID(),
      now: utc(-2000),
      policy: {
        reference: 'explicit-test-retention',
        version: 1,
        privacyNoticePath: '/privacidad',
        retentionDays: 1,
        responseMinutes: null,
        serviceHoursDescription: null
      }
    })
    f.sqlite.prepare('UPDATE auth_sessions SET expires_at=? WHERE id=?').run(utc(172800000), CLAIMS.sessionId)
    const expired = await readSupportTicket(
      f.database,
      CLAIMS,
      'admin',
      ticket.publicRef,
      { page: 1, perPage: 25 },
      false,
      utc(86400000)
    )
    expect(expired.timeline.every((event) => event.body === null)).toBe(true)
    expect(expired.context.order).toBeNull()
    expect(expired.subject).not.toBe(CONTACT.subject)
    expect('requester' in expired && expired.requester.email).toBe('')
    await expect(
      executeSupportAdminCommand(f.database, CLAIMS, ticket.publicRef, reply, {
        idempotencyKey: crypto.randomUUID(),
        now: utc(86400000)
      })
    ).rejects.toMatchObject({ code: 'retention_expired' })
  })
  it('unconfirmed D1 envelope is never a successful empty list or current receipt', async () => {
    const ticket = await f.ticket()
    const db: D1Database = {
      ...f.database,
      prepare(sql: string) {
        const statement = f.database.prepare(sql)
        if (!sql.includes('SELECT * FROM support_tickets')) return statement
        return {
          ...statement,
          bind() {
            return this
          },
          first: async () => undefined
        } as unknown as D1PreparedStatement
      }
    }
    await expect(readSupportTicket(db, CLAIMS, 'admin', ticket.publicRef, { page: 1, perPage: 25 })).rejects.toThrow()
  })
})
