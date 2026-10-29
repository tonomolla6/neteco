import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  executeD1AdminInventoryCommand,
  readD1AdminInventoryVariant,
  readD1AdminInventoryVariants,
  InventoryCommandError
} from '../../workers/catalog/admin-inventory'
import { inventoryReceiptInputSchema, inventoryCountProposalInputSchema } from '../../shared/inventory-commands'
import { assignReservation, releaseReservation, reserveInventory } from '../../workers/catalog/inventory'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'

const ID = '10000000-0000-4000-8000-000000000041',
  OTHER = '10000000-0000-4000-8000-000000000042',
  SESSION = '20000000-0000-4000-8000-000000000041',
  OTHER_SESSION = '20000000-0000-4000-8000-000000000042'
const PRODUCT = '30000000-0000-4000-8000-000000000041',
  VARIANT = '40000000-0000-4000-8000-000000000041'
const CLAIMS = { identityId: ID, sessionId: SESSION, sessionVersion: 1 },
  APPROVER = { identityId: OTHER, sessionId: OTHER_SESSION, sessionVersion: 1 }
const utc = (offset = 0) => new Date(Date.now() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
const reason = 'Synthetic physical inventory decision',
  reference = 'SYNTHETIC-DELIVERY-041'
describe('private single-warehouse D1 manual inventory', () => {
  let sqlite: DatabaseSync, database: D1Database
  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    if (!sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='inventory_admin_commands'").get())
      sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0041_admin_inventory_commands.sql', import.meta.url), 'utf8')
      )
    sqlite.limits.exprDepth = 100
    sqlite.limits.variableNumber = 100
    sqlite.limits.functionArg = 32
    database = d1OverSqlite(sqlite)
    sqlite.exec(`INSERT INTO categories(id,legacy_id,name,slug,status) VALUES('category',1,'Synthetic category','synthetic-category','draft');
      INSERT INTO tax_classes(id,code,name,rate_basis_points,valid_from) VALUES('tax','SYNTHETIC','Synthetic',2100,'2020-01-01T00:00:00Z');
      INSERT INTO shipping_profiles(id,code,name,kind) VALUES('ship','SYNTHETIC','Synthetic','parcel');
      INSERT INTO products(id,legacy_id,category_id,name,slug,status) VALUES('${PRODUCT}',1,'category','Synthetic draft','synthetic-draft','draft');
      INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,unit_base,price_gross_cents,safety_stock)
        VALUES('${VARIANT}',11,'${PRODUCT}','tax','ship','SYNTHETIC-SKU','Caja','draft','ud',0,2);
      INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES('main','MAIN','Synthetic only warehouse','warehouse',1,'2020-01-01T00:00:00Z');
      INSERT INTO inventory_balances(variant_id,location_id,physical_quantity,blocked_quantity,version,created_at,updated_at)
        VALUES('${VARIANT}','main',20,1,1,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z');
      INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,reference_type,reference_id,idempotency_key,correlation_id,created_at)
        VALUES('initial','${VARIANT}','main','initial',20,0,'synthetic',NULL,'initial','synthetic','2020-01-01T00:00:00Z');
      INSERT INTO roles VALUES('warehouse','Warehouse operator','Synthetic local operator');
      INSERT INTO permissions VALUES('inventory.read','inventory','read','Synthetic');
      INSERT INTO permissions VALUES('inventory.write','inventory','write','Synthetic');
      INSERT INTO role_permissions VALUES('warehouse','inventory.read'),('warehouse','inventory.write');`)
    for (const [id, session] of [
      [ID, SESSION],
      [OTHER, OTHER_SESSION]
    ]) {
      sqlite
        .prepare(
          "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES(?,?,'synthetic',?,'active',?,?)"
        )
        .run(id, `${id}@example.invalid`, utc(-3600000), utc(-3600000), utc(-3600000))
      sqlite
        .prepare(
          'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,?)'
        )
        .run(session, id, utc(-3600000), utc(3600000))
      sqlite
        .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?,'warehouse',?)")
        .run(id, utc(-3600000))
    }
  })
  afterEach(() => sqlite.close())
  const body = (extra: Record<string, unknown> = {}) => ({
    expectedBalanceVersion: 1,
    quantity: 5,
    reason,
    reference,
    ...extra
  })
  const receive = (input: unknown = body(), key = 'receipt', db?: D1Database, claims = CLAIMS) =>
    executeD1AdminInventoryCommand(db ?? database, claims, 'receipt', { variantId: '11' }, input, {
      idempotencyKey: key
    })
  const read = (claims = CLAIMS, db?: D1Database) =>
    readD1AdminInventoryVariant(db ?? database, claims, '11', { page: 1, perPage: 50 })
  const physical = () => sqlite.prepare('SELECT physical_quantity AS quantity,version FROM inventory_balances').get()
  const counts = () =>
    [
      'inventory_admin_commands',
      'inventory_admin_audit',
      'inventory_count_proposals',
      'inventory_count_approvals',
      'inventory_admin_guards'
    ].map((table) => sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n)
  function beforeBatch(change: () => void): D1Database {
    return new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            change()
            return target.batch(statements)
          }
        const value: unknown = Reflect.get(target, key, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }
  it('has real reconciled contextual facts for warehouse operator without catalog/admin grants', async () => {
    const result = await read()
    expect(result.balance).toEqual({
      physicalQuantity: 20,
      blockedQuantity: 1,
      safetyStock: 2,
      reservedQuantity: 0,
      sellableQuantity: 17,
      version: 1
    })
    expect(result.ledger.items[0]?.actorId).toBeNull()
    expect(result.capabilities.inventoryReceipt).toBe(true)
  })
  it('receives once with exact historical receipt and immutable real actor', async () => {
    const first = await receive()
    expect(first.physicalDelta).toBe(5)
    expect(first.balanceVersion).toBe(2)
    expect(physical()).toMatchObject({ quantity: 25, version: 2 })
    await receive(body({ expectedBalanceVersion: 2, quantity: 2 }), 'next')
    const replay = await receive()
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first))
    expect(physical()).toMatchObject({ quantity: 27, version: 3 })
    const view = await read()
    expect(view.ledger.items.find((item) => item.type === 'receipt')?.actorId).toBe(ID)
    expect(sqlite.prepare('SELECT count(*) AS n FROM inventory_movements').get()?.n).toBe(3)
  })
  it('proposes without stock/ledger effects and approves with a distinct live actor', async () => {
    const proposed = await executeD1AdminInventoryCommand(
      database,
      CLAIMS,
      'count_propose',
      { variantId: '11' },
      { expectedBalanceVersion: 1, countedPhysicalQuantity: 12, reason, reference },
      { idempotencyKey: 'proposal' }
    )
    expect(proposed.physicalDelta).toBe(0)
    expect(proposed.proposedPhysicalDelta).toBe(-8)
    expect(physical()).toMatchObject({ quantity: 20, version: 1 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM inventory_movements').get()?.n).toBe(1)
    const input = { expectedBalanceVersion: 1, reason: 'Independent synthetic physical approval' }
    await expect(
      executeD1AdminInventoryCommand(
        database,
        CLAIMS,
        'count_approve',
        { variantId: '11', countId: proposed.proposalId! },
        input,
        { idempotencyKey: 'self' }
      )
    ).rejects.toMatchObject({ code: 'approval_self' })
    const approved = await executeD1AdminInventoryCommand(
      database,
      APPROVER,
      'count_approve',
      { variantId: '11', countId: proposed.proposalId! },
      input,
      { idempotencyKey: 'approval' }
    )
    expect(approved.physicalDelta).toBe(-8)
    expect(physical()).toMatchObject({ quantity: 12, version: 2 })
    expect(
      await executeD1AdminInventoryCommand(
        database,
        APPROVER,
        'count_approve',
        { variantId: '11', countId: proposed.proposalId! },
        input,
        { idempotencyKey: 'approval' }
      )
    ).toEqual(approved)
  })
  it('protects expired persisted reservations until explicit release', async () => {
    await reserveInventory(database, {
      idempotencyKey: 'reserve',
      correlationId: 'synthetic',
      now: utc(-7200000),
      expiresAt: utc(-3600000),
      lines: [{ variantId: VARIANT, locationId: 'main', quantity: 8 }]
    })
    expect((await read()).reconciliation.reservationExpiryPending).toBe(1)
    await expect(
      executeD1AdminInventoryCommand(
        database,
        CLAIMS,
        'count_propose',
        { variantId: '11' },
        { expectedBalanceVersion: 1, countedPhysicalQuantity: 8, reason, reference },
        { idempotencyKey: 'count' }
      )
    ).rejects.toMatchObject({ code: 'insufficient_stock' })
    await releaseReservation(database, { idempotencyKey: 'reserve', correlationId: 'synthetic', now: utc(), reason })
    expect((await read()).balance.reservedQuantity).toBe(0)
  })
  it('rejects stale versions and changed payload/key collisions with no effects', async () => {
    await receive()
    await expect(receive(body({ quantity: 6 }))).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(receive(body(), 'stale')).rejects.toMatchObject({ code: 'version_conflict' })
    expect(counts()).toEqual([1, 1, 0, 0, 0])
  })
  it.each([
    [
      'session',
      () => sqlite.exec(`UPDATE auth_sessions SET revoked_at='${utc()}' WHERE id='${SESSION}'`),
      'unauthenticated'
    ],
    ['permission', () => sqlite.exec(`DELETE FROM identity_roles WHERE identity_id='${ID}'`), 'forbidden'],
    ['MFA', () => sqlite.exec(`UPDATE auth_sessions SET mfa_verified=0 WHERE id='${SESSION}'`), 'mfa_required'],
    ['email', () => sqlite.exec(`UPDATE identities SET email_verified_at=NULL WHERE id='${ID}'`), 'email_unverified']
  ] as const)('rolls back late %s revocation', async (_label, change, code) => {
    await expect(receive(body(), 'late', beforeBatch(change))).rejects.toMatchObject({ code })
    expect(physical()).toMatchObject({ quantity: 20, version: 1 })
    expect(counts()).toEqual([0, 0, 0, 0, 0])
  })
  it('fails closed on ledger corruption rather than repairing it with an entry', async () => {
    sqlite.exec("UPDATE inventory_movements SET physical_delta=19 WHERE id='initial'")
    await expect(read()).rejects.toMatchObject({ code: 'reconciliation_required' })
    await expect(receive()).rejects.toMatchObject({ code: 'reconciliation_required' })
  })
  it('rolls back if audit insertion fails', async () => {
    sqlite.exec(
      "CREATE TRIGGER block_audit BEFORE INSERT ON inventory_admin_audit BEGIN SELECT RAISE(ABORT,'synthetic_audit_outage'); END"
    )
    await expect(receive()).rejects.toThrow('synthetic_audit_outage')
    expect(physical()).toMatchObject({ quantity: 20, version: 1 })
    expect(counts()).toEqual([0, 0, 0, 0, 0])
  })
  it('fails closed on reference drift inside the batch', async () => {
    await expect(
      receive(
        body(),
        'drift',
        beforeBatch(() => sqlite.exec("UPDATE inventory_locations SET active=0 WHERE id='main'"))
      )
    ).rejects.toMatchObject({ code: 'warehouse_unavailable' })
    expect(physical()).toMatchObject({ quantity: 20, version: 1 })
    expect(counts()).toEqual([0, 0, 0, 0, 0])
  })
  it('does not hide reservation interleaving between prepare and atomic claim', async () => {
    const db = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            await reserveInventory(database, {
              idempotencyKey: 'interleaved',
              correlationId: 'synthetic',
              now: utc(),
              expiresAt: utc(600000),
              lines: [{ variantId: VARIANT, locationId: 'main', quantity: 2 }]
            })
            return target.batch(statements)
          }
        const value: unknown = Reflect.get(target, key, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await expect(receive(body(), 'reserve-race', db)).rejects.toMatchObject({ code: 'conflict' })
    expect(physical()).toMatchObject({ quantity: 20, version: 1 })
    expect(counts()).toEqual([0, 0, 0, 0, 0])
  })
  it('does not hide allocation interleaving', async () => {
    await reserveInventory(database, {
      idempotencyKey: 'assigned',
      correlationId: 'synthetic',
      now: utc(),
      expiresAt: utc(600000),
      lines: [{ variantId: VARIANT, locationId: 'main', quantity: 2 }]
    })
    const db = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            await assignReservation(database, { idempotencyKey: 'assigned', correlationId: 'synthetic', now: utc() })
            return target.batch(statements)
          }
        const value: unknown = Reflect.get(target, key, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await expect(receive(body(), 'allocate-race', db)).rejects.toMatchObject({ code: 'version_conflict' })
    expect(physical()).toMatchObject({ quantity: 18, version: 2 })
  })
  it.each([0, -1, 1.2, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '2', null, undefined])(
    'rejects invalid quantity %s',
    async (quantity) => {
      await expect(receive(body({ quantity }))).rejects.toBeInstanceOf(InventoryCommandError)
      expect(counts()).toEqual([0, 0, 0, 0, 0])
    }
  )
  it.each(['expectedBalanceVersion', 'quantity', 'reason', 'reference'])(
    'requires own %s without executing getters',
    async (field) => {
      let invoked = 0
      const input = body()
      Object.defineProperty(input, field, {
        get() {
          invoked++
          return 1
        },
        enumerable: true
      })
      expect(inventoryReceiptInputSchema.safeParse(input).success).toBe(false)
      await expect(receive(input)).rejects.toMatchObject({ code: 'invalid_input' })
      expect(invoked).toBe(0)
    }
  )
  it.each(['\n', '\t', '\r', '\u0000', '\u007f'])('rejects raw controls before trim %s', async (control) => {
    await expect(receive(body({ reason: control + reason }))).rejects.toMatchObject({ code: 'invalid_input' })
    expect(
      inventoryCountProposalInputSchema.safeParse({
        expectedBalanceVersion: 1,
        countedPhysicalQuantity: 0,
        reason,
        reference: reference + control
      }).success
    ).toBe(false)
  })
  it('denies replay with current authority revoked', async () => {
    await receive()
    sqlite.exec(`DELETE FROM identity_roles WHERE identity_id='${ID}'`)
    await expect(receive()).rejects.toMatchObject({ code: 'forbidden' })
  })
  it.each([
    'actorId',
    'locationId',
    'warehouseId',
    'movementId',
    'price',
    'safetyStock',
    'blockedQuantity',
    'reservedQuantity',
    'now',
    'initialGrossCents',
    'countId'
  ])('rejects unknown field %s without effects', async (field) => {
    await expect(receive(body({ [field]: 1 }))).rejects.toMatchObject({ code: 'invalid_input' })
    expect(counts()).toEqual([0, 0, 0, 0, 0])
  })
  it.each(['01', '0', '11\n', '11.0', '+11', ' 11', '9007199254740992'])(
    'rejects noncanonical legacy ID %s',
    async (id) => {
      await expect(
        executeD1AdminInventoryCommand(database, CLAIMS, 'receipt', { variantId: id }, body(), {
          idempotencyKey: 'bad-id'
        })
      ).rejects.toMatchObject({ code: 'invalid_input' })
    }
  )
  it('never mutates the caller input or identity/catalog/price/security/reservation source', async () => {
    const input = body(),
      before = JSON.stringify(input),
      variant = sqlite.prepare('SELECT * FROM variants').get(),
      product = sqlite.prepare('SELECT * FROM products').get()
    await receive(input)
    expect(JSON.stringify(input)).toBe(before)
    expect(sqlite.prepare('SELECT * FROM variants').get()).toEqual(variant)
    expect(sqlite.prepare('SELECT * FROM products').get()).toEqual(product)
    expect(sqlite.prepare('SELECT blocked_quantity FROM inventory_balances').get()?.blocked_quantity).toBe(1)
    expect(sqlite.prepare('SELECT count(*) AS n FROM inventory_reservations').get()?.n).toBe(0)
  })
  it('allows zero-stock drafts to receive without inventing a warehouse or zero initial movement', async () => {
    sqlite.exec(
      "DELETE FROM inventory_movements WHERE id='initial'; UPDATE inventory_balances SET physical_quantity=0,blocked_quantity=0"
    )
    expect((await read()).balance.physicalQuantity).toBe(0)
    await receive()
    expect(physical()).toMatchObject({ quantity: 5, version: 2 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM inventory_movements').get()?.n).toBe(1)
    expect(sqlite.prepare('SELECT movement_type FROM inventory_movements').get()?.movement_type).toBe('receipt')
    expect(sqlite.prepare('SELECT count(*) AS n FROM inventory_locations').get()?.n).toBe(1)
    expect(sqlite.prepare('SELECT count(*) AS n FROM variant_price_versions').get()?.n).toBe(0)
  })
  it('refuses overflow and version exhaustion before any command', async () => {
    sqlite.prepare("UPDATE inventory_movements SET physical_delta=? WHERE id='initial'").run(Number.MAX_SAFE_INTEGER)
    sqlite.prepare('UPDATE inventory_balances SET physical_quantity=?').run(Number.MAX_SAFE_INTEGER)
    await expect(receive(body({ quantity: 1 }))).rejects.toMatchObject({ code: 'invalid_input' })
    sqlite.prepare('UPDATE inventory_balances SET version=?').run(Number.MAX_SAFE_INTEGER)
    await expect(receive(body({ expectedBalanceVersion: Number.MAX_SAFE_INTEGER - 1 }))).rejects.toMatchObject({
      code: 'version_conflict'
    })
    expect(counts()).toEqual([0, 0, 0, 0, 0])
  })
  it('does not treat the safety buffer as fictitious physical stock', async () => {
    const proposal = await executeD1AdminInventoryCommand(
      database,
      CLAIMS,
      'count_propose',
      { variantId: '11' },
      { expectedBalanceVersion: 1, countedPhysicalQuantity: 1, reason, reference },
      { idempotencyKey: 'floor' }
    )
    await executeD1AdminInventoryCommand(
      database,
      APPROVER,
      'count_approve',
      { variantId: '11', countId: proposal.proposalId! },
      { expectedBalanceVersion: 1, reason },
      { idempotencyKey: 'floor-approval' }
    )
    expect((await read()).balance).toMatchObject({ physicalQuantity: 1, safetyStock: 2, sellableQuantity: 0 })
  })
  it('blocks same count after reservations change without a balance version bump', async () => {
    const proposal = await executeD1AdminInventoryCommand(
      database,
      CLAIMS,
      'count_propose',
      { variantId: '11' },
      { expectedBalanceVersion: 1, countedPhysicalQuantity: 15, reason, reference },
      { idempotencyKey: 'count' }
    )
    await reserveInventory(database, {
      idempotencyKey: 'after-count',
      correlationId: 'synthetic',
      now: utc(),
      expiresAt: utc(600000),
      lines: [{ variantId: VARIANT, locationId: 'main', quantity: 1 }]
    })
    await expect(
      executeD1AdminInventoryCommand(
        database,
        APPROVER,
        'count_approve',
        { variantId: '11', countId: proposal.proposalId! },
        { expectedBalanceVersion: 1, reason },
        { idempotencyKey: 'approval' }
      )
    ).rejects.toMatchObject({ code: 'version_conflict' })
    expect((await read(APPROVER)).counts.items[0]).toMatchObject({ stale: true, canApprove: false })
    expect(physical()).toMatchObject({ quantity: 20, version: 1 })
  })
  it('fails closed for a second persisted location even if inactive', async () => {
    sqlite.exec(
      "INSERT INTO inventory_locations VALUES('second','SECOND','Second synthetic warehouse','warehouse',0,'2020-01-01T00:00:00Z')"
    )
    sqlite
      .prepare("INSERT INTO inventory_balances VALUES(?,'second',0,0,1,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')")
      .run(VARIANT)
    await expect(receive()).rejects.toMatchObject({ code: 'warehouse_unavailable' })
    await expect(read()).rejects.toMatchObject({ code: 'warehouse_unavailable' })
  })
  it('one winner for concurrent commands, and exact replay for concurrent identical intent', async () => {
    const same = await Promise.all([receive(), receive()])
    expect(same[0]).toEqual(same[1])
    expect(physical()).toMatchObject({ quantity: 25, version: 2 })
    const raced = await Promise.allSettled([
      receive(body({ expectedBalanceVersion: 2 }), 'race-a'),
      receive(body({ expectedBalanceVersion: 2 }), 'race-b')
    ])
    expect(raced.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1)
    expect(physical()).toMatchObject({ quantity: 30, version: 3 })
    expect(counts()).toEqual([2, 2, 0, 0, 0])
  })
  it('keeps idempotency actor-scoped without turning another actor key into a replay', async () => {
    const first = await receive()
    await expect(receive(body(), 'receipt', database, APPROVER)).rejects.toMatchObject({ code: 'version_conflict' })
    const other = await receive(body({ expectedBalanceVersion: 2 }), 'receipt', database, APPROVER)
    expect(other.commandId).not.toBe(first.commandId)
    expect(physical()).toMatchObject({ quantity: 30, version: 3 })
  })
  it('guards revocation after the claim and rolls back triggered effects', async () => {
    sqlite.exec(
      `CREATE TRIGGER revoke_inside AFTER INSERT ON inventory_admin_commands BEGIN DELETE FROM identity_roles WHERE identity_id='${ID}'; END`
    )
    await expect(receive()).rejects.toMatchObject({ code: 'conflict' })
    expect(counts()).toEqual([0, 0, 0, 0, 0])
    expect(physical()).toMatchObject({ quantity: 20, version: 1 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM identity_roles WHERE identity_id=?').get(ID)?.n).toBe(1)
  })
  it('guards a source mutation after owned balance CAS', async () => {
    sqlite.exec(
      `CREATE TRIGGER drift_inside AFTER UPDATE OF physical_quantity ON inventory_balances BEGIN UPDATE variants SET safety_stock=safety_stock+1 WHERE id='${VARIANT}'; END`
    )
    await expect(receive()).rejects.toMatchObject({ code: 'conflict' })
    expect(physical()).toMatchObject({ quantity: 20, version: 1 })
    expect(counts()).toEqual([0, 0, 0, 0, 0])
    expect(sqlite.prepare('SELECT safety_stock FROM variants').get()?.safety_stock).toBe(2)
  })
  it('does not complete when the audit write was omitted', async () => {
    sqlite.exec('CREATE TRIGGER omit_audit BEFORE INSERT ON inventory_admin_audit BEGIN SELECT RAISE(IGNORE); END')
    await expect(receive()).rejects.toMatchObject({ code: 'conflict' })
    expect(counts()).toEqual([0, 0, 0, 0, 0])
    expect(physical()).toMatchObject({ quantity: 20, version: 1 })
  })
  it.each(['inventory_admin_commands', 'inventory_admin_audit'])(
    'prevents UPDATE/DELETE and REPLACE business duplicates in %s',
    async (table) => {
      await receive()
      expect(() => sqlite.exec(`UPDATE ${table} SET reason='Changed synthetic reason'`)).toThrow('immutable')
      expect(() => sqlite.exec(`DELETE FROM ${table}`)).toThrow('immutable')
      const columns = sqlite
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name)
        .join(',')
      expect(() => sqlite.exec(`INSERT OR REPLACE INTO ${table}(${columns}) SELECT ${columns} FROM ${table}`)).toThrow(
        'immutable'
      )
    }
  )
  it('protects new manual movements but preserves old reservation ON CONFLICT replay behavior', async () => {
    await receive()
    const movement = sqlite.prepare("SELECT id FROM inventory_movements WHERE movement_type='receipt'").get()?.id
    if (typeof movement !== 'string') throw new Error('invalid_fixture_movement')
    expect(() =>
      sqlite.prepare('UPDATE inventory_movements SET reason=? WHERE id=?').run('Tampered synthetic reason', movement)
    ).toThrow('immutable')
    expect(() => sqlite.prepare('DELETE FROM inventory_movements WHERE id=?').run(movement)).toThrow('immutable')
    const columns = sqlite
      .prepare('PRAGMA table_info(inventory_movements)')
      .all()
      .map((row) => row.name)
      .join(',')
    expect(() =>
      sqlite.exec(
        `INSERT OR REPLACE INTO inventory_movements(${columns}) SELECT ${columns} FROM inventory_movements WHERE movement_type='receipt'`
      )
    ).toThrow('immutable')
    await reserveInventory(database, {
      idempotencyKey: 'old-reservation',
      correlationId: 'synthetic',
      now: utc(),
      expiresAt: utc(600000),
      lines: [{ variantId: VARIANT, locationId: 'main', quantity: 2 }]
    })
    expect(() =>
      sqlite.exec(
        `INSERT INTO inventory_movements(${columns}) SELECT ${columns} FROM inventory_movements WHERE movement_type='reserve' ON CONFLICT DO NOTHING`
      )
    ).not.toThrow()
  })
  it.each(['false', 'missing', 'inherited', 'getter', 'results_missing', 'results_inherited', 'results_getter'])(
    'refuses incomplete provider source boundary %s',
    async (mode) => {
      let called = 0
      const db = new Proxy(database, {
        get(target, key, receiver) {
          if (key === 'prepare')
            return (sql: string) => {
              const stmt = target.prepare(sql)
              if (!sql.includes('SELECT * FROM state')) return stmt
              const proxy: D1PreparedStatement = new Proxy(stmt, {
                get(s, k, r) {
                  if (k === 'bind')
                    return (...params: unknown[]) => {
                      s.bind(...params)
                      return proxy
                    }
                  if (k === 'all')
                    return async () => {
                      const original = await s.all()
                      const result: Record<string, unknown> = { success: true, results: original.results }
                      if (mode === 'false') result.success = false
                      if (mode === 'missing') delete result.success
                      if (mode === 'inherited') {
                        delete result.success
                        Object.setPrototypeOf(result, { success: true })
                      }
                      if (mode === 'getter')
                        Object.defineProperty(result, 'success', {
                          get() {
                            called++
                            return true
                          }
                        })
                      if (mode === 'results_missing') delete result.results
                      if (mode === 'results_inherited') {
                        delete result.results
                        Object.setPrototypeOf(result, { results: original.results })
                      }
                      if (mode === 'results_getter')
                        Object.defineProperty(result, 'results', {
                          get() {
                            called++
                            return original.results
                          }
                        })
                      return result
                    }
                  return Reflect.get(s, k, r)
                }
              })
              return proxy
            }
          return Reflect.get(target, key, receiver)
        }
      })
      await expect(read(CLAIMS, db)).rejects.toThrow('inventory_provider_result_invalid')
      expect(called).toBe(0)
    }
  )
  it('does not treat missing/sparse batch flags as success', async () => {
    const db = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements)
            delete results[0]
            return results
          }
        return Reflect.get(target, key, receiver)
      }
    })
    await expect(read(CLAIMS, db)).rejects.toThrow('inventory_provider_result_invalid')
  })
  it('propagates provider outage that happens to contain a command table name', async () => {
    const db = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'batch')
          return async () => {
            throw new Error('inventory_admin_commands provider unavailable')
          }
        return Reflect.get(target, key, receiver)
      }
    })
    await expect(receive(body(), 'outage', db)).rejects.toThrow('provider unavailable')
    expect(counts()).toEqual([0, 0, 0, 0, 0])
  })
  it('rechecks late read authority, including fractional-second live expiry', async () => {
    const base = Date.now(),
      next = Math.floor(base / 1000) * 1000 + 900
    vi.useFakeTimers()
    vi.setSystemTime(next)
    sqlite
      .prepare('UPDATE auth_sessions SET expires_at=? WHERE id=?')
      .run(new Date(next + 100).toISOString().replace(/\.\d{3}Z$/, 'Z'), SESSION)
    const db = beforeBatch(() => vi.setSystemTime(next + 200))
    try {
      await expect(read(CLAIMS, db)).rejects.toMatchObject({ code: 'unauthenticated' })
    } finally {
      vi.useRealTimers()
    }
  })
  it('offers bounded literal SKU/name lookup with no pricing or catalog authorization', async () => {
    sqlite.exec("DELETE FROM role_permissions WHERE permission_code='inventory.write'")
    const first = await readD1AdminInventoryVariants(database, CLAIMS, { q: 'synthetic', page: 1, perPage: 1 })
    expect(first.items).toEqual([
      { id: 11, uuid: VARIANT, sku: 'SYNTHETIC-SKU', name: 'Synthetic draft', unitBase: 'ud', unitLabel: 'unidad' }
    ])
    expect(first.pagination).toEqual({ page: 1, perPage: 1, total: 1, pages: 1 })
    expect(JSON.stringify(first)).not.toContain('price')
    const absent = await readD1AdminInventoryVariants(database, CLAIMS, { q: '%_', page: 1, perPage: 25 })
    expect(absent.items).toEqual([])
    expect(absent.pagination.total).toBe(0)
    const beyond = await readD1AdminInventoryVariants(database, CLAIMS, { q: 'synthetic', page: 2, perPage: 1 })
    expect(beyond.items).toEqual([])
    expect(beyond.pagination.total).toBe(1)
  })
  it.each([
    { q: 'x', page: 1, perPage: 25 },
    { q: 'valid\n', page: 1, perPage: 25 },
    { q: 'a'.repeat(101), page: 1, perPage: 25 },
    { q: 'valid', page: 1, perPage: 26 },
    { q: 'valid', page: 0, perPage: 25 },
    { q: 'valid', page: 1, perPage: 25, now: utc() }
  ])('rejects invalid bounded literal query %j', async (input) => {
    await expect(readD1AdminInventoryVariants(database, CLAIMS, input)).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it('re-authorizes after awaited search so revocation cannot return private rows', async () => {
    const db = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql)
            if (!sql.includes('candidates AS MATERIALIZED')) return statement
            const proxy: D1PreparedStatement = new Proxy(statement, {
              get(s, k, r) {
                if (k === 'bind')
                  return (...parameters: unknown[]) => {
                    s.bind(...parameters)
                    return proxy
                  }
                if (k === 'all')
                  return async () => {
                    const rows = await s.all()
                    sqlite.exec(`DELETE FROM identity_roles WHERE identity_id='${ID}'`)
                    return rows
                  }
                return Reflect.get(s, k, r)
              }
            })
            return proxy
          }
        return Reflect.get(target, key, receiver)
      }
    })
    await expect(
      readD1AdminInventoryVariants(db, CLAIMS, { q: 'synthetic', page: 1, perPage: 25 })
    ).rejects.toMatchObject({ code: 'forbidden' })
  })
  it('does not mistake a foreign partial claim nonce for completion', async () => {
    const prepared = new WeakMap<D1PreparedStatement, { sql: string; parameters: unknown[] }>()
    const db = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql),
              info = { sql, parameters: [] as unknown[] }
            const proxy: D1PreparedStatement = new Proxy(statement, {
              get(s, k, r) {
                if (k === 'bind')
                  return (...parameters: unknown[]) => {
                    info.parameters = parameters
                    s.bind(...parameters)
                    return proxy
                  }
                return Reflect.get(s, k, r)
              }
            })
            prepared.set(proxy, info)
            return proxy
          }
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            const first = prepared.get(statements[0]!)!
            const parameters = first.parameters.map((value, index) => {
              if (index === 12) return crypto.randomUUID()
              if (value === null || typeof value === 'number' || typeof value === 'string') return value
              throw new Error('invalid_fixture_parameter')
            })
            sqlite.prepare(first.sql).run(...parameters)
            return target.batch(statements)
          }
        return Reflect.get(target, key, receiver)
      }
    })
    await expect(receive(body(), 'stolen', db)).rejects.toMatchObject({ code: 'conflict' })
    expect(physical()).toMatchObject({ quantity: 20, version: 1 })
    expect(counts()).toEqual([1, 0, 0, 0, 0])
  })
  it('pages ledger to 50 with confirmed total, not an unbounded history response', async () => {
    const insert =
      sqlite.prepare(`INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,reference_type,reference_id,idempotency_key,correlation_id,created_at)
      VALUES(?,?,'main','receipt',1,0,'synthetic',NULL,?,'synthetic','2020-01-01T00:00:00Z')`)
    for (let i = 0; i < 60; i++) insert.run(`fixture-${i}`, VARIANT, `fixture-${i}`)
    sqlite.exec('UPDATE inventory_balances SET physical_quantity=80')
    const first = await read()
    expect(first.ledger.items).toHaveLength(50)
    expect(first.ledger.pagination).toEqual({ page: 1, perPage: 50, total: 61, pages: 2 })
    expect(
      (await readD1AdminInventoryVariant(database, CLAIMS, '11', { page: 2, perPage: 50 })).ledger.items
    ).toHaveLength(11)
  })
  it('bounds proposal history explicitly with hasMore', async () => {
    await executeD1AdminInventoryCommand(
      database,
      CLAIMS,
      'count_propose',
      { variantId: '11' },
      { expectedBalanceVersion: 1, countedPhysicalQuantity: 15, reason, reference },
      { idempotencyKey: 'original-count' }
    )
    const command = sqlite.prepare('SELECT * FROM inventory_admin_commands').get()!,
      proposal = sqlite.prepare('SELECT * FROM inventory_count_proposals').get()!,
      audit = sqlite.prepare('SELECT * FROM inventory_admin_audit').get()!
    function append(table: string, row: Record<string, unknown>) {
      const keys = Object.keys(row),
        values = keys.map((key) => {
          const value = row[key]
          if (value === null || typeof value === 'string' || typeof value === 'number') return value
          throw new Error('invalid_fixture_parameter')
        })
      sqlite.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...values)
    }
    for (let i = 0; i < 50; i++) {
      const id = crypto.randomUUID(),
        proposalId = crypto.randomUUID(),
        response = JSON.stringify({ ...JSON.parse(String(command.response)), commandId: id, proposalId })
      append('inventory_admin_commands', {
        ...command,
        id,
        claim_nonce: crypto.randomUUID(),
        idempotency_key: `fixture-count-${i}`,
        proposal_id: proposalId,
        response
      })
      append('inventory_count_proposals', { ...proposal, id: proposalId, command_id: id })
      append('inventory_admin_audit', {
        ...audit,
        id: crypto.randomUUID(),
        command_id: id,
        proposal_id: proposalId,
        response
      })
    }
    const result = await read(APPROVER)
    expect(result.counts.items).toHaveLength(50)
    expect(result.counts.hasMore).toBe(true)
    expect(result.balance.version).toBe(1)
  })
})
