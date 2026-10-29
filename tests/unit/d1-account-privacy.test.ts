import { afterEach, beforeEach, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { SQLInputValue } from 'node:sqlite'
import { updateD1AccountPreferences } from '../../workers/auth/account-preferences'
import { ACCOUNT_PREFERENCES_POLICY_VERSION } from '../../shared/account-preferences'
import { updateD1DeliveryPreferences } from '../../workers/auth/delivery-preferences'
import { DELIVERY_PREFERENCES_POLICY_VERSION } from '../../shared/delivery-preferences'
import { accountPrivacyExportSchema } from '../../shared/account-privacy'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { returnsFixture, BUYER_CLAIMS, CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import {
  executeD1AccountPrivacy,
  readD1AccountPrivacy,
  readD1AccountPrivacyCommand,
  downloadD1AccountPrivacy
} from '../../workers/auth/account-privacy'
let f: Awaited<ReturnType<typeof returnsFixture>>
const key = '11111111-1111-4111-8111-111111111165'
const options = { now: () => utc() }
beforeEach(async () => {
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0065_account_privacy.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0066_account_preferences.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0070_delivery_preferences.sql', 'utf8'))
  await f.database.batch(
    splitDemoSql(await readFile('db/d1/migrations/0071_account_security_notices.sql', 'utf8')).map((sql) =>
      f.database.prepare(sql)
    )
  )
})
afterEach(() => f?.sqlite.close())
async function exportReceipt() {
  return executeD1AccountPrivacy(f.database, BUYER_CLAIMS, { requestType: 'export', idempotencyKey: key }, options)
}
function securityNotice(
  input: {
    id?: string
    identityId?: string
    kind?: string
    recipient?: string
    audience?: string
    createdAt?: string
  } = {}
) {
  const id = input.id ?? crypto.randomUUID()
  f.sqlite
    .prepare(
      `INSERT INTO identity_account_security_events
    (id,identity_id,kind,recipient,audience,session_version,domain_event_id,created_at)
    VALUES(?,?,?,?,?,1,?,?)`
    )
    .run(
      id,
      input.identityId ?? BUYER_CLAIMS.identityId,
      input.kind ?? 'email_changed',
      input.recipient ?? 'historical-mailbox@example.invalid',
      input.audience ?? 'previous',
      crypto.randomUUID(),
      input.createdAt ?? utc(-1000)
    )
  return id
}
it('requires an empty security notice array without inventing historical notifications', async () => {
  const receipt = await exportReceipt()
  const data = await downloadD1AccountPrivacy(f.database, BUYER_CLAIMS, receipt.id, options)
  expect(data).toMatchObject({ schemaVersion: 1, securityNotices: [] })
  const { securityNotices: _removed, ...missing } = data as typeof data & { securityNotices: unknown }
  expect(accountPrivacyExportSchema.safeParse(missing).success).toBe(false)
})
it('exports all own historical security kinds in stable time and id order, with only the four public fields', async () => {
  const receipt = await exportReceipt()
  const kinds = ['password_changed', 'mfa_enabled', 'email_changed', 'fiscal_details_submitted']
  const rows = kinds.map((kind, index) => ({
    id: `71000000-0000-4000-8000-${String(4 - index).padStart(12, '0')}`,
    kind,
    recipient: `${kind}@example.invalid`,
    audience: kind === 'email_changed' ? 'previous' : 'current',
    createdAt: utc(index === 3 ? -2000 : -1000)
  }))
  for (const row of rows) securityNotice(row)
  const data = await downloadD1AccountPrivacy(f.database, BUYER_CLAIMS, receipt.id, options)
  const expected = rows
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map(({ id: _id, ...row }) => row)
  expect(data).toMatchObject({ securityNotices: expected })
  const exported = (data as typeof data & { securityNotices: unknown[] }).securityNotices
  for (const row of exported)
    expect(Object.keys(row as object).sort()).toEqual(['audience', 'createdAt', 'kind', 'recipient'])
  expect(JSON.stringify(exported)).not.toMatch(/identity_id|session_version|domain_event_id|token|password_hash/)
  for (const extra of [{ kind: 'invented' }, { sessionVersion: 1 }, { token: 'private-token' }]) {
    expect(
      accountPrivacyExportSchema.safeParse({ ...data, securityNotices: [{ ...expected[0], ...extra }] }).success
    ).toBe(false)
  }
})
it('never exports another identity notices even with a matching current email recipient', async () => {
  const receipt = await exportReceipt()
  securityNotice({ recipient: 'own-old@example.invalid' })
  securityNotice({ identityId: CLAIMS.identityId, recipient: 'buyer@example.invalid' })
  const data = await downloadD1AccountPrivacy(f.database, BUYER_CLAIMS, receipt.id, options)
  expect(data).toMatchObject({ securityNotices: [{ recipient: 'own-old@example.invalid' }] })
})
it('exports 1000 security notices but fails explicitly at 1001 without truncating', async () => {
  const receipt = await exportReceipt()
  for (let index = 0; index < 1000; index++) securityNotice()
  const data = await downloadD1AccountPrivacy(f.database, BUYER_CLAIMS, receipt.id, options)
  expect((data as typeof data & { securityNotices: unknown[] }).securityNotices).toHaveLength(1000)
  securityNotice()
  await expect(downloadD1AccountPrivacy(f.database, BUYER_CLAIMS, receipt.id, options)).rejects.toMatchObject({
    code: 'export_too_large'
  })
})
it('does not return historical security recipients after revocation during the awaited export read', async () => {
  const receipt = await exportReceipt()
  securityNotice()
  const prepare = f.database.prepare.bind(f.database)
  f.database.prepare = (sql) => {
    const statement = prepare(sql)
    if (sql.includes(' document')) {
      const first = statement.first.bind(statement)
      statement.first = async (...args: Parameters<typeof first>) => {
        const result = await first(...args)
        f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), BUYER_CLAIMS.sessionId)
        return result
      }
    }
    return statement
  }
  await expect(downloadD1AccountPrivacy(f.database, BUYER_CLAIMS, receipt.id, options)).rejects.toMatchObject({
    code: 'unauthenticated'
  })
})
it('registers an export with exact durable replay and an owner-only download', async () => {
  const input = { requestType: 'export', idempotencyKey: key }
  const receipt = (await executeD1AccountPrivacy(f.database, BUYER_CLAIMS, input, options)) as { id: string }
  expect(receipt).toMatchObject({ requestType: 'export', status: 'completed', commandId: key })
  expect(await executeD1AccountPrivacy(f.database, BUYER_CLAIMS, input, options)).toEqual(receipt)
  expect(await readD1AccountPrivacyCommand(f.database, BUYER_CLAIMS, key, options)).toMatchObject({
    outcome: 'applied',
    receipt
  })
  expect(await readD1AccountPrivacy(f.database, BUYER_CLAIMS, options)).toMatchObject({ requests: [receipt] })
  const data = await downloadD1AccountPrivacy(f.database, BUYER_CLAIMS, receipt.id, options)
  expect(data).toMatchObject({
    schemaVersion: 1,
    deliveryPreferences: null,
    profile: { email: 'buyer@example.invalid', name: 'Historical customer' }
  })
  expect(JSON.stringify(data)).not.toMatch(/password_hash|synthetic|session_version|token_hash|request_key|write_nonce/)
})
it('records anonymization intention without altering customer or orders', async () => {
  const result = await executeD1AccountPrivacy(
    f.database,
    BUYER_CLAIMS,
    { requestType: 'anonymize', idempotencyKey: key },
    options
  )
  expect(result).toMatchObject({ requestType: 'anonymize', status: 'requested', completedAt: null })
  expect(f.sqlite.prepare('SELECT status,name FROM customers WHERE id=?').get(CUSTOMER)).toEqual({
    status: 'active',
    name: 'Historical customer'
  })
})
it('exports only real own account preferences, keeping absent consent explicitly null', async () => {
  const receipt = await executeD1AccountPrivacy(
    f.database,
    BUYER_CLAIMS,
    { requestType: 'export', idempotencyKey: key },
    options
  )
  expect(await downloadD1AccountPrivacy(f.database, BUYER_CLAIMS, receipt.id, options)).toMatchObject({
    accountPreferences: null
  })
  await updateD1AccountPreferences(
    f.database,
    BUYER_CLAIMS,
    '22222222-2222-4222-8222-222222222265',
    {
      expectedVersion: 0,
      policyVersion: ACCOUNT_PREFERENCES_POLICY_VERSION,
      preferences: { product_updates: true, replenishment: false }
    },
    options
  )
  expect(await downloadD1AccountPrivacy(f.database, BUYER_CLAIMS, receipt.id, options)).toMatchObject({
    accountPreferences: { version: 1, product_updates: true, replenishment: false }
  })
})
it('exports the real delivery choice separately without fabricating commercial consent', async () => {
  const receipt = await executeD1AccountPrivacy(
    f.database,
    BUYER_CLAIMS,
    { requestType: 'export', idempotencyKey: key },
    options
  )
  const preference = await updateD1DeliveryPreferences(
    f.database,
    BUYER_CLAIMS,
    '22222222-2222-4222-8222-222222222270',
    {
      expectedVersion: 0,
      deliveryUpdates: false,
      policyVersion: DELIVERY_PREFERENCES_POLICY_VERSION
    },
    options
  )
  expect(await downloadD1AccountPrivacy(f.database, BUYER_CLAIMS, receipt.id, options)).toMatchObject({
    accountPreferences: null,
    deliveryPreferences: { version: preference.version, deliveryUpdates: false, updatedAt: preference.recordedAt }
  })
})
it('fails closed for anonymous and unverified sessions', async () => {
  await expect(readD1AccountPrivacy(f.database, null, options)).rejects.toMatchObject({ code: 'unauthenticated' })
  f.sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(BUYER_CLAIMS.identityId)
  await expect(readD1AccountPrivacy(f.database, BUYER_CLAIMS, options)).rejects.toMatchObject({
    code: 'email_unverified'
  })
})
it.each([
  {},
  { requestType: 'delete', idempotencyKey: key },
  { requestType: 'export', idempotencyKey: 'bad' },
  { requestType: 'export', idempotencyKey: key, customerId: CUSTOMER }
])('rejects malformed command %j', async (input) => {
  await expect(executeD1AccountPrivacy(f.database, BUYER_CLAIMS, input, options)).rejects.toMatchObject({
    code: 'invalid_input'
  })
})
it('rejects a changed same-key payload and returns explicit unknown for an unused key', async () => {
  await executeD1AccountPrivacy(f.database, BUYER_CLAIMS, { requestType: 'export', idempotencyKey: key }, options)
  await expect(
    executeD1AccountPrivacy(f.database, BUYER_CLAIMS, { requestType: 'anonymize', idempotencyKey: key }, options)
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(
    await readD1AccountPrivacyCommand(f.database, BUYER_CLAIMS, '22222222-2222-4222-8222-222222222265', options)
  ).toMatchObject({ outcome: 'unknown', receipt: null })
  expect(f.sqlite.prepare('SELECT count(*) n FROM account_privacy_requests').get()).toEqual({ n: 1 })
})
it('rejects another identity without an owned active customer and foreign downloads', async () => {
  const receipt = await executeD1AccountPrivacy(
    f.database,
    BUYER_CLAIMS,
    { requestType: 'export', idempotencyKey: key },
    options
  )
  await expect(downloadD1AccountPrivacy(f.database, CLAIMS, receipt.id, options)).rejects.toMatchObject({
    code: 'customer_required'
  })
  const foreign = '30000000-0000-4000-8000-000000000065'
  f.sqlite
    .prepare('INSERT INTO customers(id,name,created_at,updated_at) VALUES(?,?,?,?)')
    .run(foreign, 'Another owner', utc(-60000), utc(-60000))
  f.sqlite.prepare('UPDATE identities SET customer_id=? WHERE id=?').run(foreign, CLAIMS.identityId)
  expect(await readD1AccountPrivacy(f.database, CLAIMS, options)).toMatchObject({ requests: [] })
  await expect(downloadD1AccountPrivacy(f.database, CLAIMS, receipt.id, options)).rejects.toMatchObject({
    code: 'not_found'
  })
})
it('keeps exact original receipt after lost batch response and concurrent same-key execution', async () => {
  const batch = f.database.batch.bind(f.database)
  let competitor = false
  f.database.batch = async (statements) => {
    if (!competitor) {
      competitor = true
      await executeD1AccountPrivacy(f.database, BUYER_CLAIMS, { requestType: 'export', idempotencyKey: key }, options)
    }
    return batch(statements)
  }
  const first = await executeD1AccountPrivacy(
    f.database,
    BUYER_CLAIMS,
    { requestType: 'export', idempotencyKey: key },
    options
  )
  f.database.batch = async (statements) => {
    await batch(statements)
    throw new Error('lost')
  }
  const second = await executeD1AccountPrivacy(
    f.database,
    BUYER_CLAIMS,
    { requestType: 'anonymize', idempotencyKey: '22222222-2222-4222-8222-222222222265' },
    options
  )
  expect(await readD1AccountPrivacyCommand(f.database, BUYER_CLAIMS, key, options)).toMatchObject({ receipt: first })
  expect(second).toMatchObject({ status: 'requested' })
  expect(f.sqlite.prepare('SELECT count(*) n FROM account_privacy_requests').get()).toEqual({ n: 2 })
})
it('rolls back the request if the atomic batch fails', async () => {
  const batch = f.database.batch.bind(f.database)
  f.database.batch = (statements) =>
    batch([...statements, f.database.prepare('INSERT INTO definitely_missing_table VALUES(1)')])
  await expect(
    executeD1AccountPrivacy(f.database, BUYER_CLAIMS, { requestType: 'export', idempotencyKey: key }, options)
  ).rejects.toMatchObject({ code: 'unavailable' })
  expect(f.sqlite.prepare('SELECT count(*) n FROM account_privacy_requests').get()).toEqual({ n: 0 })
})
it('checks fresh authority inside the final write and prevents revoked writes', async () => {
  const batch = f.database.batch.bind(f.database)
  f.database.batch = async (statements) => {
    f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), BUYER_CLAIMS.sessionId)
    return batch(statements)
  }
  await expect(
    executeD1AccountPrivacy(f.database, BUYER_CLAIMS, { requestType: 'export', idempotencyKey: key }, options)
  ).rejects.toMatchObject({ code: 'unauthenticated' })
  expect(f.sqlite.prepare('SELECT count(*) n FROM account_privacy_requests').get()).toEqual({ n: 0 })
})
it.each(['session', 'email', 'owner'] as const)('checks %s revocation in final export SQL', async (kind) => {
  const receipt = await executeD1AccountPrivacy(
    f.database,
    BUYER_CLAIMS,
    { requestType: 'export', idempotencyKey: key },
    options
  )
  const prepare = f.database.prepare.bind(f.database)
  f.database.prepare = (sql) => {
    if (sql.includes(' document')) {
      if (kind === 'session')
        f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), BUYER_CLAIMS.sessionId)
      if (kind === 'email')
        f.sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(BUYER_CLAIMS.identityId)
      if (kind === 'owner') f.sqlite.prepare("UPDATE customers SET status='blocked' WHERE id=?").run(CUSTOMER)
    }
    return prepare(sql)
  }
  await expect(downloadD1AccountPrivacy(f.database, BUYER_CLAIMS, receipt.id, options)).rejects.toMatchObject({
    code: { session: 'unauthenticated', email: 'email_unverified', owner: 'customer_required' }[kind]
  })
})
it('exports only owner order summaries, never guest/foreign contracts or private notes', async () => {
  const owned = await f.order({ paid: false, delivered: false }),
    guest = await f.order({ owned: false, paid: false, delivered: false })
  const receipt = await executeD1AccountPrivacy(
    f.database,
    BUYER_CLAIMS,
    { requestType: 'export', idempotencyKey: key },
    options
  )
  const data = await downloadD1AccountPrivacy(f.database, BUYER_CLAIMS, receipt.id, options)
  expect(data.orders.map((o) => o.id)).toEqual([owned])
  expect(JSON.stringify(data)).not.toContain(guest)
  expect(Object.keys(data.orders[0]!)).toEqual(['id', 'orderStatus', 'totalCents', 'currency', 'createdAt'])
})
it('refuses oversized datasets instead of silently truncating', async () => {
  const receipt = await executeD1AccountPrivacy(
    f.database,
    BUYER_CLAIMS,
    { requestType: 'export', idempotencyKey: key },
    options
  )
  const insert = f.sqlite.prepare(
    "INSERT INTO customer_addresses(id,customer_id,kind,label,recipient_name,line1,postal_code,city,region,country_code,created_at,updated_at) VALUES(?,?,'shipping','Casa','Propietario','Calle propia','46870','Ontinyent','Valencia','ES',?,?)"
  )
  for (let i = 0; i < 1001; i++) insert.run('address-' + i, CUSTOMER, utc(-60000), utc(-60000))
  await expect(downloadD1AccountPrivacy(f.database, BUYER_CLAIMS, receipt.id, options)).rejects.toMatchObject({
    code: 'export_too_large'
  })
})
it.each(['list', 'download'])(
  'does not release private %s when authority revokes after its awaited query',
  async (kind) => {
    const receipt = await executeD1AccountPrivacy(
      f.database,
      BUYER_CLAIMS,
      { requestType: 'export', idempotencyKey: key },
      options
    )
    const prepare = f.database.prepare.bind(f.database)
    f.database.prepare = (sql) => {
      const statement = prepare(sql)
      if (sql.includes(kind === 'download' ? ' document' : 'page AS MATERIALIZED')) {
        const first = statement.first.bind(statement)
        statement.first = async (...args: Parameters<typeof first>) => {
          const result = await first(...args)
          f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), BUYER_CLAIMS.sessionId)
          return result
        }
      }
      return statement
    }
    await expect(
      kind === 'download'
        ? downloadD1AccountPrivacy(f.database, BUYER_CLAIMS, receipt.id, options)
        : readD1AccountPrivacy(f.database, BUYER_CLAIMS, options)
    ).rejects.toMatchObject({ code: 'unauthenticated' })
  }
)
it('enforces immutable ledger, UUIDs and UTC timestamps in D1 itself', async () => {
  const receipt = await executeD1AccountPrivacy(
    f.database,
    BUYER_CLAIMS,
    { requestType: 'export', idempotencyKey: key },
    options
  )
  expect(() =>
    f.sqlite.prepare("UPDATE account_privacy_requests SET status='requested' WHERE id=?").run(receipt.id)
  ).toThrow()
  expect(() => f.sqlite.exec('DELETE FROM account_privacy_requests')).toThrow()
  const row = f.sqlite.prepare('SELECT * FROM account_privacy_requests').get()!
  const columns = Object.keys(row),
    statement = f.sqlite.prepare(
      `INSERT INTO account_privacy_requests(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`
    )
  const changes: Record<string, SQLInputValue>[] = [
    { id: 'x'.repeat(36) },
    { command_id: 'x'.repeat(36) },
    { session_version: 0 },
    { requested_at: '2026-99-99T00:00:00Z' }
  ]
  for (const change of changes) {
    const invalid: Record<string, SQLInputValue> = {
      ...row,
      id: crypto.randomUUID(),
      command_id: crypto.randomUUID(),
      ...change
    }
    expect(() => statement.run(...columns.map((c) => invalid[c]!))).toThrow()
  }
})
