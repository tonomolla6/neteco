import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  assignReservation,
  expireExpiredReservations,
  listAvailability,
  reconcileInventory,
  releaseReservation,
  renewReservation,
  reserveInventory,
  type ReservationLineInput
} from '../workers/catalog/inventory'
import { INVENTORY_SEED_LOCATION_ID, renderD1InventorySeed, seededInventoryQuantity } from './lib/d1-inventory-seed'
import { renderD1CategorySeed, stableUuid } from './lib/d1-category-seed'
import { renderD1ProductSeed } from './lib/d1-product-seed'

const execute = promisify(execFile)
const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx'

/**
 * Isolated inventory audit: everything below runs against an EPHEMERAL local D1
 * (own persistence directory). The directory is deleted in a finally block, so
 * the shared canary state can never be contaminated, even on failure.
 */
const persistenceDirectory = await mkdtemp(join(tmpdir(), 'neteco-d1-inventory-audit-'))

try {
  const localArguments = ['--config', 'wrangler.canary.jsonc', '--local', '--persist-to', persistenceDirectory]

  async function wrangler(arguments_: string[]) {
    await execute(executable, ['wrangler', ...arguments_], { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 })
  }

  // 1. Clean migration from an empty database inside the ephemeral directory.
  await wrangler(['d1', 'migrations', 'apply', 'DB', ...localArguments])
  const categorySeedFile = join(persistenceDirectory, 'category-seed.sql')
  const productSeedFile = join(persistenceDirectory, 'product-seed.sql')
  const inventorySeedFile = join(persistenceDirectory, 'inventory-seed.sql')
  await writeFile(categorySeedFile, renderD1CategorySeed(), 'utf8')
  await writeFile(productSeedFile, renderD1ProductSeed(), 'utf8')
  await writeFile(inventorySeedFile, renderD1InventorySeed(), 'utf8')
  await wrangler(['d1', 'execute', 'DB', ...localArguments, '--yes', '--file', categorySeedFile])
  await wrangler(['d1', 'execute', 'DB', ...localArguments, '--yes', '--file', productSeedFile])
  await wrangler(['d1', 'execute', 'DB', ...localArguments, '--yes', '--file', inventorySeedFile])

  function sqlLiteral(value: unknown): string {
    if (value === null || value === undefined) return 'NULL'
    if (typeof value === 'number') return String(value)
    if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`
    throw new Error(`Unsupported literal for isolated audit: ${typeof value}`)
  }

  interface AuditStatement {
    sql: string
    parameters: unknown[]
    first<T>(...parameters: unknown[]): Promise<T | null>
    all<T>(...parameters: unknown[]): Promise<{ results: T[] }>
  }

  async function rawQuery(command: string) {
    const output = await execute(
      executable,
      ['wrangler', 'd1', 'execute', 'DB', ...localArguments, '--yes', '--json', '--command', command],
      { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 }
    ).catch(async (error: unknown) => {
      // Leave no open transaction behind after a failed guarded batch.
      await execute(
        executable,
        ['wrangler', 'd1', 'execute', 'DB', ...localArguments, '--yes', '--command', 'ROLLBACK;'],
        { cwd: process.cwd() }
      ).catch(() => undefined)
      throw error
    })
    return JSON.parse(output.stdout) as Array<{ results: Array<Record<string, unknown>>; success: boolean }>
  }

  function inlineParameters(sql: string, parameters: unknown[]) {
    let autoPosition = 0
    return sql.replaceAll(/\?(\d*)/g, (_match, digits: string) => {
      const index = digits ? Number(digits) : ++autoPosition
      return sqlLiteral(parameters[index - 1])
    })
  }

  function makeStatement(sql: string): AuditStatement {
    const statement = {
      sql,
      parameters: [] as unknown[],
      bind(...parameters: unknown[]) {
        this.parameters = parameters
        return this
      },
      async all<T>(...parameters: unknown[]) {
        if (parameters.length) this.parameters = [...parameters]
        const parsed = await rawQuery(inlineParameters(sql, this.parameters))
        if (!parsed.every((entry) => entry.success)) throw new Error('Isolated audit statement failed')
        return { results: parsed.flatMap((entry) => entry.results) as T[] }
      },
      async first<T>(...parameters: unknown[]) {
        if (parameters.length) this.parameters = [...parameters]
        const { results } = await this.all<T>()
        return results[0] ?? null
      },
      async run(...parameters: unknown[]) {
        if (parameters.length) this.parameters = [...parameters]
        await rawQuery(inlineParameters(sql, this.parameters))
        return { success: true }
      }
    }
    return statement as AuditStatement
  }

  /** Executes the batch as ONE explicit transaction against the ephemeral D1. */
  function d1OverWrangler() {
    return {
      prepare: makeStatement,
      batch: async (statements: AuditStatement[]) => {
        // A single multi-statement command runs as ONE implicit D1 transaction:
        // any failing statement rolls back every previous one (verified in the
        // failure scenario below). Explicit BEGIN/COMMIT are rejected by D1.
        const command = statements
          .map((statement) => `${inlineParameters(statement.sql, statement.parameters)};`)
          .join('\n')
        const parsed = await rawQuery(command)
        if (parsed.length < statements.length || parsed.some((entry) => !entry.success))
          throw new Error('Isolated audit batch incomplete')
        return statements.map((_statement, index) => ({ results: parsed[index]?.results ?? [], success: true }))
      }
    } as unknown as D1Database
  }

  const database = d1OverWrangler()
  const failures: string[] = []
  function check(condition: boolean, scenario: string, detail = '') {
    if (!condition) failures.push(`${scenario}${detail ? `: ${detail}` : ''}`)
  }

  const variantId = (productIndex: number, variantIndex: number) =>
    stableUuid(`variant:${productIndex}:${variantIndex}`)
  const NOW = '2026-08-25T09:00:00Z'
  const locationId = INVENTORY_SEED_LOCATION_ID

  // 2. Seeded shape: one location, 50 balances, 50 initial movements, no orphans.
  const counts = await makeStatement(
    `SELECT (SELECT count(*) FROM inventory_locations) AS locations,
            (SELECT count(*) FROM inventory_balances) AS balances,
            (SELECT count(*) FROM inventory_movements) AS movements,
            (SELECT count(*) FROM inventory_movements WHERE movement_type = 'initial') AS initialMovements`
  ).first<{ locations: number; balances: number; movements: number; initialMovements: number }>()
  check(counts?.locations === 1, 'seed: una ubicación')
  check(counts?.balances === 50, 'seed: 50 balances', String(counts?.balances))
  check(counts?.initialMovements === 50 && counts.movements === 50, 'seed: 50 movimientos iniciales')

  const expectedFirst = seededInventoryQuantity(1, 1)
  const firstAvailability = await listAvailability(database, { variantId: variantId(1, 1) })
  check(
    firstAvailability[0]?.sellableQuantity === expectedFirst - ((1 + 1) % 4),
    'seed: sellable respeta safety',
    JSON.stringify(firstAvailability[0])
  )

  // 3. Seed idempotency with a stable digest over balances + movements.
  const snapshotSql = `
    SELECT variant_id, location_id, physical_quantity, blocked_quantity, version
    FROM inventory_balances ORDER BY variant_id;
    SELECT id, variant_id, location_id, movement_type, physical_delta, reserved_delta, reference_type, reason
    FROM inventory_movements ORDER BY id;`
  const digestRows = async () =>
    (await rawQuery(snapshotSql))
      .flatMap((entry) => entry.results)
      .map((row) => JSON.stringify(row))
      .join('|')
  const digestBeforeReseed = createHash('sha256')
    .update(await digestRows())
    .digest('hex')
  await writeFile(inventorySeedFile, renderD1InventorySeed(), 'utf8')
  await wrangler(['d1', 'execute', 'DB', ...localArguments, '--yes', '--file', inventorySeedFile])
  const digestAfterReseed = createHash('sha256')
    .update(await digestRows())
    .digest('hex')
  check(digestBeforeReseed === digestAfterReseed, 'seed: reejecución idempotente')

  let sequence = 0
  const nextKey = (prefix: string) => `${prefix}-${++sequence}`

  const reserveLines = (pairs: Array<[number, number]>, quantity = 1): ReservationLineInput[] =>
    pairs.map(([product, variant]) => ({ locationId, quantity, variantId: variantId(product, variant) }))
  const activeReserved = async (product: number, variant: number) => {
    const row = await makeStatement(
      `SELECT COALESCE(SUM(l.quantity), 0) AS qty
       FROM inventory_reservation_lines l
       JOIN inventory_reservations r ON r.id = l.reservation_id
       WHERE r.status = 'reserved' AND l.variant_id = ?1 AND l.location_id = ?2`
    ).first<{ qty: number }>(variantId(product, variant), locationId)
    return Number(row?.qty ?? 0)
  }
  const movementCount = async () => {
    const row = await makeStatement('SELECT count(*) AS total FROM inventory_movements').first<{ total: number }>()
    return Number(row?.total ?? 0)
  }

  // 4. Simple reserve + availability drop.
  const simpleKey = nextKey('audit-simple')
  const simple = await reserveInventory(database, {
    correlationId: 'audit',
    expiresAt: '2026-08-26T09:00:00Z',
    idempotencyKey: simpleKey,
    lines: reserveLines([[1, 1]], 5),
    now: NOW
  })
  check(simple.outcome === 'reserved', 'reserva simple', JSON.stringify(simple))
  check((await activeReserved(1, 1)) === 5, 'reserva simple: activa registrada')

  // 5. Replay identical payload -> persisted state, zero new movements.
  const movementsBeforeReplay = await movementCount()
  const replay = await reserveInventory(database, {
    correlationId: 'audit',
    expiresAt: '2026-08-26T09:00:00Z',
    idempotencyKey: simpleKey,
    lines: reserveLines([[1, 1]], 5),
    now: NOW
  })
  check(replay.outcome === 'replayed', 'replay devuelve estado persistido')
  check((await movementCount()) === movementsBeforeReplay, 'replay sin movimientos nuevos')

  // 6. Same key, different payload -> rejected conflict.
  const conflict = await reserveInventory(database, {
    correlationId: 'audit',
    expiresAt: '2026-08-26T09:00:00Z',
    idempotencyKey: simpleKey,
    lines: reserveLines([[1, 1]], 9),
    now: NOW
  })
  check(conflict.outcome === 'conflict', 'misma clave con payload distinto se rechaza')

  // 7. Multi-line reserve is atomic end-to-end.
  const multiKey = nextKey('audit-multi')
  const multi = await reserveInventory(database, {
    correlationId: 'audit',
    expiresAt: '2026-08-26T09:00:00Z',
    idempotencyKey: multiKey,
    lines: reserveLines([
      [2, 1],
      [3, 1]
    ]),
    now: NOW
  })
  check(multi.outcome === 'reserved', 'reserva multilínea')
  check((await activeReserved(2, 1)) === 1 && (await activeReserved(3, 1)) === 1, 'multilínea: ambas líneas activas')

  // 8. Multi-line atomicity under failure: line 1 fits, line 2 cannot.
  const movementsBeforePartial = await movementCount()
  const partialKey = nextKey('audit-partial')
  const partial = await reserveInventory(database, {
    correlationId: 'audit',
    expiresAt: '2026-08-26T09:00:00Z',
    idempotencyKey: partialKey,
    lines: [...reserveLines([[6, 1]], 1), ...reserveLines([[7, 1]], 10_000)],
    now: NOW
  }).catch((error: unknown) => error)
  check(partial instanceof Error, 'línea imposible rechaza la reserva completa')
  check((await movementCount()) === movementsBeforePartial, 'fallo multilínea sin efectos parciales')
  const orphanHeader = await makeStatement(
    'SELECT count(*) AS total FROM inventory_reservations WHERE idempotency_key = ?1'
  ).first<{ total: number }>(partialKey)
  check(Number(orphanHeader?.total ?? 0) === 0, 'sin cabecera residual tras fallo multilínea')
  check((await activeReserved(6, 1)) === 0, 'primera línea tampoco queda reservada')

  // 9. Assignment decrements physical once; replay does not double-decrement.
  const balanceBeforeAssign = (
    await makeStatement(
      'SELECT physical_quantity AS qty FROM inventory_balances WHERE variant_id = ?1 AND location_id = ?2'
    ).first<{
      qty: number
    }>(variantId(1, 1), locationId)
  )?.qty
  const assigned = await assignReservation(database, { correlationId: 'audit', idempotencyKey: simpleKey, now: NOW })
  check(assigned.outcome === 'assigned', 'asignación')
  const balanceAfterAssign = (
    await makeStatement(
      'SELECT physical_quantity AS qty FROM inventory_balances WHERE variant_id = ?1 AND location_id = ?2'
    ).first<{
      qty: number
    }>(variantId(1, 1), locationId)
  )?.qty
  check(balanceAfterAssign === (balanceBeforeAssign ?? 0) - 5, 'asignación descuenta físico una vez')
  const replayedAssign = await assignReservation(database, {
    correlationId: 'audit',
    idempotencyKey: simpleKey,
    now: NOW
  })
  check(replayedAssign.outcome === 'replayed', 'asignación repetida es replay')
  const balanceAfterReplay = (
    await makeStatement(
      'SELECT physical_quantity AS qty FROM inventory_balances WHERE variant_id = ?1 AND location_id = ?2'
    ).first<{
      qty: number
    }>(variantId(1, 1), locationId)
  )?.qty
  check(balanceAfterReplay === balanceAfterAssign, 'asignación repetida no vuelve a descontar')

  // 10. Release frees the commitment exactly once.
  const released = await releaseReservation(database, { correlationId: 'audit', idempotencyKey: multiKey, now: NOW })
  check(released.outcome === 'applied', 'liberación')
  const repeatedRelease = await releaseReservation(database, {
    correlationId: 'audit',
    idempotencyKey: multiKey,
    now: NOW
  })
  check(repeatedRelease.outcome === 'replayed', 'liberación doble no devuelve stock dos veces')
  check((await activeReserved(2, 1)) === 0, 'liberación libera compromiso')

  // 11. Expiry + stale caller protection around renewal.
  const ttlKey = nextKey('audit-ttl')
  await reserveInventory(database, {
    correlationId: 'audit',
    expiresAt: '2026-08-25T10:00:00Z',
    idempotencyKey: ttlKey,
    lines: reserveLines([[8, 1]], 2),
    now: NOW
  })
  const renewed = await renewReservation(database, {
    correlationId: 'audit',
    expiresAt: '2026-08-25T12:00:00Z',
    idempotencyKey: ttlKey,
    now: NOW
  })
  check(renewed.outcome === 'applied', 'renovación amplía vigencia')
  const staleExpiry = await expireExpiredReservations(database, {
    at: '2026-08-25T11:00:00Z',
    correlationId: 'audit-stale'
  })
  check(staleExpiry.expiredCount === 0, 'expiración obsoleta ignorada tras renovación')
  check((await activeReserved(8, 1)) === 2, 'reserva renovada sigue viva')
  const dueExpiry = await expireExpiredReservations(database, {
    at: '2026-08-25T12:00:00Z',
    correlationId: 'audit-due'
  })
  check(dueExpiry.expiredCount >= 1, 'expiración vencida aplicada')
  const repeatExpiry = await expireExpiredReservations(database, {
    at: '2026-08-25T12:00:00Z',
    correlationId: 'audit-due'
  })
  check(repeatExpiry.expiredCount === 0, 'expiración repetida no vuelve a expirar')
  const expiredAssign = await assignReservation(database, {
    correlationId: 'audit',
    idempotencyKey: ttlKey,
    now: '2026-08-25T13:00:00Z'
  }).catch((error: unknown) => error)
  check(
    expiredAssign instanceof Error || (expiredAssign as { outcome?: string }).outcome !== 'assigned',
    'reserva expirada no puede asignarse'
  )
  const expiredRenew = await renewReservation(database, {
    correlationId: 'audit',
    expiresAt: '2026-08-25T15:00:00Z',
    idempotencyKey: ttlKey,
    now: '2026-08-25T13:00:00Z'
  })
  check(expiredRenew.outcome === 'not_active', 'reserva expirada no puede resucitarse')

  // 12. Backorder policy: allowed variant accepts reservations beyond stock.
  await makeStatement('UPDATE variants SET backorder_allowed = 1 WHERE id = ?1').all(variantId(9, 1))
  const backorder = await reserveInventory(database, {
    correlationId: 'audit',
    expiresAt: '2026-08-26T09:00:00Z',
    idempotencyKey: nextKey('audit-backorder'),
    lines: reserveLines([[9, 1]], 100_000),
    now: NOW
  })
  check(backorder.outcome === 'reserved', 'backorder permitido acepta sobre-stock')
  await makeStatement('UPDATE variants SET backorder_allowed = 0 WHERE id = ?1').all(variantId(9, 1))

  // 13. Blocked and safety stock reduce sellable.
  await makeStatement(
    'UPDATE inventory_balances SET blocked_quantity = 4 WHERE variant_id = ?1 AND location_id = ?2'
  ).all(variantId(10, 1), locationId)
  const withBlocked = await listAvailability(database, { variantId: variantId(10, 1) })
  check(withBlocked[0]?.blockedQuantity === 4, 'bloqueado registrado')
  check(
    withBlocked[0]?.sellableQuantity === withBlocked[0].physicalQuantity - 4 - withBlocked[0].safetyStock,
    'sellable descuenta bloqueado y safety'
  )
  await makeStatement(
    'UPDATE inventory_balances SET blocked_quantity = 0 WHERE variant_id = ?1 AND location_id = ?2'
  ).all(variantId(10, 1), locationId)

  // 14. Adversarial contention sequence that actually crosses the stock boundary.
  const contestedVariant = variantId(12, 1)
  const contestedBaseline = await makeStatement(
    `SELECT b.physical_quantity AS physical, v.safety_stock AS safety
     FROM inventory_balances b JOIN variants v ON v.id = b.variant_id
     WHERE b.variant_id = ?1 AND b.location_id = ?2`
  ).first<{ physical: number; safety: number }>(contestedVariant, locationId)
  const constrainedPhysical = Number(contestedBaseline?.safety ?? 0) + 3
  const adjustment = constrainedPhysical - Number(contestedBaseline?.physical ?? 0)
  await makeStatement(
    `UPDATE inventory_balances
     SET physical_quantity = ?3, version = version + 1, updated_at = ?4
     WHERE variant_id = ?1 AND location_id = ?2`
  ).all(contestedVariant, locationId, constrainedPhysical, NOW)
  await makeStatement(
    `INSERT INTO inventory_movements (
       id, variant_id, location_id, movement_type, physical_delta, reserved_delta,
       reference_type, idempotency_key, correlation_id, reason, created_at
     ) VALUES ('audit-contention-adjustment', ?1, ?2, 'adjustment', ?3, 0,
               'audit', 'audit-contention-adjustment', 'audit', 'Preparar límite de contención', ?4)`
  ).all(contestedVariant, locationId, adjustment, NOW)
  const contestedStock =
    (
      await makeStatement(
        `SELECT b.physical_quantity - b.blocked_quantity - v.safety_stock AS qty
         FROM inventory_balances b JOIN variants v ON v.id = b.variant_id
         WHERE b.variant_id = ?1 AND b.location_id = ?2`
      ).first<{
        qty: number
      }>(contestedVariant, locationId)
    )?.qty ?? 0
  // Wrangler CLI is one process per command, so this isolated D1 audit is
  // intentionally sequential. Concurrent issuance and coordinator
  // serialisation are covered in d1-inventory-coordinator.test.ts.
  const attemptCount = 8
  const attempts: string[] = []
  for (let index = 0; index < attemptCount; index += 1) {
    attempts.push(
      await reserveInventory(database, {
        correlationId: 'audit-concurrent',
        expiresAt: '2026-08-26T09:00:00Z',
        idempotencyKey: `audit-concurrent-${index}`,
        lines: [{ locationId, quantity: 1, variantId: contestedVariant }],
        now: NOW
      }).then(
        (result) => result.outcome,
        () => 'error'
      )
    )
  }
  const fulfilled = attempts.filter((outcome) => outcome === 'reserved').length
  check(
    fulfilled === Math.min(attemptCount, Math.max(contestedStock, 0)),
    'contención secuencial: sin oversell',
    `${fulfilled}/${contestedStock}`
  )
  check((await activeReserved(12, 1)) === fulfilled, 'contención: activos coinciden con aceptados')

  // 15. Ledger reconciliation passes on the pristine dataset...
  const cleanReport = await reconcileInventory(database)
  check(cleanReport.ok, 'reconciliación limpia', JSON.stringify(cleanReport.violations))

  // ...and detects deliberate corruption of a balance without movement.
  await makeStatement(
    'UPDATE inventory_balances SET physical_quantity = physical_quantity + 7 WHERE variant_id = ?1 AND location_id = ?2'
  ).all(variantId(13, 1), locationId)
  const corruptedReport = await reconcileInventory(database)
  check(!corruptedReport.ok, 'reconciliación detecta corrupción deliberada')
  check(
    corruptedReport.violations.some((violation) => violation.code === 'ledger_physical_mismatch'),
    'corrupción clasificada'
  )
  await makeStatement(
    'UPDATE inventory_balances SET physical_quantity = physical_quantity - 7 WHERE variant_id = ?1 AND location_id = ?2'
  ).all(variantId(13, 1), locationId)
  check((await reconcileInventory(database)).ok, 'dataset restaurado tras corrupción')

  // Reapplying the bootstrap seed after live mutations must preserve current
  // balances and the append-only operational ledger byte-for-byte.
  const digestAfterOperations = createHash('sha256')
    .update(await digestRows())
    .digest('hex')
  await writeFile(inventorySeedFile, renderD1InventorySeed(), 'utf8')
  await wrangler(['d1', 'execute', 'DB', ...localArguments, '--yes', '--file', inventorySeedFile])
  const digestAfterLiveReseed = createHash('sha256')
    .update(await digestRows())
    .digest('hex')
  check(digestAfterOperations === digestAfterLiveReseed, 'seed: no sobrescribe stock vivo ni ledger')

  // 16. Canonical timestamps enforced by schema; duplicates impossible.
  const badTimestamp = await makeStatement(
    `INSERT INTO inventory_reservations (
       id, idempotency_key, payload_hash, status, correlation_id, expires_at, created_at, updated_at
     ) VALUES ('bad-ts', 'bad-ts-key', '${'a'.repeat(64)}', 'reserved', 'audit', '2026-08-26T09:00:00Z', '2026-08-25 09:00:00', '2026-08-25T09:00:00Z')`
  )
    .all()
    .then(
      () => false,
      () => true
    )
  check(badTimestamp, 'timestamp no canónico rechazado por el esquema')
  const impossibleTimestamp = await makeStatement(
    `INSERT INTO inventory_reservations (
       id, idempotency_key, payload_hash, status, correlation_id, expires_at, created_at, updated_at
     ) VALUES ('bad-date', 'bad-date-key', '${'b'.repeat(64)}', 'reserved', 'audit',
               '2027-08-26T09:00:00Z', '2026-99-99T09:00:00Z', '2026-99-99T09:00:00Z')`
  )
    .all()
    .then(
      () => false,
      () => true
    )
  check(impossibleTimestamp, 'fecha imposible rechazada por el esquema')
  const duplicateMovement = await makeStatement(
    `INSERT INTO inventory_movements (
       id, variant_id, location_id, movement_type, physical_delta, reserved_delta,
       reference_type, idempotency_key, correlation_id, created_at
     )
     SELECT 'dup-movement', variant_id, location_id, movement_type, physical_delta, reserved_delta,
            reference_type, idempotency_key, correlation_id, created_at
     FROM inventory_movements LIMIT 1`
  )
    .all()
    .then(
      () => false,
      () => true
    )
  check(duplicateMovement, 'movimiento duplicado rechazado por clave única')

  if (failures.length) throw new Error(`Isolated inventory audit failed:\n- ${failures.join('\n- ')}`)
  process.stdout.write(
    `D1 isolated inventory audit passed (${counts?.locations} location, ${counts?.balances} balances, ${counts?.movements} seeded movements, sha256 ${digestAfterReseed.slice(0, 16)}…)\n`
  )
} finally {
  // The ephemeral D1 directory is removed even when a scenario fails.
  await rm(persistenceDirectory, { recursive: true, force: true })
}
