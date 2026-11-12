import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { supportFixture, CLAIMS, utc } from './d1-support-fixture'
import { executeSupportMacroCommand, listSupportMacros, previewSupportMacro } from '../../workers/support/macros'
import { executeSupportAdminCommand } from '../../workers/support/operations'
import { testNow, testUuid } from '../support/deterministic'

vi.mock('../support/d1-sqlite', async (importOriginal) => {
  const original = await importOriginal<typeof import('../support/d1-sqlite')>()
  return {
    ...original,
    d1OverSqlite: (sqlite: Parameters<typeof original.d1OverSqlite>[0]) => {
      sqlite.function('synthetic_support_macro_clock', () => {
        const clock = vi.getMockedSystemTime()
        if (!clock) throw new Error('missing_synthetic_support_macro_clock')
        return clock.toISOString().replace(/\.\d{3}Z$/, 'Z')
      })
      const database = original.d1OverSqlite(sqlite),
        nativePrepare = database.prepare.bind(database)
      database.prepare = (sql: string) => nativePrepare(sql.replaceAll("'now'", 'synthetic_support_macro_clock()'))
      return database
    }
  }
})

export const DRAFT = {
  action: 'draft',
  expectedVersion: 0,
  reason: 'Synthetic review workflow',
  title: 'Acuse de soporte',
  body: 'Ticket {{ticket.reference}}: {{personal.nextStep}}. Estado: {{ticket.state}}.',
  tone: 'Claro, cercano y sin promesas no verificadas',
  personalizations: [{ key: 'nextStep', label: 'Siguiente paso concreto', required: true }]
}
export const REVIEW = () => ({
  action: 'approve',
  expectedVersion: 1,
  reason: 'Synthetic approval, not real legal approval',
  operationalReference: 'fixture-operation-v1',
  legalReference: 'fixture-legal-v1',
  reviewedAt: utc(-10000),
  expiresAt: utc(86400000)
})

