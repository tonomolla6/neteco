import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createSupportTicket,
  executeSupportAdminCommand,
  replySupportCustomer,
  readSupportTicket,
  listSupportTickets,
  supportActor,
  supportClock
} from '../../workers/support/operations'
import { supportAdminTicketSchema, supportCustomerTicketSchema } from '../../shared/support-operations'
import { supportFixture, CLAIMS, BUYER_CLAIMS, CONTACT, POLICY, utc } from './d1-support-fixture'

describe('native D1 operational support ledger and private ownership', () => {
  let fixture: Awaited<ReturnType<typeof supportFixture>>
  beforeEach(async () => {
    fixture = await supportFixture()
  })
  afterEach(() => {
    fixture.sqlite.close()
  })
  const options = () => ({ idempotencyKey: crypto.randomUUID() })
  const update = (version: number, extra: Record<string, unknown> = {}) => ({
    action: 'update',
    expectedVersion: version,
    reason: 'Revisión operativa explícita',
    state: 'waiting_customer',
    priority: 'high',
    ownerId: CLAIMS.identityId,
    nextActionAt: utc(60000),
    slaDueAt: null,
    ...extra
  })
  it('creates a contextual verified ticket with immutable historical order and zero economic effects', async () => {
    const before = fixture.economic(),
      receipt = await fixture.ticket()
    expect(receipt.version).toBe(1)
    expect(receipt.emailStatus).toBe('queued')
    const customer = await readSupportTicket(fixture.database, BUYER_CLAIMS, 'customer', receipt.publicRef, {
      page: 1,
      perPage: 25
    })
    expect(supportCustomerTicketSchema.safeParse(customer).success).toBe(true)
    expect(customer.orderId).toBe(fixture.order)
    expect(customer.context.order?.lines[0]?.sku).toBeTruthy()
    expect(fixture.economic()).toEqual(before)
    expect(
      fixture.sqlite
        .prepare(
          'SELECT event_type,source_kind FROM email_outbox_events WHERE source_id=(SELECT id FROM support_tickets)'
        )
        .all()
    ).toEqual([{ event_type: 'support.ticket.received', source_kind: 'support' }])
  })
  it('replays creation exactly and rejects changed content under the same actor/key', async () => {
    const key = crypto.randomUUID(),
      first = await fixture.ticket({ ...CONTACT, orderId: fixture.order }, key)
    expect(await fixture.ticket({ ...CONTACT, orderId: fixture.order }, key)).toEqual(first)
    await expect(
      fixture.ticket({ ...CONTACT, orderId: fixture.order, message: 'Texto público diferente de fixture.' }, key)
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM support_tickets').get()).toEqual({ n: 1 })
  })
  it('requires support.manage rather than administration.manage for operations', async () => {
    const ticket = await fixture.ticket()
    const result = await executeSupportAdminCommand(fixture.database, CLAIMS, ticket.publicRef, update(1), options())
    expect(result.state).toBe('waiting_customer')
    const read = await readSupportTicket(fixture.database, CLAIMS, 'admin', ticket.publicRef, { page: 1, perPage: 25 })
    expect(supportAdminTicketSchema.safeParse(read).success).toBe(true)
    expect(read.context.order).toBeNull()
    expect(read.context.redacted).toEqual(['order', 'payment', 'fiscal'])
    fixture.sqlite.prepare("DELETE FROM role_permissions WHERE permission_code='support.manage'").run()
    await expect(
      executeSupportAdminCommand(fixture.database, CLAIMS, ticket.publicRef, update(2), options())
    ).rejects.toMatchObject({ code: 'forbidden' })
  })
  it('never leaks notes/calls, staff ownership, requester contact or private reasons into customer DTOs', async () => {
    const ticket = await fixture.ticket()
    await executeSupportAdminCommand(
      fixture.database,
      CLAIMS,
      ticket.publicRef,
      {
        action: 'note',
        expectedVersion: 1,
        reason: 'Privada justificación sensible',
        message: 'INTERNAL SUPPORT FACT marker'
      },
      options()
    )
    await executeSupportAdminCommand(
      fixture.database,
      CLAIMS,
      ticket.publicRef,
      {
        action: 'call',
        expectedVersion: 2,
        reason: 'Registro manual, no llamada ejecutada',
        message: 'INTERNAL CALL FACT marker',
        occurredAt: utc(-10000),
        nextActionAt: utc(3600000)
      },
      options()
    )
    const customer = await readSupportTicket(fixture.database, BUYER_CLAIMS, 'customer', ticket.publicRef, {
        page: 1,
        perPage: 25
      }),
      admin = await readSupportTicket(fixture.database, CLAIMS, 'admin', ticket.publicRef, { page: 1, perPage: 25 })
    expect(JSON.stringify(customer)).not.toContain('INTERNAL')
    expect(customer.pagination.total).toBe(1)
    expect('requester' in customer).toBe(false)
    expect('ownerId' in customer).toBe(false)
    expect(admin.timeline.length).toBe(3)
    expect(admin.timeline.filter((event) => event.visibility === 'internal')).toHaveLength(2)
  })
  it('allows public reply and customer follow-up while preserving the separate email outbox', async () => {
    const ticket = await fixture.ticket(),
      before = fixture.economic()
    await executeSupportAdminCommand(fixture.database, CLAIMS, ticket.publicRef, update(1), options())
    await executeSupportAdminCommand(
      fixture.database,
      CLAIMS,
      ticket.publicRef,
      {
        action: 'reply',
        expectedVersion: 2,
        reason: 'Respuesta pública revisada',
        message: 'PUBLIC STAFF REPLY marker'
      },
      options()
    )
    const response = await replySupportCustomer(
      fixture.database,
      BUYER_CLAIMS,
      ticket.publicRef,
      {
        expectedVersion: 3,
        message: 'PUBLIC CUSTOMER FOLLOWUP marker'
      },
      options()
    )
    expect(response.state).toBe('open')
    expect(
      fixture.sqlite.prepare("SELECT count(*) AS n FROM email_outbox_events WHERE source_kind='support'").get()
    ).toEqual({ n: 2 })
    expect(fixture.economic()).toEqual(before)
  })
  it('rejects stale CAS and invalid direct closing without effects', async () => {
    const ticket = await fixture.ticket()
    await expect(
      executeSupportAdminCommand(fixture.database, CLAIMS, ticket.publicRef, update(2), options())
    ).rejects.toMatchObject({ code: 'version_conflict' })
    await expect(
      executeSupportAdminCommand(
        fixture.database,
        CLAIMS,
        ticket.publicRef,
        update(1, { state: 'closed', resolution: 'Resumen documentado de resolución.' }),
        options()
      )
    ).rejects.toMatchObject({ code: 'invalid_transition' })
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM support_commands').get()).toEqual({ n: 1 })
  })
  it('requires documented resolution and explicit reopening before a closed customer reply', async () => {
    const ticket = await fixture.ticket()
    await expect(
      executeSupportAdminCommand(
        fixture.database,
        CLAIMS,
        ticket.publicRef,
        update(1, { state: 'resolved' }),
        options()
      )
    ).rejects.toMatchObject({ code: 'invalid_transition' })
    await executeSupportAdminCommand(
      fixture.database,
      CLAIMS,
      ticket.publicRef,
      update(1, {
        state: 'resolved',
        resolution: 'Incidencia aclarada; ningún reembolso ejecutado.'
      }),
      options()
    )
    await executeSupportAdminCommand(
      fixture.database,
      CLAIMS,
      ticket.publicRef,
      update(2, {
        state: 'closed',
        resolution: 'Cierre operativo confirmado por el personal.'
      }),
      options()
    )
    await expect(
      replySupportCustomer(
        fixture.database,
        BUYER_CLAIMS,
        ticket.publicRef,
        { expectedVersion: 3, message: 'Reabrir' },
        options()
      )
    ).rejects.toMatchObject({ code: 'invalid_transition' })
    await executeSupportAdminCommand(
      fixture.database,
      CLAIMS,
      ticket.publicRef,
      update(3, { state: 'open' }),
      options()
    )
    expect(
      (
        await replySupportCustomer(
          fixture.database,
          BUYER_CLAIMS,
          ticket.publicRef,
          { expectedVersion: 4, message: 'Gracias' },
          options()
        )
      ).version
    ).toBe(5)
  })
  it('permits same-key recovery after later commands but never after grant loss', async () => {
    const ticket = await fixture.ticket(),
      key = crypto.randomUUID(),
      input = update(1),
      first = await executeSupportAdminCommand(fixture.database, CLAIMS, ticket.publicRef, input, {
        idempotencyKey: key
      })
    await executeSupportAdminCommand(
      fixture.database,
      CLAIMS,
      ticket.publicRef,
      {
        action: 'note',
        expectedVersion: 2,
        reason: 'Nota posterior documentada',
        message: 'Nota interna posterior.'
      },
      options()
    )
    expect(
      await executeSupportAdminCommand(fixture.database, CLAIMS, ticket.publicRef, input, { idempotencyKey: key })
    ).toEqual(first)
    fixture.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), CLAIMS.sessionId)
    await expect(
      executeSupportAdminCommand(fixture.database, CLAIMS, ticket.publicRef, input, { idempotencyKey: key })
    ).rejects.toMatchObject({ code: 'unauthenticated' })
  })
  it('rejects assignment to a customer, disabled owner or owner without a live MFA session', async () => {
    const ticket = await fixture.ticket()
    for (const ownerId of [BUYER_CLAIMS.identityId, crypto.randomUUID()]) {
      await expect(
        executeSupportAdminCommand(fixture.database, CLAIMS, ticket.publicRef, update(1, { ownerId }), options())
      ).rejects.toMatchObject({ code: 'owner_unavailable' })
    }
    fixture.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CLAIMS.sessionId)
    await expect(
      executeSupportAdminCommand(fixture.database, CLAIMS, ticket.publicRef, update(1), options())
    ).rejects.toMatchObject({ code: 'mfa_required' })
  })
  it('uses current customer ownership and never links by a matching contact email', async () => {
    const ticket = await fixture.ticket()
    fixture.sqlite.prepare('UPDATE identities SET customer_id=NULL WHERE id=?').run(BUYER_CLAIMS.identityId)
    await expect(
      readSupportTicket(fixture.database, BUYER_CLAIMS, 'customer', ticket.publicRef, { page: 1, perPage: 25 })
    ).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(
      createSupportTicket(
        fixture.database,
        { kind: 'anonymous', claims: null, customerId: null, key: 'anonymous:' + 'a'.repeat(64) },
        { ...CONTACT, orderId: fixture.order, email: 'buyer@example.invalid' },
        options()
      )
    ).rejects.toMatchObject({ code: 'guest_verification_required' })
  })
  it('creates anonymous intake with an unverified reference and no portal/customer/order claim', async () => {
    const receipt = await createSupportTicket(
      fixture.database,
      {
        kind: 'anonymous',
        claims: null,
        customerId: null,
        key: 'anonymous:' + 'a'.repeat(64)
      },
      { ...CONTACT, orderReference: fixture.order },
      options()
    )
    const row = fixture.sqlite
      .prepare('SELECT customer_id,order_id,declared_order_reference,policy,sla_due_at FROM support_tickets')
      .get()
    expect(row).toEqual({
      customer_id: null,
      order_id: null,
      declared_order_reference: fixture.order,
      policy: null,
      sla_due_at: null
    })
    expect(receipt.emailStatus).toBe('queued')
    expect(
      (await listSupportTickets(fixture.database, BUYER_CLAIMS, 'customer', { page: 1, perPage: 25 })).items
    ).toEqual([])
  })
  it('records only explicitly supplied policy and does not invent a response SLA', async () => {
    const ticket = await fixture.ticket()
    const read = await readSupportTicket(fixture.database, CLAIMS, 'admin', ticket.publicRef, { page: 1, perPage: 25 })
    expect(read.policy).toEqual(POLICY)
    expect(read.slaDueAt).toBeNull()
    expect(read.retentionUntil).not.toBeNull()
  })
  it('guards immutable commands, audit events, customer/order ownership and state projection in SQL', async () => {
    const ticket = await fixture.ticket()
    expect(() => fixture.sqlite.prepare("UPDATE support_commands SET input='{}'").run()).toThrow()
    expect(() => fixture.sqlite.prepare("UPDATE support_events SET body='tampered'").run()).toThrow()
    expect(() => fixture.sqlite.prepare("UPDATE support_tickets SET state='closed'").run()).toThrow()
    expect(() => fixture.sqlite.prepare('UPDATE support_tickets SET order_id=NULL').run()).toThrow()
    expect(() => fixture.sqlite.prepare('DELETE FROM support_events').run()).toThrow()
    expect(
      (await readSupportTicket(fixture.database, BUYER_CLAIMS, 'customer', ticket.publicRef, { page: 1, perPage: 25 }))
        .version
    ).toBe(1)
  })
  it('rolls back commands, projection, timeline and email on a late transactional failure', async () => {
    const ticket = await fixture.ticket(),
      counts = () =>
        fixture.sqlite
          .prepare(
            'SELECT (SELECT count(*) FROM support_commands) AS c,(SELECT count(*) FROM support_events) AS e,' +
              '(SELECT count(*) FROM email_outbox_events) AS mail'
          )
          .get(),
      before = counts()
    fixture.sqlite.exec(
      "CREATE TRIGGER synthetic_support_late_failure BEFORE INSERT ON email_outbox_events WHEN NEW.event_type='support.ticket.reply' BEGIN SELECT RAISE(ABORT,'synthetic_late_failure'); END"
    )
    await expect(
      executeSupportAdminCommand(
        fixture.database,
        CLAIMS,
        ticket.publicRef,
        {
          action: 'reply',
          expectedVersion: 1,
          reason: 'Respuesta aprobada manualmente',
          message: 'Respuesta pública no confirmada.'
        },
        options()
      )
    ).rejects.toMatchObject({ code: 'write_unconfirmed' })
    expect(counts()).toEqual(before)
    expect(fixture.sqlite.prepare('SELECT version FROM support_tickets').get()).toEqual({ version: 1 })
  })
  it('preserves a one-winner CAS under simultaneous support commands', async () => {
    const ticket = await fixture.ticket(),
      results = await Promise.allSettled([
        executeSupportAdminCommand(fixture.database, CLAIMS, ticket.publicRef, update(1), options()),
        executeSupportAdminCommand(
          fixture.database,
          CLAIMS,
          ticket.publicRef,
          update(1, { priority: 'urgent' }),
          options()
        )
      ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(fixture.sqlite.prepare('SELECT version FROM support_tickets').get()).toEqual({ version: 2 })
  })
  it('revalidates customer identity before producing the actor used by a command', async () => {
    fixture.sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(BUYER_CLAIMS.identityId)
    await expect(supportActor(fixture.database, BUYER_CLAIMS, 'customer', supportClock())).rejects.toMatchObject({
      code: 'unauthenticated'
    })
  })
})
