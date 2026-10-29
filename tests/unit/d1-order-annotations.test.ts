import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import {
  readD1OrderAnnotations,
  executeD1OrderAnnotations,
  readD1OrderAnnotationCommand
} from '../../workers/catalog/order-annotations'

let f: Awaited<ReturnType<typeof returnsFixture>>, orderId: string
const key = '11111111-1111-4111-8111-111111111111'
const options = { now: () => utc() }
beforeEach(async () => {
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0063_order_annotations.sql', 'utf8'))
  orderId = await f.order({ paid: false, delivered: false })
})
afterEach(() => f?.sqlite.close())
const save = (input: unknown = { expectedVersion: 0, note: 'Revisar embalaje', labels: ['Frágil'] }) =>
  executeD1OrderAnnotations(f.database, CLAIMS, orderId, key, input, options)
it('appends a private note and audited labels with durable exact replay', async () => {
  const receipt = await save()
  expect(await save()).toEqual(receipt)
  expect(await readD1OrderAnnotationCommand(f.database, CLAIMS, orderId, key, options)).toMatchObject({
    outcome: 'applied',
    receipt
  })
  expect(await readD1OrderAnnotations(f.database, CLAIMS, orderId, {}, options)).toMatchObject({
    version: 1,
    labels: ['Frágil'],
    notes: [{ text: 'Revisar embalaje', authorId: CLAIMS.identityId }],
    nextCursor: null
  })
  expect(f.sqlite.prepare('SELECT count(*) n FROM order_annotation_commands').get()).toEqual({ n: 1 })
})
it('does not interpret unknown receipt as absent effect', async () => {
  expect(await readD1OrderAnnotationCommand(f.database, CLAIMS, orderId, key, options)).toMatchObject({
    outcome: 'unknown',
    receipt: null
  })
})
it('rejects same-key payload changes and stale versions without new notes', async () => {
  await save()
  await expect(save({ expectedVersion: 0, note: 'Otro texto' })).rejects.toMatchObject({ code: 'conflict' })
  await expect(
    executeD1OrderAnnotations(
      f.database,
      CLAIMS,
      orderId,
      '22222222-2222-4222-8222-222222222222',
      { expectedVersion: 0, labels: [] },
      options
    )
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(f.sqlite.prepare('SELECT count(*) n FROM order_annotation_commands').get()).toEqual({ n: 1 })
})
it.each([
  {},
  { expectedVersion: 0 },
  { expectedVersion: 0, note: '<b>privado</b>' },
  { expectedVersion: 0, note: 'x'.repeat(2001) },
  { expectedVersion: 0, labels: Array(9).fill('x') },
  { expectedVersion: 0, labels: ['x', 'x'] },
  { expectedVersion: 0, labels: ['x'], extra: true }
])('rejects invalid command %j', async (input) => {
  await expect(save(input)).rejects.toMatchObject({ code: 'invalid_input' })
})
it('denies customer readers and writers even on their own order', async () => {
  await expect(readD1OrderAnnotations(f.database, BUYER_CLAIMS, orderId, {}, options)).rejects.toMatchObject({
    code: 'mfa_required'
  })
  await expect(
    executeD1OrderAnnotations(f.database, BUYER_CLAIMS, orderId, key, { expectedVersion: 0, note: 'private' }, options)
  ).rejects.toMatchObject({ code: 'mfa_required' })
})
it('rejects live revoked authority after final await and rolls back', async () => {
  const batch = f.database.batch.bind(f.database)
  f.database.batch = async (statements) => {
    f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), CLAIMS.sessionId)
    return batch(statements)
  }
  await expect(save()).rejects.toMatchObject({ code: 'unauthenticated' })
  expect(f.sqlite.prepare('SELECT count(*) n FROM order_annotation_commands').get()).toEqual({ n: 0 })
})
it('paginates notes without changing current version or labels', async () => {
  await save()
  await executeD1OrderAnnotations(
    f.database,
    CLAIMS,
    orderId,
    '22222222-2222-4222-8222-222222222222',
    { expectedVersion: 1, note: 'Segunda', labels: [] },
    options
  )
  const page = await readD1OrderAnnotations(f.database, CLAIMS, orderId, { limit: 1 }, options)
  expect(page.notes).toHaveLength(1)
  expect(page.nextCursor).not.toBeNull()
  const next = await readD1OrderAnnotations(
    f.database,
    CLAIMS,
    orderId,
    { limit: 1, before: page.nextCursor! },
    options
  )
  expect(next.notes).toHaveLength(1)
  expect(next.notes[0]!.id).not.toBe(page.notes[0]!.id)
  expect(next).toMatchObject({ version: 2, labels: [], nextCursor: null })
})
it('cannot edit or delete audit history via SQL', async () => {
  await save()
  expect(() => f.sqlite.exec('DELETE FROM order_annotation_commands')).toThrow()
  expect(() => f.sqlite.exec("UPDATE order_annotation_commands SET note='changed'")).toThrow()
})
it.each(['email', 'mfa', 'grant', 'sessionVersion'] as const)(
  'checks live %s on every read and replay',
  async (kind) => {
    await save()
    if (kind === 'email') f.sqlite.exec('UPDATE identities SET email_verified_at=NULL')
    if (kind === 'mfa') f.sqlite.exec('UPDATE auth_sessions SET mfa_verified=0')
    if (kind === 'grant') f.sqlite.exec('DELETE FROM identity_roles')
    if (kind === 'sessionVersion') f.sqlite.exec('UPDATE identities SET session_version=session_version+1')
    const code = {
      email: 'email_unverified',
      mfa: 'mfa_required',
      grant: 'forbidden',
      sessionVersion: 'unauthenticated'
    }[kind]
    await expect(save()).rejects.toMatchObject({ code })
    await expect(readD1OrderAnnotationCommand(f.database, CLAIMS, orderId, key, options)).rejects.toMatchObject({
      code
    })
  }
)
it('preserves labels on note-only append and recovers lost response without another append', async () => {
  await save()
  const batch = f.database.batch.bind(f.database)
  f.database.batch = async (statements) => {
    await batch(statements)
    throw new Error('response_lost')
  }
  const second = '22222222-2222-4222-8222-222222222222'
  expect(
    await executeD1OrderAnnotations(
      f.database,
      CLAIMS,
      orderId,
      second,
      { expectedVersion: 1, note: 'Segunda' },
      options
    )
  ).toMatchObject({ version: 2, noteId: second })
  expect(await readD1OrderAnnotationCommand(f.database, CLAIMS, orderId, second, options)).toMatchObject({
    outcome: 'applied',
    receipt: { version: 2, labels: ['Frágil'] }
  })
  expect(f.sqlite.prepare('SELECT count(*) n FROM order_annotation_commands').get()).toEqual({ n: 2 })
})
it('rejects malformed and foreign note cursors', async () => {
  await expect(readD1OrderAnnotations(f.database, CLAIMS, orderId, { before: 'bad' }, options)).rejects.toMatchObject({
    code: 'invalid_input'
  })
  await expect(readD1OrderAnnotations(f.database, CLAIMS, orderId, { before: key }, options)).rejects.toMatchObject({
    code: 'invalid_input'
  })
})
it('rolls back a competing stale writer rather than replacing winning labels', async () => {
  const batch = f.database.batch.bind(f.database)
  let first = true
  f.database.batch = async (statements) => {
    if (first) {
      first = false
      await executeD1OrderAnnotations(
        f.database,
        CLAIMS,
        orderId,
        '22222222-2222-4222-8222-222222222222',
        { expectedVersion: 0, labels: ['Ganador'] },
        options
      )
    }
    return batch(statements)
  }
  await expect(save()).rejects.toMatchObject({ code: 'conflict' })
  expect(await readD1OrderAnnotations(f.database, CLAIMS, orderId, {}, options)).toMatchObject({
    version: 1,
    labels: ['Ganador'],
    notes: []
  })
})
it('uses final authorized snapshot when revocation races the last GET', async () => {
  await save()
  const prepare = f.database.prepare.bind(f.database)
  f.database.prepare = (sql) => {
    if (sql.includes('page AS MATERIALIZED'))
      f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), CLAIMS.sessionId)
    return prepare(sql)
  }
  await expect(readD1OrderAnnotations(f.database, CLAIMS, orderId, {}, options)).rejects.toMatchObject({
    code: 'unauthenticated'
  })
})
it.each(['invalid-utc', 'invalid-key', 'session-zero'] as const)(
  'enforces %s in D1, not just the JS DTO',
  async (mode) => {
    await save()
    const row = f.sqlite.prepare('SELECT * FROM order_annotation_commands').get()!
    row.command_id = '22222222-2222-4222-8222-222222222222'
    row.expected_version = 1
    row.version = 2
    if (mode === 'invalid-utc') row.created_at = '2099-99-99T99:99:99Z'
    if (mode === 'invalid-key') row.command_id = 'x'.repeat(36)
    if (mode === 'session-zero') {
      // Hostile raw rows cannot smuggle a zero version even when matching a
      // corrupted upstream identity/session. The annotation contract owns its CHECK.
      f.sqlite.exec(
        'PRAGMA ignore_check_constraints=ON; UPDATE auth_sessions SET session_version=0; UPDATE identities SET session_version=0; PRAGMA ignore_check_constraints=OFF'
      )
      row.session_version = 0
    }
    expect(() =>
      f.sqlite
        .prepare(
          `INSERT INTO order_annotation_commands(${Object.keys(row).join(',')}) VALUES(${Object.keys(row)
            .map(() => '?')
            .join(',')})`
        )
        .run(...Object.values(row))
    ).toThrow()
  }
)
it('returns the original live-authorized receipt when an identical contender wins before this batch', async () => {
  const batch = f.database.batch.bind(f.database)
  let entered!: () => void, release!: () => void
  const paused = new Promise<void>((resolve) => {
      entered = resolve
    }),
    resume = new Promise<void>((resolve) => {
      release = resolve
    })
  let first = true
  f.database.batch = async (statements) => {
    if (first) {
      first = false
      entered()
      await resume
    }
    return batch(statements)
  }
  const delayed = save()
  await paused
  const winner = await save()
  release()
  expect(await delayed).toEqual(winner)
  expect(f.sqlite.prepare('SELECT count(*) n FROM order_annotation_commands').get()).toEqual({ n: 1 })
})
