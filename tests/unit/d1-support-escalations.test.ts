import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { supportFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-support-fixture'
import {
  executeSupportEscalationCommand,
  executeSupportRunbookCommand,
  readSupportEscalation,
  listSupportEscalations,
  readSupportEscalationCommand
} from '../../workers/support/escalations'
import { supportEscalationIntentHash } from '../../shared/support-escalations'
import { readSupportTicket } from '../../workers/support/operations'

describe('SUP-006 governed internal human escalations', () => {
  let f: Awaited<ReturnType<typeof supportFixture>>
  beforeEach(async () => {
    f = await supportFixture()
    const migration = new URL('../../db/d1/migrations/0079_support_escalations.sql', import.meta.url)
    // Before implementation the existing D1 fixture reaches the explicit service stub.
    if (existsSync(migration)) f.sqlite.exec(await readFile(migration, 'utf8'))
  })
  afterEach(() => f.sqlite.close())
  const reason = 'Synthetic explicit human escalation review'
  const draft = {
    action: 'draft',
    expectedVersion: 0,
    queue: 'payment',
    title: 'Comprobar incidencia de pago',
    body: 'Consultar la evidencia interna y asignar la siguiente comprobación. No ejecutar ningún cobro.',
    reason
  }
  async function runbook(expiresAt = utc(86400000)) {
    const id = crypto.randomUUID()
    await executeSupportRunbookCommand(f.database, CLAIMS, id, draft, { idempotencyKey: crypto.randomUUID() })
    await executeSupportRunbookCommand(
      f.database,
      CLAIMS,
      id,
      {
        action: 'approve',
        expectedVersion: 1,
        operationalReference: 'synthetic-review-not-real-approval',
        reviewedAt: utc(-1000),
        expiresAt,
        reason
      },
      { idempotencyKey: crypto.randomUUID() }
    )
    return { id, version: 2 }
  }
  async function context() {
    const ticket = await f.ticket()
    const input = {
      action: 'handoff' as const,
      expectedVersion: 0,
      expectedTicketVersion: ticket.version,
      queue: 'payment' as const,
      severity: 'high' as const,
      ownerId: CLAIMS.identityId,
      runbook: await runbook(),
      nextAction: 'Comprobar el recibo interno del intento de pago',
      nextActionAt: utc(3600000),
      reason
    }
    return { ticket, input }
  }
  const execute = (ref: string, input: unknown, key = crypto.randomUUID()) =>
    executeSupportEscalationCommand(f.database, CLAIMS, ref, input, { idempotencyKey: key })
  it('creates a linked escalation with eligible owner, approved runbook and no ticket or economic effects', async () => {
    const { ticket, input } = await context(),
      before = f.economic()
    const receipt = await execute(ticket.publicRef, input)
    expect(receipt).toMatchObject({
      targetId: ticket.publicRef,
      action: 'handoff',
      version: 1,
      inventoryEffect: 'none',
      economicEffect: 'none',
      communicationEffect: 'none'
    })
    const state = await readSupportEscalation(f.database, CLAIMS, ticket.publicRef)
    expect(state.escalation).toMatchObject({
      version: 1,
      ticketVersion: ticket.version,
      queue: 'payment',
      ownerId: CLAIMS.identityId,
      runbook: input.runbook,
      nextAction: input.nextAction,
      state: 'open'
    })
    expect(
      (await readSupportTicket(f.database, CLAIMS, 'admin', ticket.publicRef, { page: 1, perPage: 25 })).version
    ).toBe(ticket.version)
    expect(f.economic()).toEqual(before)
  })
  it('replays exactly, rejects changed payload and recovers only actor-bound exact hash', async () => {
    const { ticket, input } = await context(),
      key = crypto.randomUUID()
    const receipt = await execute(ticket.publicRef, input, key)
    expect(await execute(ticket.publicRef, input, key)).toEqual(receipt)
    await expect(execute(ticket.publicRef, { ...input, severity: 'critical' }, key)).rejects.toMatchObject({
      code: 'idempotency_conflict'
    })
    expect(
      await readSupportEscalationCommand(
        f.database,
        CLAIMS,
        ticket.publicRef,
        key,
        await supportEscalationIntentHash(ticket.publicRef, input)
      )
    ).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
    expect((await readSupportEscalation(f.database, CLAIMS, ticket.publicRef)).history).toHaveLength(1)
  })
  it('preserves handoff context, supports queue filters and resolves only the escalation', async () => {
    const { ticket, input } = await context()
    await execute(ticket.publicRef, input)
    await execute(ticket.publicRef, {
      ...input,
      action: 'update',
      expectedVersion: 1,
      severity: 'critical',
      nextAction: 'Revisión humana de la evidencia con el responsable asignado'
    })
    expect(
      (
        await listSupportEscalations(f.database, CLAIMS, {
          owner: 'me',
          queue: 'payment',
          severity: 'critical',
          state: 'open'
        })
      ).total
    ).toBe(1)
    await execute(ticket.publicRef, {
      action: 'resolve',
      expectedVersion: 2,
      expectedTicketVersion: ticket.version,
      resolution: 'Se ha completado la revisión humana sin alterar el pago.',
      reason
    })
    expect((await readSupportEscalation(f.database, CLAIMS, ticket.publicRef)).escalation?.state).toBe('resolved')
    expect(
      (await readSupportTicket(f.database, CLAIMS, 'admin', ticket.publicRef, { page: 1, perPage: 25 })).state
    ).toBe('open')
    expect((await listSupportEscalations(f.database, CLAIMS, { state: 'open' })).total).toBe(0)
  })
  it('rejects stale child and ticket versions with no additional history', async () => {
    const { ticket, input } = await context()
    await execute(ticket.publicRef, input)
    await expect(execute(ticket.publicRef, input)).rejects.toMatchObject({ code: 'version_conflict' })
    await expect(
      execute(ticket.publicRef, {
        ...input,
        action: 'update',
        expectedVersion: 1,
        expectedTicketVersion: ticket.version + 1
      })
    ).rejects.toMatchObject({ code: 'ticket_version_conflict' })
    expect((await readSupportEscalation(f.database, CLAIMS, ticket.publicRef)).history).toHaveLength(1)
  })
  it('does not treat a draft or withdrawn internal runbook as approved', async () => {
    const { ticket, input } = await context(),
      id = crypto.randomUUID()
    await executeSupportRunbookCommand(f.database, CLAIMS, id, draft, { idempotencyKey: crypto.randomUUID() })
    await expect(execute(ticket.publicRef, { ...input, runbook: { id, version: 1 } })).rejects.toMatchObject({
      code: 'runbook_unavailable'
    })
    await executeSupportRunbookCommand(
      f.database,
      CLAIMS,
      input.runbook.id,
      { action: 'withdraw', expectedVersion: 2, reason },
      { idempotencyKey: crypto.randomUUID() }
    )
    await expect(execute(ticket.publicRef, input)).rejects.toMatchObject({ code: 'runbook_unavailable' })
  })
  it('rejects ineligible owners and mismatched queue runbooks without writing', async () => {
    const { ticket, input } = await context()
    await expect(execute(ticket.publicRef, { ...input, ownerId: BUYER_CLAIMS.identityId })).rejects.toMatchObject({
      code: 'owner_unavailable'
    })
    await expect(execute(ticket.publicRef, { ...input, queue: 'stock' })).rejects.toMatchObject({
      code: 'runbook_unavailable'
    })
    expect((await readSupportEscalation(f.database, CLAIMS, ticket.publicRef)).escalation).toBeNull()
  })
  it('denies customers and revoked admin sessions on reads and historical replay', async () => {
    const { ticket, input } = await context(),
      key = crypto.randomUUID()
    await execute(ticket.publicRef, input, key)
    // Isolate the missing support permission from the independently enforced MFA gate.
    f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=1 WHERE id=?').run(BUYER_CLAIMS.sessionId)
    await expect(readSupportEscalation(f.database, BUYER_CLAIMS, ticket.publicRef)).rejects.toMatchObject({
      code: 'forbidden'
    })
    f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(-1), CLAIMS.sessionId)
    await expect(execute(ticket.publicRef, input, key)).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(readSupportEscalation(f.database, CLAIMS, ticket.publicRef)).rejects.toMatchObject({
      code: 'unauthenticated'
    })
  })
  it('returns explicit unknown without inferring absence and validates owner filters', async () => {
    const ticket = await f.ticket()
    expect(
      await readSupportEscalationCommand(f.database, CLAIMS, ticket.publicRef, crypto.randomUUID(), 'a'.repeat(64))
    ).toEqual({ source: 'cloudflare', outcome: 'unknown', receipt: null })
    await expect(listSupportEscalations(f.database, CLAIMS, { owner: 'not-an-identity' })).rejects.toMatchObject({
      code: 'invalid_input'
    })
  })
  it('rolls back the command if live authorization is revoked immediately before the atomic batch', async () => {
    const { ticket, input } = await context(),
      before = f.economic()
    const database = new Proxy(f.database, {
      get(target, property) {
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(-1), CLAIMS.sessionId)
            return target.batch(statements)
          }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await expect(
      executeSupportEscalationCommand(database, CLAIMS, ticket.publicRef, input, {
        idempotencyKey: crypto.randomUUID()
      })
    ).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM support_escalation_commands WHERE target_kind='escalation'").get()
    ).toMatchObject({ n: 0 })
    expect(f.economic()).toEqual(before)
  })
  it.each(['owner', 'runbook'] as const)(
    'rejects %s expiry between validation and the actual commit clock',
    async (source) => {
      const { ticket, input } = await context()
      const expires = utc(2000)
      if (source === 'runbook') input.runbook = await runbook(expires)
      else {
        f.sqlite
          .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at,expires_at) VALUES(?,'operator',?,?)")
          .run(BUYER_CLAIMS.identityId, utc(-1000), expires)
        input.ownerId = BUYER_CLAIMS.identityId
      }
      const database = new Proxy(f.database, {
        get(target, property) {
          if (property === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(expires) - Date.now()) + 50))
              return target.batch(statements)
            }
          const value = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      await expect(
        executeSupportEscalationCommand(database, CLAIMS, ticket.publicRef, input, {
          idempotencyKey: crypto.randomUUID()
        })
      ).rejects.toMatchObject({ code: 'write_unconfirmed' })
      expect(
        f.sqlite.prepare("SELECT COUNT(*) AS n FROM support_escalation_commands WHERE target_kind='escalation'").get()
      ).toMatchObject({ n: 0 })
    }
  )
  it('does not release queue rows whose retention expires before the final authority gate', async () => {
    const { ticket, input } = await context()
    await execute(ticket.publicRef, input)
    const expiry = f.sqlite
      .prepare('SELECT retention_until FROM support_tickets WHERE public_ref=?')
      .get(ticket.publicRef) as { retention_until: string }
    const future = new Date(Date.parse(expiry.retention_until) + 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    f.sqlite.prepare('UPDATE auth_sessions SET expires_at=? WHERE id=?').run(utc(40 * 86400000), CLAIMS.sessionId)
    let finalClockAdvanced = false
    const database = new Proxy(f.database, {
      get(target, property) {
        if (property === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql)
            if (!sql.includes('AS authorized')) return statement
            return new Proxy(statement, {
              get(original, member) {
                if (member === 'bind')
                  return (...args: unknown[]) => {
                    finalClockAdvanced = true
                    args[0] = future
                    return original.bind(...args)
                  }
                const value = Reflect.get(original, member)
                return typeof value === 'function' ? value.bind(original) : value
              }
            })
          }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await expect(listSupportEscalations(database, CLAIMS)).rejects.toMatchObject({ code: 'retention_expired' })
    expect(finalClockAdvanced).toBe(true)
  })
})