describe('reviewed support macros: native immutable provenance', () => {
  let f: Awaited<ReturnType<typeof supportFixture>>
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(testNow() + 1000)
    f = await supportFixture()
    if (!f.sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='support_macro_commands'").get())
      f.sqlite.exec(await readFile(new URL('../../db/d1/migrations/0060_support_macros.sql', import.meta.url), 'utf8'))
  })
  afterEach(() => {
    f?.sqlite.close()
    vi.useRealTimers()
  })
  const command = (id: string, input: unknown, key = testUuid()) =>
    executeSupportMacroCommand(f.database, CLAIMS, id, input, { idempotencyKey: key })
  async function approved(review = REVIEW()) {
    const id = testUuid()
    await command(id, DRAFT)
    const revision = await command(id, review)
    return { id, revision }
  }
  it('creates drafts, approves immutable snapshots and preserves history, CAS and exact replay', async () => {
    const id = testUuid(),
      key = testUuid()
    const draft = await command(id, DRAFT, key)
    expect(await command(id, DRAFT, key)).toEqual(draft)
    await expect(command(id, { ...DRAFT, title: 'Cambio' }, key)).rejects.toMatchObject({
      code: 'idempotency_conflict'
    })
    await expect(command(id, { ...REVIEW(), expectedVersion: 2 })).rejects.toMatchObject({ code: 'version_conflict' })
    await command(id, REVIEW())
    const library = await listSupportMacros(f.database, CLAIMS)
    expect(library.macros[0]?.history).toHaveLength(1)
    expect((await listSupportMacros(f.database, CLAIMS, { macroId: id })).macros[0]?.history).toHaveLength(2)
    expect(library.macros[0]?.state).toBe('approved')
    expect(() => f.sqlite.prepare("UPDATE support_macro_commands SET input='{}'").run()).toThrow()
    await command(id, { ...DRAFT, expectedVersion: 2, body: 'Nuevo borrador {{personal.nextStep}}.' })
    expect((await listSupportMacros(f.database, CLAIMS)).macros[0]?.state).toBe('draft')
  })
  it('rejects unknown/PII variables, undeclared slots, unbalanced tokens and fake review dates', async () => {
    for (const body of [
      'Hola {{customer.email}}',
      'Hola {{ticket.subject}}',
      'Hola {{personal.unknown}}',
      'Hola {{ticket.reference}'
    ]) {
      await expect(command(testUuid(), { ...DRAFT, body })).rejects.toMatchObject({ code: 'invalid_input' })
    }
    const id = testUuid()
    await command(id, DRAFT)
    await expect(command(id, { ...REVIEW(), reviewedAt: utc(3600000) })).rejects.toMatchObject({
      code: 'invalid_input'
    })
  })
  it('previews only after required personalization and explicit reply confirmation, binds exact body and records provenance', async () => {
    const { id, revision } = await approved(),
      ticket = await f.ticket(),
      before = f.economic()
    const selection = {
      macroId: id,
      revisionId: revision.commandId,
      personalizations: { nextStep: 'Comprobar el caso antes de responder' }
    }
    await expect(
      previewSupportMacro(f.database, CLAIMS, ticket.publicRef, { ...selection, personalizations: {} })
    ).rejects.toMatchObject({ code: 'invalid_input' })
    const preview = await previewSupportMacro(f.database, CLAIMS, ticket.publicRef, selection)
    expect(preview.message).toContain(ticket.publicRef)
    expect(JSON.stringify(preview)).not.toContain('buyer@example.invalid')
    const reply = {
      action: 'reply',
      expectedVersion: 1,
      reason: 'Respuesta personalizada revisada',
      message: preview.message,
      macro: { ...selection, confirmed: true }
    }
    await expect(
      executeSupportAdminCommand(
        f.database,
        CLAIMS,
        ticket.publicRef,
        { ...reply, message: preview.message + ' Legal alterado' },
        { idempotencyKey: testUuid() }
      )
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      executeSupportAdminCommand(
        f.database,
        CLAIMS,
        ticket.publicRef,
        { ...reply, macro: { ...selection, confirmed: false } },
        { idempotencyKey: testUuid() }
      )
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await executeSupportAdminCommand(f.database, CLAIMS, ticket.publicRef, reply, {
      idempotencyKey: testUuid()
    })
    const audit = f.sqlite.prepare("SELECT input FROM support_commands WHERE action='reply'").get() as { input: string }
    expect(JSON.parse(audit.input).macro.revisionId).toBe(revision.commandId)
    expect(f.economic()).toEqual(before)
  })
  it('blocks withdrawn/expired previews and new sends but replays already committed replies after fresh authority check', async () => {
    const { id, revision } = await approved(),
      ticket = await f.ticket()
    const selection = {
      macroId: id,
      revisionId: revision.commandId,
      personalizations: { nextStep: 'Revisar información operativa' }
    }
    const preview = await previewSupportMacro(f.database, CLAIMS, ticket.publicRef, selection)
    const reply = {
        action: 'reply',
        expectedVersion: 1,
        reason: 'Respuesta revisada',
        message: preview.message,
        macro: { ...selection, confirmed: true }
      },
      key = testUuid()
    const receipt = await executeSupportAdminCommand(f.database, CLAIMS, ticket.publicRef, reply, {
      idempotencyKey: key
    })
    await command(id, { action: 'withdraw', expectedVersion: 2, reason: 'Retirada de revisión operativa' })
    await expect(previewSupportMacro(f.database, CLAIMS, ticket.publicRef, selection)).rejects.toMatchObject({
      code: 'invalid_transition'
    })
    expect(
      await executeSupportAdminCommand(f.database, CLAIMS, ticket.publicRef, reply, { idempotencyKey: key })
    ).toEqual(receipt)
    f.sqlite.prepare("DELETE FROM role_permissions WHERE permission_code='support.manage'").run()
    await expect(command(id, DRAFT)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      executeSupportAdminCommand(f.database, CLAIMS, ticket.publicRef, reply, { idempotencyKey: key })
    ).rejects.toMatchObject({ code: 'forbidden' })
  })
  it('rejects expiration, superseded drafts, unauthorized personalization keys and stale ticket text', async () => {
    const { id, revision } = await approved(),
      ticket = await f.ticket()
    const selection = {
      macroId: id,
      revisionId: revision.commandId,
      personalizations: { nextStep: 'Revisar el caso concreto' }
    }
    const preview = await previewSupportMacro(f.database, CLAIMS, ticket.publicRef, selection)
    await expect(
      previewSupportMacro(f.database, CLAIMS, ticket.publicRef, {
        ...selection,
        personalizations: { ...selection.personalizations, email: 'pii@example.invalid' }
      })
    ).rejects.toMatchObject({ code: 'invalid_input' })
    const expiring = await approved({ ...REVIEW(), expiresAt: utc(30000) })
    await expect(
      previewSupportMacro(
        f.database,
        CLAIMS,
        ticket.publicRef,
        { ...selection, macroId: expiring.id, revisionId: expiring.revision.commandId },
        { now: utc(31000) }
      )
    ).rejects.toMatchObject({ code: 'invalid_transition' })
    await executeSupportAdminCommand(
      f.database,
      CLAIMS,
      ticket.publicRef,
      {
        action: 'update',
        expectedVersion: 1,
        reason: 'Estado actual cambiado',
        state: 'waiting_customer',
        priority: 'normal',
        ownerId: null,
        nextActionAt: null,
        slaDueAt: null
      },
      { idempotencyKey: testUuid() }
    )
    await expect(
      executeSupportAdminCommand(
        f.database,
        CLAIMS,
        ticket.publicRef,
        {
          action: 'reply',
          expectedVersion: 2,
          reason: 'Texto de preview obsoleto',
          message: preview.message,
          macro: { ...selection, confirmed: true }
        },
        { idempotencyKey: testUuid() }
      )
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await command(id, { ...DRAFT, expectedVersion: 2 })
    await expect(previewSupportMacro(f.database, CLAIMS, ticket.publicRef, selection)).rejects.toMatchObject({
      code: 'invalid_transition'
    })
  })
  it('rejects oversized rendered replies as invalid_input before effects', async () => {
    const id = testUuid()
    await command(id, { ...DRAFT, body: Array(30).fill('{{personal.nextStep}}').join(' ') })
    const revision = await command(id, REVIEW()),
      ticket = await f.ticket()
    const before = f.sqlite.prepare('SELECT count(*) AS n FROM email_outbox_events').get()
    await expect(
      previewSupportMacro(f.database, CLAIMS, ticket.publicRef, {
        macroId: id,
        revisionId: revision.commandId,
        personalizations: { nextStep: 'a'.repeat(300) }
      })
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM email_outbox_events').get()).toEqual(before)
  })
  it('treats corrupt stored history as unconfirmed evidence, not client input', async () => {
    const { id } = await approved()
    f.sqlite.exec("DROP TRIGGER support_macro_no_update; UPDATE support_macro_commands SET input='{}' WHERE version=1")
    await expect(listSupportMacros(f.database, CLAIMS, { macroId: id })).rejects.toMatchObject({
      code: 'history_unconfirmed'
    })
  })
  it('atomically rejects a revision withdrawn after preview but immediately before reply batch', async () => {
    const { id, revision } = await approved(),
      ticket = await f.ticket()
    const selection = {
      macroId: id,
      revisionId: revision.commandId,
      personalizations: { nextStep: 'Comprobar información actual' }
    }
    const preview = await previewSupportMacro(f.database, CLAIMS, ticket.publicRef, selection)
    let intercepted = false
    const database = {
      ...f.database,
      batch: async (statements: D1PreparedStatement[]) => {
        if (!intercepted) {
          intercepted = true
          await command(id, { action: 'withdraw', expectedVersion: 2, reason: 'Retirada durante espera de envío' })
        }
        return f.database.batch(statements)
      }
    } as D1Database
    await expect(
      executeSupportAdminCommand(
        database,
        CLAIMS,
        ticket.publicRef,
        {
          action: 'reply',
          expectedVersion: 1,
          reason: 'No enviar macro retirada',
          message: preview.message,
          macro: { ...selection, confirmed: true }
        },
        { idempotencyKey: testUuid() }
      )
    ).rejects.toMatchObject({ code: 'invalid_transition' })
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM support_commands WHERE action='reply'").get()).toEqual({ n: 0 })
  })
  it('paginates the library without hiding the 51st macro, and reads a specific macro outside the first page', async () => {
    const ids = Array.from({ length: 51 }, () => testUuid()).sort()
    for (const id of ids) await command(id, DRAFT)
    const first = await listSupportMacros(f.database, CLAIMS)
    expect(first.macros.map((m) => m.macroId)).toEqual(ids.slice(0, 50))
    expect(first.macros.every((m) => m.history.length === 1)).toBe(true)
    expect(first.nextMacroId).toBe(ids[49])
    const second = await listSupportMacros(f.database, CLAIMS, { afterMacroId: first.nextMacroId! })
    expect(second.macros.map((m) => m.macroId)).toEqual(ids.slice(50))
    expect(second.nextMacroId).toBeNull()
    const detail = await listSupportMacros(f.database, CLAIMS, { macroId: ids[50]! })
    expect(detail.macros).toHaveLength(1)
    expect(detail.macros[0]?.macroId).toBe(ids[50])
  })
  it('paginates immutable history in bounded windows without treating partial history as a missing ledger', async () => {
    const id = testUuid()
    for (let version = 0; version < 26; version++) await command(id, { ...DRAFT, expectedVersion: version })
    const first = (await listSupportMacros(f.database, CLAIMS, { macroId: id })).macros[0]!
    expect(first.history.map((h) => h.version)).toEqual(Array.from({ length: 20 }, (_, i) => 26 - i))
    expect(first.historyNextBefore).toBe(7)
    const second = (
      await listSupportMacros(f.database, CLAIMS, { macroId: id, beforeVersion: first.historyNextBefore! })
    ).macros[0]!
    expect(second.history.map((h) => h.version)).toEqual([6, 5, 4, 3, 2, 1])
    expect(second.historyNextBefore).toBeNull()
    expect(second.version).toBe(26)
    await expect(listSupportMacros(f.database, CLAIMS, { beforeVersion: 5 })).rejects.toMatchObject({
      code: 'invalid_input'
    })
  })
})
