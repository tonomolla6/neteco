import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createCart, quoteCart, setCartLine } from '../workers/catalog/cart'
import { compensateStaleAttempts, getOrderView, placeOrder, requestShippingOptions } from '../workers/catalog/checkout'

const execute = promisify(execFile)
const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx'

/**
 * Isolated checkout acceptance audit. Migrations and every seed are applied from
 * scratch into an ephemeral local D1 whose directory is always deleted, even on
 * failure; the shared canary state is never touched.
 */
const persistenceDirectory = await mkdtemp(join(tmpdir(), 'neteco-d1-checkout-audit-'))

try {
  const localArguments = ['--config', 'wrangler.canary.jsonc', '--local', '--persist-to', persistenceDirectory]

  async function wrangler(arguments_: string[]) {
    await execute(executable, ['wrangler', ...arguments_], { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 })
  }

  // 1. Clean migration from an empty database + full seed set from current code.
  await wrangler(['d1', 'migrations', 'apply', 'DB', ...localArguments])
  for (const generator of [
    () => import('./lib/d1-category-seed').then((module) => module.renderD1CategorySeed()),
    () => import('./lib/d1-product-seed').then((module) => module.renderD1ProductSeed()),
    () => import('./lib/d1-inventory-seed').then((module) => module.renderD1InventorySeed()),
    () => import('./lib/d1-shipping-seed').then((module) => module.renderD1ShippingSeed())
  ]) {
    const fileName = `seed-${Math.random().toString(36).slice(2)}.sql`
    const file = join(persistenceDirectory, fileName)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, await generator(), 'utf8')
    await wrangler(['d1', 'execute', 'DB', ...localArguments, '--yes', '--file', file])
  }

  function sqlLiteral(value: unknown): string {
    if (value === null || value === undefined) return 'NULL'
    if (typeof value === 'number') return String(value)
    if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`
    throw new Error(`Unsupported literal for isolated audit: ${typeof value}`)
  }

  let autoPosition = 0
  function inlineParameters(sql: string, parameters: unknown[]) {
    autoPosition = 0
    return sql.replaceAll(/\?(\d*)/g, (_match, digits: string) => {
      const index = digits ? Number(digits) : ++autoPosition
      return sqlLiteral(parameters[index - 1])
    })
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
        if (!parsed.every((entry) => entry.success)) throw new Error('Isolated checkout audit statement failed')
        return (parsed[0]?.results[0] as T | undefined) ?? null
      },
      async all<T>(...next: unknown[]) {
        if (next.length) parameters = next
        const parsed = await rawQuery(inlineParameters(sql, parameters))
        if (!parsed.every((entry) => entry.success)) throw new Error('Isolated checkout audit statement failed')
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

  /** One multi-statement command == one atomic implicit D1 transaction. */
  function ephemeralD1() {
    return {
      prepare: makeStatement,
      batch: async (statements: AuditStatement[]) => {
        const command = statements
          .map((statement) => `${inlineParameters(statement.sql, statement.bound())};`)
          .join('\n')
        const parsed = await rawQuery(command)
        if (parsed.length < statements.length || parsed.some((entry) => !entry.success))
          throw new Error('Isolated checkout audit batch incomplete')
        return statements.map((_statement, index) => ({ results: parsed[index]?.results ?? [], success: true }))
      }
    } as unknown as D1Database
  }
  const database = ephemeralD1()

  const failures: string[] = []
  const check = (condition: boolean, scenario: string, detail = '') => {
    if (!condition) failures.push(`${scenario}${detail ? `: ${detail}` : ''}`)
  }

  const NOW = '2026-08-25T09:00:00Z'
  const variantId = (productIndex: number, variantIndex: number) =>
    await_import_stableUuid()(`variant:${productIndex}:${variantIndex}`)

  function await_import_stableUuid() {
    // stableUuid is synchronous; imported statically below via dynamic binding
    return stableUuidRef
  }
  const { stableUuid: stableUuidRef } = await import('./lib/d1-category-seed')

  // 2. Cart with one line -> shipping options -> quote -> order.
  const created = await createCart(database, { correlationId: 'audit', now: NOW })
  const added = await setCartLine(database, {
    cartId: created.cartId,
    correlationId: 'audit',
    expectedVersion: 1,
    idempotencyKey: 'audit-add',
    now: NOW,
    quantity: 2,
    token: created.token,
    variantId: variantId(1, 1)
  })
  check(added.outcome === 'applied', 'línea añadida')

  const versionAfterAdd = Number(
    (await makeStatement('SELECT version AS v FROM carts WHERE id = ?').first<{ v: number }>(created.cartId))?.v ?? 0
  )
  const shipping = await requestShippingOptions(database, {
    cartId: created.cartId,
    correlationId: 'audit',
    destination: { city: 'Ontinyent', postalCode: '46870' },
    expectedVersion: versionAfterAdd,
    idempotencyKey: 'audit-ship',
    now: NOW,
    token: created.token
  })
  check(
    shipping.outcome === 'options',
    'opciones de envío calculadas server-side',
    JSON.stringify(shipping).slice(0, 160)
  )
  if (shipping.outcome !== 'options') throw new Error('shipping options required')

  const quote = await quoteCart(database, {
    cartId: created.cartId,
    correlationId: 'audit',
    expectedVersion: versionAfterAdd,
    idempotencyKey: 'audit-quote',
    now: NOW,
    token: created.token
  })
  check(quote.outcome === 'quoted', 'quote emitida')
  if (quote.outcome !== 'quoted') throw new Error('quote required')

  const optionHash = (shipping.body.options as Array<{ optionHash: string }>)[0]!.optionHash
  const placedFirst = await placeOrder(database, {
    billingAddress: undefined,
    cartId: created.cartId,
    consentPrivacy: true,
    consentTos: true,
    contactEmail: 'auditoria@neteco.es',
    correlationId: 'audit',
    expectedVersion: quote.quote.cartVersion,
    idempotencyKey: 'audit-checkout',
    now: NOW,
    quoteId: quote.quote.quoteId,
    selectedOptionHash: optionHash,
    selectedOptionIndex: 0,
    shippingAddress: {
      city: 'Ontinyent',
      countryCode: 'ES',
      line1: 'Carrer Major 1',
      phone: '+34 600 000 000',
      postalCode: '46870',
      province: 'València',
      recipientName: 'Auditoría NETECO'
    },
    shippingQuoteId: shipping.body.shippingQuoteId as string,
    token: created.token
  })
  check(
    placedFirst.outcome === 'order_created',
    'pedido awaiting_payment creado',
    JSON.stringify(placedFirst).slice(0, 200)
  )
  const orderId = placedFirst.outcome === 'order_created' ? String(placedFirst.body.id ?? '') : ''

  const orderRow = await makeStatement('SELECT status, reservation_id FROM orders WHERE id = ?').first<{
    reservation_id: string
    status: string
  }>(orderId)
  check(orderRow?.status === 'awaiting_payment', 'estado awaiting_payment')
  check(!!orderRow?.reservation_id, 'reserva enlazada al pedido')
  const reservations = Number(
    (
      await makeStatement("SELECT count(*) AS c FROM inventory_reservations WHERE status = 'reserved'").first<{
        c: number
      }>()
    )?.c ?? 0
  )
  check(reservations === 1, 'exactamente una reserva activa')
  const cartStatus = (
    await makeStatement('SELECT status FROM carts WHERE id = ?').first<{ status: string }>(created.cartId)
  )?.status
  check(cartStatus === 'converted', 'carrito convertido tras pedido')

  // Guest lookup works with the creation-time token only.
  const guestView = await getOrderView(database, {
    orderId,
    token: String(placedFirst.outcome === 'order_created' ? (placedFirst.body.orderToken ?? '') : '')
  })
  check(guestView?.id === orderId, 'token entregado permite consultar el pedido invitado')

  // 3. Replay of the same command returns the identical stored answer.
  const replayed = await placeOrder(database, {
    billingAddress: undefined,
    cartId: created.cartId,
    consentPrivacy: true,
    consentTos: true,
    contactEmail: 'auditoria@neteco.es',
    correlationId: 'audit',
    expectedVersion: quote.quote.cartVersion,
    idempotencyKey: 'audit-checkout',
    now: NOW,
    quoteId: quote.quote.quoteId,
    selectedOptionHash: optionHash,
    selectedOptionIndex: 0,
    shippingAddress: {
      city: 'Ontinyent',
      countryCode: 'ES',
      line1: 'Carrer Major 1',
      phone: '+34 600 000 000',
      postalCode: '46870',
      province: 'València',
      recipientName: 'Auditoría NETECO'
    },
    shippingQuoteId: shipping.body.shippingQuoteId as string,
    token: 'token-distinto-no-autorizado-token-e'
  }).catch((error: unknown) => error)
  check(
    replayed instanceof Error && (replayed as { code?: string }).code === 'unauthorized',
    'replay con token incorrecto no autoriza'
  )

  const sameTokenReplay = await placeOrder(database, {
    billingAddress: undefined,
    cartId: created.cartId,
    consentPrivacy: true,
    consentTos: true,
    contactEmail: 'auditoria@neteco.es',
    correlationId: 'audit',
    expectedVersion: quote.quote.cartVersion,
    idempotencyKey: 'audit-checkout',
    now: NOW,
    quoteId: quote.quote.quoteId,
    selectedOptionHash: optionHash,
    selectedOptionIndex: 0,
    shippingAddress: {
      city: 'Ontinyent',
      countryCode: 'ES',
      line1: 'Carrer Major 1',
      phone: '+34 600 000 000',
      postalCode: '46870',
      province: 'València',
      recipientName: 'Auditoría NETECO'
    },
    shippingQuoteId: shipping.body.shippingQuoteId as string,
    token: created.token
  })
  check(sameTokenReplay.outcome === 'order_created', 'replay legítimo conserva el contrato original')
  if (sameTokenReplay.outcome === 'order_created') {
    const storedBody = await makeStatement(
      "SELECT response_body FROM checkout_commands WHERE command_id = 'audit-checkout'"
    ).first<{ response_body: string }>()
    check(JSON.stringify(sameTokenReplay) === JSON.stringify(placedFirst), 'replay byte-idéntico desde D1')
    check(!storedBody?.response_body.includes(String(sameTokenReplay.body.orderToken)), 'token no persiste en D1')
  }

  // 4. Compensations never touch finished attempts.
  const sweepFinished = await compensateStaleAttempts(database, { at: '2026-09-01T00:00:00Z' })
  check(sweepFinished.compensatedCount === 0, 'compensación no altera pedidos finalizados')
  const stillReserved = await makeStatement(
    "SELECT status FROM inventory_reservations WHERE status = 'reserved'"
  ).first<{ status: string }>()
  check(stillReserved?.status === 'reserved', 'reserva del pedido finalizado intacta')

  // An abandoned attempt gets compensated exactly once.
  await makeStatement(
    `INSERT INTO checkout_attempts (
       id, cart_id, command_key, state, reservation_expires_at, reservation_lines_json,
       correlation_id, payload_hash, created_at, updated_at
     ) VALUES ('attempt-abandoned', '${created.cartId}', 'audit-abandoned', 'reserving',
               '2026-08-20T00:30:00Z', '[]', 'audit', '${'b'.repeat(64)}',
               '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z')`
  ).run()
  const firstSweep = await compensateStaleAttempts(database, { at: '2026-09-02T00:00:00Z' })
  check(firstSweep.compensatedCount >= 1, 'intento abandonado compensado')
  const secondSweep = await compensateStaleAttempts(database, { at: '2026-09-02T00:00:00Z' })
  check(secondSweep.compensatedCount === 0, 'compensación repetida es segura')

  // Contractual snapshots reject mutation attempts at schema level.
  const immutableCheck = await makeStatement('UPDATE order_lines SET quantity = 99')
    .all()
    .then(
      () => false,
      () => true
    )
  check(immutableCheck, 'snapshots contractuales rechazan UPDATE')
  const immutableQuoteHeader = await makeStatement('UPDATE checkout_quotes SET total_gross_cents = 1')
    .all()
    .then(
      () => false,
      () => true
    )
  check(immutableQuoteHeader, 'cabecera de quote contractual rechaza UPDATE')

  // Seed idempotency over the live dataset (shipping seed must not duplicate).
  const zonesBefore = Number(
    (await makeStatement('SELECT count(*) AS c FROM shipping_zones').first<{ c: number }>())?.c ?? 0
  )
  const ratesBefore = Number(
    (await makeStatement('SELECT count(*) AS c FROM shipping_rates').first<{ c: number }>())?.c ?? 0
  )
  const shippingSeedModule = await import('./lib/d1-shipping-seed')
  const shippingFile = join(persistenceDirectory, 'shipping-reseed.sql')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(shippingFile, shippingSeedModule.renderD1ShippingSeed(), 'utf8')
  await wrangler(['d1', 'execute', 'DB', ...localArguments, '--yes', '--file', shippingFile])
  const zonesAfter = Number(
    (await makeStatement('SELECT count(*) AS c FROM shipping_zones').first<{ c: number }>())?.c ?? 0
  )
  const ratesAfter = Number(
    (await makeStatement('SELECT count(*) AS c FROM shipping_rates').first<{ c: number }>())?.c ?? 0
  )
  check(zonesBefore === zonesAfter && ratesBefore === ratesAfter, 'seed de envío idempotente')

  if (failures.length) throw new Error(`Isolated checkout audit failed:\n- ${failures.join('\n- ')}`)
  process.stdout.write(
    `D1 isolated checkout audit passed (saga completa, replay byte-idéntico, compensaciones seguras, sha256 ${createHash('sha256').update(orderId).digest('hex').slice(0, 16)}…)\n`
  )
} finally {
  await rm(persistenceDirectory, { recursive: true, force: true })
}
