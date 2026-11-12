import type { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  approveD1InventoryCountImport,
  previewD1InventoryCountImport,
  proposeD1InventoryCountImport,
  readD1InventoryCountImport,
  readD1InventoryCountImportCommand
} from '../../workers/catalog/inventory-count-import'
import { executeD1AdminInventoryCommand } from '../../workers/catalog/admin-inventory'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { testNow } from '../support/deterministic'

// The initial thirteen cases ran RED against productive signatures, then GREEN
// against the atomic importer and its real feature migration.
const ID = '10000000-0000-4000-8000-000000000081'
const OTHER = '10000000-0000-4000-8000-000000000082'
const SESSION = '20000000-0000-4000-8000-000000000081'
const OTHER_SESSION = '20000000-0000-4000-8000-000000000082'
const PRODUCT = '30000000-0000-4000-8000-000000000081'
const FIRST = '40000000-0000-4000-8000-000000000081'
const SECOND = '40000000-0000-4000-8000-000000000082'
const CLAIMS = { identityId: ID, sessionId: SESSION, sessionVersion: 1 }
const APPROVER = { identityId: OTHER, sessionId: OTHER_SESSION, sessionVersion: 1 }
const KEY = '50000000-0000-4000-8000-000000000081'
const APPROVAL_KEY = '50000000-0000-4000-8000-000000000082'
const csv = 'sku,countedPhysicalQuantity\nCOUNT-FIRST,18\nCOUNT-SECOND,33'
const reason = 'Synthetic physical count reviewed independently'
const reference = 'SYNTHETIC-COUNT-081'
const utc = (offset = 0) => new Date(testNow() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')

describe('D1 single-warehouse inventory count CSV import', () => {
  let sqlite: DatabaseSync
  let database: D1Database

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    try {
      sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0077_inventory_count_imports.sql', import.meta.url), 'utf8')
      )
    } catch (error) {
      sqlite.close()
      throw error
    }
    database = d1OverSqlite(sqlite)
    sqlite.limits.exprDepth = 100
    sqlite.limits.variableNumber = 100
    sqlite.limits.functionArg = 32
    sqlite.exec(`
      INSERT INTO categories(id,legacy_id,name,slug,status) VALUES('count-category',81,'Synthetic','count-category','draft');
      INSERT INTO tax_classes(id,code,name,rate_basis_points,valid_from) VALUES('count-tax','COUNT','Synthetic',2100,'2020-01-01T00:00:00Z');
      INSERT INTO shipping_profiles(id,code,name,kind) VALUES('count-ship','COUNT','Synthetic','parcel');
      INSERT INTO products(id,legacy_id,category_id,name,slug,status)
        VALUES('${PRODUCT}',81,'count-category','Synthetic draft','count-draft','draft');
      INSERT INTO inventory_locations(id,code,name,kind,active,created_at)
        VALUES('count-main','COUNT-MAIN','Synthetic only warehouse','warehouse',1,'2020-01-01T00:00:00Z');
      INSERT INTO roles VALUES('count-operator','Synthetic operator','Synthetic');
      INSERT INTO permissions VALUES('inventory.read','inventory','read','Synthetic');
      INSERT INTO permissions VALUES('inventory.write','inventory','write','Synthetic');
      INSERT INTO role_permissions VALUES('count-operator','inventory.read'),('count-operator','inventory.write');
    `)
    for (const [variant, legacy, sku, quantity] of [
      [FIRST, 81, 'COUNT-FIRST', 20],
      [SECOND, 82, 'COUNT-SECOND', 30]
    ] as const) {
      sqlite
        .prepare(
          `INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,unit_base,price_gross_cents,safety_stock)
        VALUES(?,?,?,'count-tax','count-ship',?,'Caja','draft','ud',0,2)`
        )
        .run(variant, legacy, PRODUCT, sku)
      sqlite
        .prepare(
          `INSERT INTO inventory_balances(variant_id,location_id,physical_quantity,blocked_quantity,version,created_at,updated_at)
        VALUES(?,'count-main',?,1,1,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')`
        )
        .run(variant, quantity)
      sqlite
        .prepare(
          `INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,reference_type,reference_id,idempotency_key,correlation_id,created_at)
        VALUES(?,?,'count-main','initial',?,0,'synthetic',NULL,?,'synthetic','2020-01-01T00:00:00Z')`
        )
        .run(`initial-${legacy}`, variant, quantity, `initial-${legacy}`)
    }
    for (const [identity, session] of [
      [ID, SESSION],
      [OTHER, OTHER_SESSION]
    ]) {
      sqlite
        .prepare(
          `INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
        VALUES(?,?,'synthetic',?,'active',?,?)`
        )
        .run(identity, `${identity}@example.invalid`, utc(-3600000), utc(-3600000), utc(-3600000))
      sqlite
        .prepare(
          `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
        VALUES(?,?,1,1,?,?)`
        )
        .run(session, identity, utc(-3600000), utc(3600000))
      sqlite
        .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?,'count-operator',?)")
        .run(identity, utc(-3600000))
    }
  })
  afterEach(() => sqlite?.close())

  const stock = () => ({
    balances: sqlite.prepare('SELECT * FROM inventory_balances ORDER BY variant_id,location_id').all(),
    movements: sqlite.prepare('SELECT * FROM inventory_movements ORDER BY id').all(),
    reservations: sqlite.prepare('SELECT * FROM inventory_reservations ORDER BY id').all()
  })
  const preview = (value = csv) => previewD1InventoryCountImport(database, CLAIMS, { csv: value })
  const propose = async (value = csv, key = KEY) => {
    const view = await preview(value)
    return proposeD1InventoryCountImport(
      database,
      CLAIMS,
      { csv: value, previewHash: view.previewHash, reason, reference },
      { idempotencyKey: key }
    )
  }
  const approve = (importId: string, claims = APPROVER, db = database) =>
    approveD1InventoryCountImport(
      db,
      claims,
      importId,
      { expectedVersion: 1, reason },
      { idempotencyKey: APPROVAL_KEY }
    )
  const receive = () =>
    executeD1AdminInventoryCommand(
      database,
      APPROVER,
      'receipt',
      { variantId: '82' },
      { expectedBalanceVersion: 1, quantity: 1, reason, reference },
      { idempotencyKey: 'synthetic-interleaving-receipt' }
    )

  it('previews reconciled draft SKU differences including zero without any database writes', async () => {
    const before = sqlite.prepare('SELECT total_changes() AS n').get()?.n
    const view = await preview('sku,countedPhysicalQuantity\ncount-first,20\nCOUNT-SECOND,33')
    expect(view).toMatchObject({
      source: 'cloudflare',
      canPropose: true,
      rows: [
        {
          rowNumber: 2,
          sku: 'count-first',
          variantId: 81,
          expectedBalanceVersion: 1,
          physicalQuantity: 20,
          countedPhysicalQuantity: 20,
          physicalDelta: 0,
          error: null
        },
        {
          rowNumber: 3,
          sku: 'COUNT-SECOND',
          variantId: 82,
          expectedBalanceVersion: 1,
          physicalQuantity: 30,
          countedPhysicalQuantity: 33,
          physicalDelta: 3,
          error: null
        }
      ]
    })
    expect(view.previewHash).toMatch(/^[0-9a-f]{64}$/)
    expect(sqlite.prepare('SELECT total_changes() AS n').get()?.n).toBe(before)
  })

  it.each([
    ['unknown SKU', 'MISSING,18', 'unknown_sku'],
    ['duplicate literal NOCASE SKU', 'COUNT-FIRST,18\ncount-first,19', 'duplicate_sku'],
    ['negative quantity', 'COUNT-FIRST,-1', 'invalid_quantity'],
    ['fractional quantity', 'COUNT-FIRST,1.5', 'invalid_quantity'],
    ['unsafe integer quantity', 'COUNT-FIRST,9007199254740992', 'invalid_quantity']
  ])('invalidates the whole preview for %s without stock effects', async (_label, rows, error) => {
    const before = stock()
    const view = await preview(`sku,countedPhysicalQuantity\n${rows}`)
    expect(view.canPropose).toBe(false)
    expect(view.rows.some((row) => row.error === error)).toBe(true)
    expect(stock()).toEqual(before)
  })

  it('reports ambiguous case-insensitive catalog matches rather than choosing one', async () => {
    sqlite.prepare('UPDATE variants SET sku=? WHERE id=?').run('count-first', SECOND)
    const view = await preview('sku,countedPhysicalQuantity\nCOUNT-FIRST,18')
    expect(view).toMatchObject({ canPropose: false, rows: [{ variantId: null, error: 'ambiguous_sku' }] })
  })

  it('keeps zero differences visible but rejects a no-change proposal', async () => {
    const value = 'sku,countedPhysicalQuantity\nCOUNT-FIRST,20\nCOUNT-SECOND,30'
    expect(await preview(value)).toMatchObject({
      canPropose: false,
      rows: [{ physicalDelta: 0 }, { physicalDelta: 0 }]
    })
    await expect(propose(value)).rejects.toMatchObject({ code: 'no_change' })
  })

  it('binds a proposal to the exact preview versions and rejects stale facts without partial writes', async () => {
    const view = await preview()
    await receive()
    const before = stock()
    await expect(
      proposeD1InventoryCountImport(
        database,
        CLAIMS,
        { csv, previewHash: view.previewHash, reason, reference },
        { idempotencyKey: KEY }
      )
    ).rejects.toMatchObject({ code: 'preview_conflict' })
    expect(stock()).toEqual(before)
  })

  it('proposes without effects and requires another actor to approve all rows atomically', async () => {
    const before = stock()
    const proposed = await propose()
    expect(proposed).toMatchObject({
      commandId: KEY,
      action: 'propose',
      expectedVersion: 0,
      version: 1,
      rowCount: 2,
      changedCount: 2,
      inventoryEffect: 'none',
      economicEffect: 'none'
    })
    expect(stock()).toEqual(before)
    await expect(approve(proposed.importId, CLAIMS)).rejects.toMatchObject({ code: 'approval_self' })
    expect(stock()).toEqual(before)
    const applied = await approve(proposed.importId)
    expect(applied).toMatchObject({
      commandId: APPROVAL_KEY,
      action: 'approve',
      version: 2,
      inventoryEffect: 'physical_adjustment',
      economicEffect: 'none'
    })
    expect(
      sqlite.prepare('SELECT physical_quantity AS quantity,version FROM inventory_balances ORDER BY variant_id').all()
    ).toEqual([
      { quantity: 18, version: 2 },
      { quantity: 33, version: 2 }
    ])
    expect(await readD1InventoryCountImport(database, APPROVER, proposed.importId)).toMatchObject({
      status: 'approved',
      approvedBy: OTHER,
      version: 2
    })
    const after = stock()
    expect(await approve(proposed.importId)).toEqual(applied)
    expect(stock()).toEqual(after)
    expect(await readD1InventoryCountImportCommand(database, APPROVER, APPROVAL_KEY, applied.payloadHash)).toEqual({
      source: 'cloudflare',
      outcome: 'applied',
      receipt: applied
    })
  })

  it('aborts every row if one balance changed after the proposal', async () => {
    const proposed = await propose()
    await receive()
    const before = stock()
    await expect(approve(proposed.importId)).rejects.toMatchObject({ code: 'version_conflict' })
    expect(stock()).toEqual(before)
    expect(await readD1InventoryCountImport(database, APPROVER, proposed.importId)).toMatchObject({
      status: 'proposed',
      version: 1
    })
  })

  it('rolls back the first adjustment and receipt if a later real ledger insert fails', async () => {
    const proposed = await propose()
    sqlite.exec(`CREATE TRIGGER synthetic_count_failure BEFORE INSERT ON inventory_movements
      WHEN NEW.variant_id='${SECOND}' AND NEW.movement_type<>'initial'
      BEGIN SELECT RAISE(ABORT,'synthetic_count_failure'); END`)
    const before = stock()
    await expect(approve(proposed.importId)).rejects.toBeDefined()
    expect(stock()).toEqual(before)
    expect(await readD1InventoryCountImport(database, APPROVER, proposed.importId)).toMatchObject({
      status: 'proposed',
      version: 1
    })
    sqlite.exec('DROP TRIGGER synthetic_count_failure')
    expect(await approve(proposed.importId)).toMatchObject({ version: 2, inventoryEffect: 'physical_adjustment' })
  })

  it('replays the historical proposal exactly and rejects changed payload under the same key', async () => {
    const view = await preview()
    const input = { csv, previewHash: view.previewHash, reason, reference }
    const proposed = await proposeD1InventoryCountImport(database, CLAIMS, input, { idempotencyKey: KEY })
    await approve(proposed.importId)
    expect(await proposeD1InventoryCountImport(database, CLAIMS, input, { idempotencyKey: KEY })).toEqual(proposed)
    await expect(
      proposeD1InventoryCountImport(
        database,
        CLAIMS,
        { ...input, reason: 'Different synthetic reason' },
        { idempotencyKey: KEY }
      )
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it('preserves unchanged rows and increments only changed balance versions', async () => {
    const proposed = await propose('sku,countedPhysicalQuantity\nCOUNT-FIRST,20\nCOUNT-SECOND,33')
    expect(proposed).toMatchObject({ rowCount: 2, changedCount: 1 })
    await approve(proposed.importId)
    expect(await readD1InventoryCountImport(database, APPROVER, proposed.importId)).toMatchObject({
      rows: [
        { expectedBalanceVersion: 1, physicalDelta: 0, currentBalanceVersion: 1, currentPhysicalQuantity: 20 },
        { expectedBalanceVersion: 1, physicalDelta: 3, currentBalanceVersion: 2, currentPhysicalQuantity: 33 }
      ]
    })
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM inventory_movements WHERE movement_type='adjustment'").get()?.n
    ).toBe(1)
  })

  it('normalizes SKU trim/NFC before literal catalog matching without fuzzy matching', async () => {
    sqlite.prepare('UPDATE variants SET sku=? WHERE id=?').run('CAFÉ-COUNT', FIRST)
    expect(await preview('sku,countedPhysicalQuantity\n  CAFE\u0301-COUNT  ,18')).toMatchObject({
      canPropose: true,
      rows: [{ sku: 'CAFÉ-COUNT', variantId: 81, error: null }]
    })
    expect(await preview('sku,countedPhysicalQuantity\nCAFE-COUNT,18')).toMatchObject({
      canPropose: false,
      rows: [{ error: 'unknown_sku' }]
    })
  })

  it('does not assign a withdrawn SKU to the old variant between lookup and canonical facts', async () => {
    let changed = false
    const interleaved = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return (sql: string) => {
            if (!changed && sql.includes('SELECT * FROM state')) {
              changed = true
              sqlite.prepare('UPDATE variants SET sku=? WHERE id=?').run('RENAMED-COUNT', FIRST)
            }
            return target.prepare(sql)
          }
        const value: unknown = Reflect.get(target, key, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    const before = stock()
    expect(
      await previewD1InventoryCountImport(interleaved, CLAIMS, { csv: 'sku,countedPhysicalQuantity\nCOUNT-FIRST,18' })
    ).toMatchObject({ canPropose: false, rows: [{ error: 'source_unavailable' }] })
    expect(stock()).toEqual(before)
  })

  it('rechecks current authority inside the atomic batch after a session is revoked', async () => {
    const proposed = await propose(),
      before = stock()
    const interleaved = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), OTHER_SESSION)
            return target.batch(statements)
          }
        const value: unknown = Reflect.get(target, key, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await expect(approve(proposed.importId, APPROVER, interleaved)).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(stock()).toEqual(before)
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM inventory_count_import_commands WHERE action='approve'").get()?.n
    ).toBe(0)
  })

  it('rejects a concurrent already-approved batch under another key as a proven version conflict', async () => {
    const proposed = await propose()
    let winner: Awaited<ReturnType<typeof approve>> | undefined
    const interleaved = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            winner = await approve(proposed.importId)
            return target.batch(statements)
          }
        const value: unknown = Reflect.get(target, key, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await expect(
      approveD1InventoryCountImport(
        interleaved,
        APPROVER,
        proposed.importId,
        { expectedVersion: 1, reason },
        {
          idempotencyKey: '50000000-0000-4000-8000-000000000083'
        }
      )
    ).rejects.toMatchObject({ code: 'version_conflict' })
    expect(winner).toMatchObject({ version: 2 })
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM inventory_count_import_commands WHERE action='approve'").get()?.n
    ).toBe(1)
  })

  it('imports the full hundred-row bound with a bounded SQL statement budget and no per-row bindings', async () => {
    const lines = ['COUNT-FIRST,21', 'COUNT-SECOND,31']
    for (let index = 100; index < 198; index++) {
      const id = `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`
      sqlite
        .prepare(
          `INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,unit_base,price_gross_cents,safety_stock)
        VALUES(?,?,?,'count-tax','count-ship',?,'Caja','draft','ud',0,2)`
        )
        .run(id, index, PRODUCT, `COUNT-${index}`)
      sqlite
        .prepare(
          `INSERT INTO inventory_balances(variant_id,location_id,physical_quantity,blocked_quantity,version,created_at,updated_at)
        VALUES(?,'count-main',20,1,1,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')`
        )
        .run(id)
      sqlite
        .prepare(
          `INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,reference_type,reference_id,idempotency_key,correlation_id,created_at)
        VALUES(?,?,'count-main','initial',20,0,'synthetic',NULL,?,'synthetic','2020-01-01T00:00:00Z')`
        )
        .run(`initial-${index}`, id, `initial-${index}`)
      lines.push(`COUNT-${index},21`)
    }
    const proposed = await propose('sku,countedPhysicalQuantity\n' + lines.join('\n'))
    let statements = 0
    const measured = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return (sql: string) => {
            statements++
            expect(new TextEncoder().encode(sql).length).toBeLessThan(100000)
            return target.prepare(sql)
          }
        const value: unknown = Reflect.get(target, key, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    expect(await approve(proposed.importId, APPROVER, measured)).toMatchObject({ rowCount: 100, changedCount: 100 })
    expect(statements).toBeLessThanOrEqual(50)
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM inventory_movements WHERE movement_type='adjustment'").get()?.n
    ).toBe(100)
  })

  it('fails closed when command/audit timestamps contradict the correlated receipt', async () => {
    const proposed = await propose()
    // Deliberate isolated corruption, not a production removal of protection.
    sqlite.exec(
      'DROP TRIGGER inventory_count_import_commands_no_update; DROP TRIGGER inventory_count_import_audit_no_update'
    )
    sqlite
      .prepare("UPDATE inventory_count_import_commands SET created_at='invalid' WHERE actor_id=? AND idempotency_key=?")
      .run(ID, KEY)
    sqlite.prepare("UPDATE inventory_count_import_audit SET created_at='invalid' WHERE actor_id=?").run(ID)
    await expect(readD1InventoryCountImportCommand(database, CLAIMS, KEY, proposed.payloadHash)).rejects.toMatchObject({
      code: 'history_unconfirmed'
    })
  })

  it('lets a read-only operator preview facts but does not advertise proposal authority', async () => {
    sqlite.exec("DELETE FROM role_permissions WHERE role_code='count-operator' AND permission_code='inventory.write'")
    const before = stock()
    expect(await preview()).toMatchObject({ canPropose: false, rows: [{ physicalDelta: -2 }, { physicalDelta: 3 }] })
    expect(stock()).toEqual(before)
  })
})
