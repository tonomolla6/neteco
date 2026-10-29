import { describe, expect, it } from 'vitest'
import { orderViewsFixture, ADMIN, OTHER, utc, DEFINITION } from './d1-admin-order-views-fixture'
import { adminOrderViewIntentHash, adminOrderViewDefinitionSchema } from '../../shared/admin-order-views'
import { parseAdminOrderQuery } from '../../workers/catalog/admin-orders-http'
import {
  readD1AdminOrderViews,
  readD1AdminOrderView,
  createD1AdminOrderView,
  updateD1AdminOrderView,
  archiveD1AdminOrderView,
  readD1AdminOrderViewCommand
} from '../../workers/catalog/admin-order-views'
const options = () => ({ idempotencyKey: crypto.randomUUID() })
describe('private D1 administrative order views', () => {
  it('rejects REPLACE of immutable commands and archived projections with recursive triggers off', async () => {
    const outcomes: boolean[] = []
    for (const target of ['command', 'projection']) {
      const f = await orderViewsFixture()
      try {
        f.sqlite.exec('PRAGMA recursive_triggers=OFF')
        const receipt = await createD1AdminOrderView(f.database, ADMIN, f.input, options())
        if (target === 'command') {
          const row = f.sqlite.prepare('SELECT * FROM admin_order_view_commands WHERE id=?').get(receipt.commandId)!
          const changedReceipt = { ...receipt, action: 'update', version: 2 }
          try {
            f.sqlite
              .prepare(
                "INSERT OR REPLACE INTO admin_order_view_commands(id,actor_id,session_id,session_version,action,view_id,expected_version,payload_hash,input_json,snapshot_json,receipt_json,recorded_at) VALUES(?,?,?,?,'update',?,1,?,?,?,?,?)"
              )
              .run(
                row.id,
                row.actor_id,
                row.session_id,
                row.session_version,
                row.view_id,
                row.payload_hash,
                row.input_json,
                row.snapshot_json,
                JSON.stringify(changedReceipt),
                row.recorded_at
              )
            outcomes.push(true)
          } catch {
            outcomes.push(false)
          }
        } else {
          const original = f.sqlite.prepare('SELECT * FROM admin_order_views WHERE id=?').get(receipt.viewId)!
          await updateD1AdminOrderView(f.database, ADMIN, receipt.viewId, { ...f.input, expectedVersion: 1 }, options())
          await archiveD1AdminOrderView(f.database, ADMIN, receipt.viewId, { expectedVersion: 2 }, options())
          try {
            f.sqlite
              .prepare(
                'INSERT OR REPLACE INTO admin_order_views(id,owner_id,name,definition_json,version,archived,created_at,updated_at,archived_at,command_id) VALUES(?,?,?,?,?,?,?,?,?,?)'
              )
              .run(
                original.id,
                original.owner_id,
                original.name,
                original.definition_json,
                original.version,
                original.archived,
                original.created_at,
                original.updated_at,
                original.archived_at,
                original.command_id
              )
            outcomes.push(true)
          } catch {
            outcomes.push(false)
          }
        }
      } finally {
        f.sqlite.close()
      }
    }
    expect(outcomes).toEqual([false, false])
  })
  it('creates a normalized private definition and reads it without an order snapshot', async () => {
    const f = await orderViewsFixture()
    try {
      const receipt = await createD1AdminOrderView(
        f.database,
        ADMIN,
        { ...f.input, name: '  Preparacio\u0301n  ' },
        options()
      )
      expect(receipt).toMatchObject({ action: 'create', version: 1 })
      const detail = await readD1AdminOrderView(f.database, ADMIN, receipt.viewId)
      expect(detail.view).toMatchObject({ name: 'Preparación', version: 1, archived: false, definition: DEFINITION })
      expect(await readD1AdminOrderViews(f.database, ADMIN)).toMatchObject({
        source: 'cloudflare',
        items: [detail.view]
      })
      expect(JSON.stringify(detail)).not.toContain(ADMIN.identityId)
      f.sqlite.exec('DROP TRIGGER admin_order_views_update_guard')
      f.sqlite
        .prepare('UPDATE admin_order_views SET definition_json=? WHERE id=?')
        .run(JSON.stringify({ ...DEFINITION, q: 'private@example.invalid' }), receipt.viewId)
      await expect(readD1AdminOrderViews(f.database, ADMIN)).rejects.toMatchObject({ code: 'history_unconfirmed' })
      await expect(readD1AdminOrderView(f.database, ADMIN, receipt.viewId)).rejects.toMatchObject({
        code: 'history_unconfirmed'
      })
    } finally {
      f.sqlite.close()
    }
  })
  it('replays the exact command with no write and rejects altered payloads', async () => {
    const f = await orderViewsFixture()
    try {
      const opts = options(),
        receipt = await createD1AdminOrderView(f.database, ADMIN, f.input, opts)
      const changes = f.sqlite.prepare('SELECT total_changes() n').get()
      expect(await createD1AdminOrderView(f.database, ADMIN, f.input, opts)).toEqual(receipt)
      expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(changes)
      await expect(
        createD1AdminOrderView(f.database, ADMIN, { ...f.input, name: 'Otro nombre' }, opts)
      ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    } finally {
      f.sqlite.close()
    }
  })
  it('updates through CAS and archives without deleting immutable history', async () => {
    const f = await orderViewsFixture()
    try {
      const first = await createD1AdminOrderView(f.database, ADMIN, f.input, options())
      const updated = await updateD1AdminOrderView(
        f.database,
        ADMIN,
        first.viewId,
        {
          ...f.input,
          expectedVersion: 1,
          name: 'Pedidos por cobrar',
          definition: { ...DEFINITION, bucket: 'por_cobrar' }
        },
        options()
      )
      expect(updated.version).toBe(2)
      await expect(
        updateD1AdminOrderView(f.database, ADMIN, first.viewId, { ...f.input, expectedVersion: 1 }, options())
      ).rejects.toMatchObject({ code: 'version_conflict' })
      const archived = await archiveD1AdminOrderView(f.database, ADMIN, first.viewId, { expectedVersion: 2 }, options())
      expect(archived.version).toBe(3)
      expect((await readD1AdminOrderViews(f.database, ADMIN)).items).toEqual([])
      expect((await readD1AdminOrderView(f.database, ADMIN, first.viewId)).view).toMatchObject({
        archived: true,
        version: 3,
        archivedAt: archived.recordedAt
      })
      expect(f.sqlite.prepare('SELECT count(*) n FROM admin_order_view_commands').get()).toEqual({ n: 3 })
      await expect(
        updateD1AdminOrderView(f.database, ADMIN, first.viewId, { ...f.input, expectedVersion: 3 }, options())
      ).rejects.toMatchObject({ code: 'view_archived' })
    } finally {
      f.sqlite.close()
    }
  })
  it('hides foreign views and receipts from another fully privileged administrator', async () => {
    const f = await orderViewsFixture()
    try {
      const opts = options(),
        receipt = await createD1AdminOrderView(f.database, ADMIN, f.input, opts)
      expect((await readD1AdminOrderViews(f.database, OTHER)).items).toEqual([])
      await expect(readD1AdminOrderView(f.database, OTHER, receipt.viewId)).rejects.toMatchObject({ code: 'not_found' })
      await expect(
        updateD1AdminOrderView(f.database, OTHER, receipt.viewId, { ...f.input, expectedVersion: 1 }, options())
      ).rejects.toMatchObject({ code: 'not_found' })
      await expect(
        readD1AdminOrderViewCommand(
          f.database,
          OTHER,
          opts.idempotencyKey,
          await adminOrderViewIntentHash('create', null, f.input)
        )
      ).rejects.toMatchObject({ code: 'not_found' })
    } finally {
      f.sqlite.close()
    }
  })
  it('recovers exact receipts, reports authorized unknown and rechecks auth before replay', async () => {
    const f = await orderViewsFixture()
    try {
      const opts = options(),
        receipt = await createD1AdminOrderView(f.database, ADMIN, f.input, opts),
        hash = await adminOrderViewIntentHash('create', null, f.input)
      expect(await readD1AdminOrderViewCommand(f.database, ADMIN, opts.idempotencyKey, hash)).toEqual({
        source: 'cloudflare',
        outcome: 'applied',
        receipt
      })
      expect(await readD1AdminOrderViewCommand(f.database, ADMIN, crypto.randomUUID(), 'a'.repeat(64))).toEqual({
        source: 'cloudflare',
        outcome: 'unknown',
        receipt: null
      })
      f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), ADMIN.sessionId)
      await expect(createD1AdminOrderView(f.database, ADMIN, f.input, opts)).rejects.toMatchObject({
        code: 'unauthenticated'
      })
    } finally {
      f.sqlite.close()
    }
  })
  it('requires verified email and current real MFA enrollment', async () => {
    const f = await orderViewsFixture()
    try {
      await expect(readD1AdminOrderViews(f.database, null)).rejects.toMatchObject({ code: 'unauthenticated' })
      f.sqlite.prepare('DELETE FROM identity_mfa WHERE identity_id=?').run(ADMIN.identityId)
      await expect(readD1AdminOrderViews(f.database, ADMIN)).rejects.toMatchObject({ code: 'mfa_required' })
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects PII search, paging, duplicate columns and impossible date filters', async () => {
    const f = await orderViewsFixture()
    try {
      for (const definition of [
        { ...DEFINITION, q: 'private@example.invalid' },
        { ...DEFINITION, page: 2 },
        { ...DEFINITION, columns: ['total', 'total'] },
        { ...DEFINITION, from: '2026-02-30' },
        { ...DEFINITION, from: '2026-10-10', to: '2026-10-09' }
      ])
        await expect(
          createD1AdminOrderView(f.database, ADMIN, { ...f.input, definition }, options())
        ).rejects.toMatchObject({ code: 'invalid_input' })
      for (const name of ['line\nbreak', 'bad\u0085name', 'bad\u2028name', 'x'.repeat(61)])
        await expect(createD1AdminOrderView(f.database, ADMIN, { ...f.input, name }, options())).rejects.toMatchObject({
          code: 'invalid_input'
        })
    } finally {
      f.sqlite.close()
    }
  })
  it('uses exactly the existing order query enums without persisting q or pagination', () => {
    const definition = adminOrderViewDefinitionSchema.parse({
      ...DEFINITION,
      paymentStatus: 'captured',
      orderStatus: 'awaiting_payment',
      shippingMethod: 'parcel',
      customerType: 'b2b',
      from: '2026-10-01',
      to: '2026-10-09'
    })
    const { columns, ...query } = definition
    expect(columns).toHaveLength(3)
    expect(parseAdminOrderQuery(new URLSearchParams(query))).toMatchObject(query)
  })
  it('enforces twenty active views and releases a slot only by explicit archive', async () => {
    const f = await orderViewsFixture()
    try {
      const receipts = []
      for (let index = 0; index < 20; index++)
        receipts.push(
          await createD1AdminOrderView(f.database, ADMIN, { ...f.input, name: `Vista ${index}` }, options())
        )
      expect((await readD1AdminOrderViews(f.database, ADMIN)).items).toHaveLength(20)
      await expect(createD1AdminOrderView(f.database, ADMIN, f.input, options())).rejects.toMatchObject({
        code: 'limit_reached'
      })
      expect(f.sqlite.prepare('SELECT count(*) n FROM admin_order_view_commands').get()).toEqual({ n: 20 })
      await archiveD1AdminOrderView(f.database, ADMIN, receipts[0]!.viewId, { expectedVersion: 1 }, options())
      await createD1AdminOrderView(f.database, ADMIN, f.input, options())
      expect((await readD1AdminOrderViews(f.database, ADMIN)).items).toHaveLength(20)
    } finally {
      f.sqlite.close()
    }
  })
  it('rolls back if the session is revoked immediately before the write batch', async () => {
    const f = await orderViewsFixture()
    try {
      let revoked = false
      const db = {
        prepare: f.database.prepare.bind(f.database),
        async batch(statements: D1PreparedStatement[]) {
          if (
            !revoked &&
            statements.some((statement) =>
              String((statement as unknown as { sql?: string }).sql).includes('INSERT INTO admin_order_view_commands')
            )
          ) {
            revoked = true
            f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), ADMIN.sessionId)
          }
          return f.database.batch(statements)
        }
      } as D1Database
      await expect(createD1AdminOrderView(db, ADMIN, f.input, options())).rejects.toMatchObject({
        code: 'unauthenticated'
      })
      expect(revoked).toBe(true)
      expect(f.sqlite.prepare('SELECT count(*) n FROM admin_order_views').get()).toEqual({ n: 0 })
      expect(f.sqlite.prepare('SELECT count(*) n FROM admin_order_view_commands').get()).toEqual({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
  it('reports an outage without presenting an empty successful list', async () => {
    const db = {
      prepare() {
        throw new Error('synthetic-private-SQL')
      }
    } as unknown as D1Database
    await expect(readD1AdminOrderViews(db, ADMIN)).rejects.toMatchObject({ code: 'service_unavailable' })
  })
})
