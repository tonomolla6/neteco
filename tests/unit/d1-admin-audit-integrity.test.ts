import { readFile, readdir } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { adminAuditFixture, ADMIN, utc } from './d1-admin-audit-fixture'
import { returnsFixture, CLAIMS } from './d1-returns-fixture'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { updateD1DraftProductMetadata } from '../../workers/catalog/admin-catalog-mutations'
import { cancelD1UnpaidOrder } from '../../workers/catalog/order-cancellation'
import { readD1AdminAudit, readD1AdminAuditDetail, exportD1AdminAudit } from '../../workers/auth/admin-audit'

it('reports the actual awaiting_payment state before a proven administrative cancellation', async () => {
  const f = await returnsFixture()
  try {
    const directory = new URL('../../db/d1/migrations/', import.meta.url)
    const files = (await readdir(directory))
      .filter(
        (name) =>
          /^\d{4}_[a-z0-9_]+\.sql$/.test(name) && Number(name.slice(0, 4)) > 62 && Number(name.slice(0, 4)) <= 84
      )
      .sort()
    f.sqlite.exec(
      'BEGIN;\n' +
        (await Promise.all(files.map((name) => readFile(new URL(name, directory), 'utf8')))).join('\n') +
        '\nCOMMIT;'
    )
    f.sqlite
      .prepare(
        "INSERT INTO identity_mfa(identity_id,encrypted_secret,recovery_code_hashes,verified_at,updated_at) VALUES(?,'synthetic-verified-factor','[]',?,?)"
      )
      .run(CLAIMS.identityId, utc(-60000), utc(-60000))
    const orderId = await f.order({ paid: false, delivered: false }),
      key = crypto.randomUUID()
    expect(f.sqlite.prepare('SELECT status FROM orders WHERE id=?').get(orderId)).toEqual({
      status: 'awaiting_payment'
    })
    await cancelD1UnpaidOrder(
      f.database,
      CLAIMS,
      orderId,
      key,
      { expectedStatus: 'awaiting_payment', reason: 'Cancelación administrativa revisada explícitamente.' },
      { audience: 'admin' }
    )
    const before = f.sqlite.prepare('SELECT total_changes() n').get()
    const detail = await readD1AdminAuditDetail(f.database, CLAIMS, `cancellation:${orderId}:${key}`)
    expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
    expect(detail.changes).toContainEqual({ field: 'status', before: 'awaiting_payment', after: 'cancelled' })
  } finally {
    f.sqlite.close()
  }
})

it.each(['missing', 'mismatched'] as const)(
  'fails closed for %s catalog audit instead of exporting a false empty history',
  async (damage) => {
    const f = await adminAuditFixture()
    try {
      seedInventoryFixture(f.sqlite)
      f.sqlite.exec(
        "INSERT INTO permissions VALUES('catalog.write','catalog','write','Synthetic fixture'); INSERT INTO role_permissions VALUES('admin','catalog.write'); UPDATE products SET status='draft',published_at=NULL WHERE id='p-1'"
      )
      const original = f.sqlite.prepare("SELECT catalog_version FROM products WHERE id='p-1'").get()!
      const key = crypto.randomUUID()
      await updateD1DraftProductMetadata(
        f.database,
        ADMIN,
        '1',
        {
          expectedVersion: Number(original.catalog_version),
          name: 'Reviewed catalog title',
          reason: 'Explicit synthetic metadata review.'
        },
        { idempotencyKey: key }
      )
      const healthy = await readD1AdminAudit(f.database, ADMIN, { family: 'catalog_metadata' })
      expect(healthy.items).toHaveLength(1)
      expect(healthy.items[0]).toMatchObject({ actorId: ADMIN.identityId, resourceId: 'p-1' })
      // Corrupt only this disposable fixture; production immutability remains intact.
      if (damage === 'missing') {
        f.sqlite.exec('DROP TRIGGER catalog_draft_audit_no_delete')
        f.sqlite.prepare('DELETE FROM catalog_draft_audit WHERE command_id=?').run(healthy.items[0]!.commandId)
      } else {
        f.sqlite.exec('DROP TRIGGER catalog_draft_audit_no_update')
        f.sqlite
          .prepare("UPDATE catalog_draft_audit SET reason='Mismatched audit evidence' WHERE command_id=?")
          .run(healthy.items[0]!.commandId)
      }
      const product = f.sqlite.prepare("SELECT * FROM products WHERE id='p-1'").get(),
        command = f.sqlite.prepare('SELECT * FROM catalog_draft_commands').all()
      const before = f.sqlite.prepare('SELECT total_changes() n').get()
      const read = await Promise.allSettled([readD1AdminAudit(f.database, ADMIN, { family: 'catalog_metadata' })])
      const exported = await Promise.allSettled([
        exportD1AdminAudit(
          f.database,
          ADMIN,
          { filters: { family: 'catalog_metadata' }, reason: 'Explicit integrity validation export.' },
          { idempotencyKey: crypto.randomUUID() }
        )
      ])
      expect(f.sqlite.prepare("SELECT * FROM products WHERE id='p-1'").get()).toEqual(product)
      expect(f.sqlite.prepare('SELECT * FROM catalog_draft_commands').all()).toEqual(command)
      const receipts = f.sqlite.prepare('SELECT count(*) n FROM admin_audit_commands').get()
      expect(read[0]).toMatchObject({ status: 'rejected', reason: { code: 'history_unconfirmed' } })
      expect(exported[0]).toMatchObject({ status: 'rejected', reason: { code: 'history_unconfirmed' } })
      expect(receipts).toEqual({ n: 0 })
      expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
    } finally {
      f.sqlite.close()
    }
  }
)
