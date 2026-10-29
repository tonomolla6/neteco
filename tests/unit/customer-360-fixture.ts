import { readFile, readdir } from 'node:fs/promises'
import { supportFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-support-fixture'
import { executeSupportAdminCommand } from '../../workers/support/operations'
export { CLAIMS, BUYER_CLAIMS, utc }
export async function customer360Fixture() {
  const f = await supportFixture()
  const directory = new URL('../../db/d1/migrations/', import.meta.url)
  const files = (await readdir(directory))
    .filter(
      (file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file) && Number(file.slice(0, 4)) > 62 && Number(file.slice(0, 4)) <= 89
    )
    .sort()
  const sources = await Promise.all(files.map((file) => readFile(new URL(file, directory), 'utf8')))
  f.sqlite.exec(`BEGIN;\n${sources.join('\n')}\nCOMMIT;`)
  f.sqlite
    .prepare(
      "INSERT INTO identity_mfa(identity_id,encrypted_secret,verified_at,updated_at) VALUES(?,'synthetic-unused',?,?)"
    )
    .run(CLAIMS.identityId, utc(-60000), utc(-60000))
  const customerId = (
    f.sqlite.prepare('SELECT customer_id FROM identities WHERE id=?').get(BUYER_CLAIMS.identityId) as {
      customer_id: string
    }
  ).customer_id
  const created = await f.ticket()
  const dueAt = utc(3600000)
  await executeSupportAdminCommand(
    f.database,
    CLAIMS,
    created.publicRef,
    {
      action: 'update',
      expectedVersion: 1,
      state: 'open',
      priority: 'high',
      ownerId: CLAIMS.identityId,
      nextActionAt: dueAt,
      slaDueAt: null,
      reason: 'Seguimiento sintético acordado explícitamente.'
    },
    { idempotencyKey: crypto.randomUUID() }
  )
  function fullAccess() {
    f.sqlite.exec(
      "INSERT INTO permissions VALUES('orders.read','orders','read','Existing order context scope'),('payments.read','payments','read','Existing payment context scope'),('invoices.read','invoices','read','Existing fiscal context scope'); INSERT INTO role_permissions VALUES('operator','orders.read'),('operator','payments.read'),('operator','invoices.read'),('operator','administration.manage');"
    )
  }
  const economic = () =>
    [
      'orders',
      'order_lines',
      'inventory_balances',
      'inventory_movements',
      'order_payment_states',
      'refund_receipts',
      'fiscal_invoice_intents',
      'support_commands'
    ].map((table) => f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
  return { ...f, customerId, publicRef: created.publicRef, dueAt, fullAccess, economic }
}
