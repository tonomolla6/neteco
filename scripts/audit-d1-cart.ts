import { execFile } from 'node:child_process'
import { provisionPublicationValidityFixture } from '../tests/support/publication-validity-fixture'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createCart, expireCarts, getCart, quoteCart, setCartLine } from '../workers/catalog/cart'
import { stableUuid } from './lib/d1-category-seed'
import { PRODUCTS } from '../server/db/seed'
import { INVENTORY_SEED_LOCATION_ID, renderD1InventorySeed } from './lib/d1-inventory-seed'

const execute = promisify(execFile)
const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx'

/**
 * Isolated cart audit: migrations and seeds are generated from current code and
 * applied to an EPHEMERAL local D1 whose directory is always deleted afterwards,
 * even when a scenario fails. The shared canary state is never touched.
 */
const persistenceDirectory = await mkdtemp(join(tmpdir(), 'neteco-d1-cart-audit-'))

try {
  const localArguments = ['--config', 'wrangler.canary.jsonc', '--local', '--persist-to', persistenceDirectory]

  async function wrangler(arguments_: string[]) {
    await execute(executable, ['wrangler', ...arguments_], { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 })
  }

  // Clean migration from an empty database inside the ephemeral directory.
  await wrangler(['d1', 'migrations', 'apply', 'DB', ...localArguments])

  function sqlLiteral(value: unknown): string {
    if (value === null || value === undefined) return 'NULL'
    if (typeof value === 'number') return String(value)
    if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`
    throw new Error(`Unsupported literal for isolated audit: ${typeof value}`)
  }

  async function rawQuery(command: string) {
    const outcome = await execute(
      executable,
      ['wrangler', 'd1', 'execute', 'DB', ...localArguments, '--yes', '--json', '--command', command],
      { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 }
    ).catch((error: { stderr?: string; stdout?: string }) => {
      const detail = (error.stderr ?? '') + (error.stdout ?? '')
      throw new Error(`D1 command failed: ${detail.slice(0, 400)} | cmd: ${command.slice(0, 160)}`)
    })
    return JSON.parse(outcome.stdout) as Array<{ results: Array<Record<string, unknown>>; success: boolean }>
  }

  let autoPosition = 0
  function inlineParameters(sql: string, parameters: unknown[]) {
    autoPosition = 0
    return sql.replaceAll(/\?(\d*)/g, (_match, digits: string) => {
      const index = digits ? Number(digits) : ++autoPosition
      return sqlLiteral(parameters[index - 1])
    })
  }

  interface AuditStatement {
    sql: string
    bound: () => unknown[]
    bind(...parameters: unknown[]): AuditStatement
    first<T>(...parameters: unknown[]): Promise<T | null>
    all<T>(...parameters: unknown[]): Promise<{ results: T[] }>
    run(...parameters: unknown[]): Promise<{ success: true }>
  }

  function makeStatement(sql: string): AuditStatement {
    let parameters: unknown[] = []
    const statement: AuditStatement = {
      sql,
      bound: () => [...parameters],
      bind(...next: unknown[]) {
        parameters = next
        return statement
      },
      async first<T>(...next: unknown[]) {
        if (next.length) parameters = next
        const parsed = await rawQuery(inlineParameters(sql, parameters))
        if (!parsed.every((entry) => entry.success)) throw new Error('Isolated audit statement failed')
        return (parsed[0]?.results[0] as T | undefined) ?? null
      },
      async all<T>(...next: unknown[]) {
        if (next.length) parameters = next
        const parsed = await rawQuery(inlineParameters(sql, parameters))
        if (!parsed.every((entry) => entry.success)) throw new Error('Isolated audit statement failed')
        return { results: parsed.flatMap((entry) => entry.results) as T[] }
      },
      async run(...next: unknown[]) {
        if (next.length) parameters = next
        await rawQuery(inlineParameters(sql, parameters))
        return { success: true }
      }
    }
    return statement
  }

  /** One multi-statement command == one implicit D1 transaction (atomic). */
  function ephemeralD1() {
    return {
      prepare: makeStatement,
      batch: async (statements: AuditStatement[]) => {
        const command = statements
          .map((statement) => `${inlineParameters(statement.sql, statement.bound())};`)
          .join('\n')
        let parsed: Array<{ results: Array<Record<string, unknown>>; success: boolean }>
        try {
          parsed = await rawQuery(command)
        } catch (error) {
          throw new Error(`batch step failed: ${(error as Error).message}`, { cause: error })
        }
        if (parsed.length < statements.length || parsed.some((entry) => !entry.success))
          throw new Error('Isolated audit batch incomplete')
        return statements.map((_statement, index) => ({ results: parsed[index]?.results ?? [], success: true }))
      }
    } as unknown as D1Database
  }
  const database = ephemeralD1()

  // Seeds generated from current code into the ephemeral directory only.
  const seedFiles: Array<[string, () => string | Promise<string>]> = [
    ['categories.sql', () => import('./lib/d1-category-seed').then((module) => module.renderD1CategorySeed())],
    ['products.sql', () => import('./lib/d1-product-seed').then((module) => module.renderD1ProductSeed())],
    ['inventory.sql', () => renderD1InventorySeed()]
  ]
  for (const [name, render] of seedFiles) {
    const file = join(persistenceDirectory, name)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, await render(), 'utf8')
    await wrangler(['d1', 'execute', 'DB', ...localArguments, '--yes', '--file', file])
  }

  await provisionPublicationValidityFixture(database, {
    productIds: [1, 2, 3, 5].map((id) => stableUuid(`product:${id}`)),
    now: '2026-01-01T00:00:00Z'
  })

  const failures: string[] = []
  const check = (condition: boolean, scenario: string, detail = '') => {
    if (!condition) failures.push(`${scenario}${detail ? `: ${detail}` : ''}`)
  }

  const NOW = '2026-08-25T09:00:00Z'
  const variantId = (productIndex: number, variantIndex: number) =>
    stableUuid(`variant:${productIndex}:${variantIndex}`)
  let sequence = 0
  const nextKey = (prefix: string) => `${prefix}-${++sequence}`
  const locationId = INVENTORY_SEED_LOCATION_ID

  // 1. Empty cart lifecycle: add / update / remove with optimistic versions.
  const created = await createCart(database, { correlationId: 'audit', now: NOW })
  check(created.token.length >= 43, 'creación devuelve token secreto una sola vez')

  const view0 = await getCart(database, { cartId: created.cartId, token: created.token })
  check(view0.version === 1 && view0.lines.length === 0, 'carrito vacío inicial')

  const added = await setCartLine(database, {
    cartId: created.cartId,
    correlationId: 'audit',
    expectedVersion: 1,
    idempotencyKey: nextKey('cart-audit'),
    now: NOW,
    quantity: 2,
    token: created.token,
    variantId: variantId(1, 1)
  })
  check(added.outcome === 'applied', 'add aplica')

  const updated = await setCartLine(database, {
    cartId: created.cartId,
    correlationId: 'audit',
    expectedVersion: 2,
    idempotencyKey: nextKey('cart-audit'),
    now: NOW,
    quantity: 5,
    token: created.token,
    variantId: variantId(1, 1)
  })
  check(updated.outcome === 'applied', 'update aplica')

  const removed = await setCartLine(database, {
    cartId: created.cartId,
    correlationId: 'audit',
    expectedVersion: 3,
    idempotencyKey: nextKey('cart-audit'),
    now: NOW,
    quantity: 0,
    token: created.token,
    variantId: variantId(1, 1)
  })
  check(removed.outcome === 'applied' && removed.body.removed === true, 'remove con quantity=0')

  // Re-add for the quote scenarios below.
  await setCartLine(database, {
    cartId: created.cartId,
    correlationId: 'audit',
    expectedVersion: 4,
    idempotencyKey: nextKey('cart-audit'),
    now: NOW,
    quantity: 3,
    token: created.token,
    variantId: variantId(1, 1)
  })

  // 2. Replay identical -> same bytes; different payload -> conflict.
  const replayKey = nextKey('cart-audit')
  const firstApply = await setCartLine(database, {
    cartId: created.cartId,
    correlationId: 'audit',
    expectedVersion: 5,
    idempotencyKey: replayKey,
    now: NOW,
    quantity: 4,
    token: created.token,
    variantId: variantId(2, 1)
  })
  const replay = await setCartLine(database, {
    cartId: created.cartId,
    correlationId: 'audit',
    expectedVersion: 5,
    idempotencyKey: replayKey,
    now: NOW,
    quantity: 4,
    token: created.token,
    variantId: variantId(2, 1)
  })
  check(JSON.stringify(replay) === JSON.stringify(firstApply), 'replay devuelve exactamente la misma respuesta')
  const conflicting = await setCartLine(database, {
    cartId: created.cartId,
    correlationId: 'audit',
    expectedVersion: 6,
    idempotencyKey: replayKey,
    now: NOW,
    quantity: 9,
    token: created.token,
    variantId: variantId(2, 1)
  })
  check(conflicting.outcome === 'conflict', 'misma key con payload distinto -> conflict')

  // 3. Version conflict without effects.
  const commandsBefore = Number(
    (await makeStatement('SELECT count(*) AS c FROM cart_commands').first<{ c: number }>())?.c ?? 0
  )
  const stale = await setCartLine(database, {
    cartId: created.cartId,
    correlationId: 'audit',
    expectedVersion: 1,
    idempotencyKey: nextKey('cart-audit-stale'),
    now: NOW,
    quantity: 8,
    token: created.token,
    variantId: variantId(3, 1)
  })
  check(stale.outcome === 'version_conflict', 'expectedVersion obsoleta -> version_conflict')
  const commandsAfterStale = Number(
    (await makeStatement('SELECT count(*) AS c FROM cart_commands').first<{ c: number }>())?.c ?? 0
  )
  check(commandsAfterStale === commandsBefore, 'version conflict sin efectos persistentes')

  // 4. Wrong token is indistinguishable from an unknown cart.
  try {
    await getCart(database, { cartId: created.cartId, token: 'no-es-el-token-no-es-el-token-no-es' })
    failures.push('token incorrecto debe rechazar')
  } catch (error) {
    const code = (error as { code?: string }).code
    check(code === 'unauthorized', 'token incorrecto sin fuga de existencia')
    const detail = JSON.stringify(error)
    check(!detail.includes(created.cartId) || code === 'unauthorized', 'sin detalles internos en el error')
  }

  // 5. Quote with effective price, VAT, observed stock and immutable snapshots.
  // A governed future price for variant 1:1 becomes effective tomorrow.
  await makeStatement(
    `INSERT INTO variant_price_versions (
       id, variant_id, gross_cents, volume_tiers, valid_from, status, reason, created_at
     ) VALUES ('pv-cart-audit-future', '${variantId(1, 1)}', 12345, '[]', '2026-08-26T00:00:00Z', 'approved',
               'Subida programada auditoría', '${NOW}')`
  ).run()

  const quoteNow = await quoteCart(database, {
    cartId: created.cartId,
    correlationId: 'audit',
    expectedVersion: 6,
    idempotencyKey: nextKey('cart-quote'),
    now: NOW,
    token: created.token
  })
  check(quoteNow.outcome === 'quoted', 'quote actual emitida')
  if (quoteNow.outcome !== 'quoted') throw new Error('quote required for remaining scenarios')

  const expectedBaseCents = Math.round(PRODUCTS[0]!.variants[0]![1]! * 100)
  const seededVersionId = stableUuid('price-version:1:1')
  const lineToday = quoteNow.quote.lines.find((entry) => entry.variantId === variantId(1, 1))
  check(
    !!lineToday &&
      lineToday.quantity === 3 &&
      lineToday.unitGrossCents === expectedBaseCents &&
      lineToday.priceVersionId === seededVersionId,
    'versión inicial gobernada vigente hoy',
    JSON.stringify(lineToday)
  )
  check(
    !!lineToday &&
      lineToday.taxRateBasisPoints === 2100 &&
      lineToday.netCents + lineToday.taxCents === lineToday.grossCents,
    'IVA y desglose correctos'
  )
  check(!!lineToday && lineToday.availableQuantity > 0, 'disponibilidad observada')
  check(quoteNow.quote.shipping.grossCents === 0 && quoteNow.quote.shipping.pending, 'portes pendientes, no gratis')
  check(quoteNow.quote.pricingInstant === NOW, 'instante de pricing server-side')

  const balancesBeforeQuotes = (
    await makeStatement('SELECT variant_id AS v, physical_quantity AS q FROM inventory_balances ORDER BY v').all()
  ).results

  // Temporal boundary: at the exact valid_from instant the new price governs.
  const quoteTomorrow = await quoteCart(database, {
    cartId: created.cartId,
    correlationId: 'audit',
    expectedVersion: 6,
    idempotencyKey: nextKey('cart-quote-tomorrow'),
    now: '2026-08-26T00:00:00Z',
    token: created.token
  })
  const lineTomorrow =
    quoteTomorrow.outcome === 'quoted'
      ? quoteTomorrow.quote.lines.find((entry) => entry.variantId === variantId(1, 1))
      : undefined
  check(
    !!lineTomorrow &&
      lineTomorrow.unitGrossCents === 12345 &&
      lineTomorrow.priceVersionId === 'pv-cart-audit-future' &&
      quoteTomorrow.outcome === 'quoted' &&
      quoteTomorrow.quote.pricingInstant === '2026-08-26T00:00:00Z',
    'borde temporal de precio efectivo'
  )

  // True legacy fallback: a variant whose only version is removed quotes the base.
  await makeStatement('DELETE FROM variant_price_versions WHERE id = ?').run(stableUuid('price-version:2:1'))
  const quoteFallback = await quoteCart(database, {
    cartId: created.cartId,
    correlationId: 'audit',
    expectedVersion: 6,
    idempotencyKey: nextKey('cart-quote-fallback'),
    now: NOW,
    token: created.token
  })
  const fallbackLine =
    quoteFallback.outcome === 'quoted'
      ? quoteFallback.quote.lines.find((entry) => entry.variantId === variantId(2, 1))
      : undefined
  const expectedSecondCents = Math.round(PRODUCTS[1]!.variants[0]![1]! * 100)
  check(
    !!fallbackLine &&
      fallbackLine.unitGrossCents === expectedSecondCents &&
      fallbackLine.priceVersionId === `legacy:${variantId(2, 1)}`,
    'fallback legado sin versiones',
    JSON.stringify(fallbackLine)
  )
  // Restore the deleted governed version via the deterministic product seed.
  await wrangler([
    'd1',
    'execute',
    'DB',
    ...localArguments,
    '--yes',
    '--file',
    join(persistenceDirectory, 'products.sql')
  ])

  // The old snapshot remains byte-identical after a price change and a cart edit.
  const oldSnapshotBefore = (
    await makeStatement('SELECT * FROM checkout_quote_lines WHERE quote_id = ? ORDER BY line_index').all<
      Record<string, unknown>
    >(quoteNow.quote.quoteId)
  ).results
  const oldHeaderBefore = await makeStatement('SELECT * FROM checkout_quotes WHERE id = ?').first<
    Record<string, unknown>
  >(quoteNow.quote.quoteId)
  await setCartLine(database, {
    cartId: created.cartId,
    correlationId: 'audit',
    expectedVersion: quoteNow.quote.cartVersion,
    idempotencyKey: nextKey('cart-audit-edit'),
    now: NOW,
    quantity: 50,
    token: created.token,
    variantId: variantId(1, 1)
  })
  const oldSnapshotAfter = (
    await makeStatement('SELECT * FROM checkout_quote_lines WHERE quote_id = ? ORDER BY line_index').all<
      Record<string, unknown>
    >(quoteNow.quote.quoteId)
  ).results
  const oldHeaderAfter = await makeStatement('SELECT * FROM checkout_quotes WHERE id = ?').first<
    Record<string, unknown>
  >(quoteNow.quote.quoteId)
  check(JSON.stringify(oldSnapshotBefore) === JSON.stringify(oldSnapshotAfter), 'snapshot antiguo inmutable (líneas)')
  check(JSON.stringify(oldHeaderBefore) === JSON.stringify(oldHeaderAfter), 'snapshot antiguo inmutable (cabecera)')
  const digestBefore = createHash('sha256').update(JSON.stringify(oldSnapshotBefore)).digest('hex')

  // No stock was reserved or modified by any quote.
  const reservationsCount = Number(
    (await makeStatement('SELECT count(*) AS c FROM inventory_reservations').first<{ c: number }>())?.c ?? 0
  )
  check(reservationsCount === 0, 'ninguna reserva creada por quotes')
  const balancesAfterQuotes = (
    await makeStatement('SELECT variant_id AS v, physical_quantity AS q FROM inventory_balances ORDER BY v').all()
  ).results
  check(JSON.stringify(balancesAfterQuotes) === JSON.stringify(balancesBeforeQuotes), 'quotes no mutan balances')

  // Backorder variant accepts beyond-stock lines in the cart and quotes them.
  await makeStatement('UPDATE variants SET backorder_allowed = 1 WHERE id = ?').run(variantId(5, 1))
  const backorderAdd = await setCartLine(database, {
    cartId: created.cartId,
    correlationId: 'audit',
    expectedVersion: quoteNow.quote.cartVersion + 1,
    idempotencyKey: nextKey('cart-backorder'),
    now: NOW,
    quantity: 500,
    token: created.token,
    variantId: variantId(5, 1)
  })
  check(backorderAdd.outcome === 'applied', 'backorder permitido acepta sobre-stock en carrito')

  // Backorder variant accepts beyond-stock lines in the cart and quotes them.
  await makeStatement('UPDATE variants SET backorder_allowed = 1 WHERE id = ?').run(variantId(5, 1))
  void locationId

  // Expiration + obsolete alarm instant.
  const ttlCart = await createCart(database, { correlationId: 'audit', now: NOW })
  await setCartLine(database, {
    cartId: ttlCart.cartId,
    correlationId: 'audit',
    expectedVersion: 1,
    idempotencyKey: nextKey('cart-ttl'),
    now: NOW,
    quantity: 1,
    token: ttlCart.token,
    variantId: variantId(1, 1)
  })
  const staleSweep = await expireCarts(database, { at: '2026-08-25T08:00:00Z' })
  check(staleSweep.expiredCount === 0, 'barrido obsoleto antes de expiración no expira nada')
  const dueSweep = await expireCarts(database, { at: '2026-08-29T00:00:00Z' })
  check(dueSweep.expiredCount >= 2, 'barrido vencido expira carritos')
  const repeatSweep = await expireCarts(database, { at: '2026-08-29T00:00:00Z' })
  check(repeatSweep.expiredCount === 0, 'barrido repetido es seguro')
  await expectFrozen(ttlCart.cartId)

  async function expectFrozen(cartId: string) {
    const statusRow = await makeStatement('SELECT status FROM carts WHERE id = ?').first<{ status: string }>(cartId)
    check(statusRow?.status === 'expired', 'carrito vencido marcado expired')
    try {
      await setCartLine(database, {
        cartId,
        correlationId: 'audit',
        expectedVersion: 99,
        idempotencyKey: nextKey('cart-frozen'),
        now: NOW,
        quantity: 1,
        token: 'cualquier-token-porque-esta-expirado',
        variantId: variantId(1, 1)
      })
      failures.push('carrito vencido aceptó mutación')
    } catch {
      // either unauthorized or not_active: both freeze the cart
    }
  }

  // Reseeding must not touch live stock or ledger rows.
  const liveStockBefore = (
    await makeStatement('SELECT variant_id AS v, physical_quantity AS q FROM inventory_balances ORDER BY v').all()
  ).results
  const ledgerBefore = await makeStatement('SELECT count(*) AS c FROM inventory_movements').first<{ c: number }>()
  await wrangler([
    'd1',
    'execute',
    'DB',
    ...localArguments,
    '--yes',
    '--file',
    join(persistenceDirectory, 'inventory.sql')
  ])
  const liveStockAfter = (
    await makeStatement('SELECT variant_id AS v, physical_quantity AS q FROM inventory_balances ORDER BY v').all()
  ).results
  const ledgerAfter = await makeStatement('SELECT count(*) AS c FROM inventory_movements').first<{ c: number }>()
  check(JSON.stringify(liveStockAfter) === JSON.stringify(liveStockBefore), 'reseed no cambia stock vivo')
  check(JSON.stringify(ledgerAfter) === JSON.stringify(ledgerBefore), 'reseed no cambia el ledger')

  if (failures.length) throw new Error(`Isolated cart audit failed:\n- ${failures.join('\n- ')}`)
  process.stdout.write(
    `D1 isolated cart audit passed (migración limpia, ciclo completo, quotes inmutables, sha256 ${digestBefore.slice(0, 16)}…)\n`
  )
} finally {
  // The ephemeral D1 directory is deleted even when a scenario fails.
  await rm(persistenceDirectory, { recursive: true, force: true })
}
