import { execFile } from 'node:child_process'
import { buildNativeCanary } from '../tests/support/native-canary-build'
import { provisionPublicationValidityFixture } from '../tests/support/publication-validity-fixture'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { createCart, quoteCart, setCartLine } from '../workers/catalog/cart'
import { compensateStaleAttempts, getOrderView, placeOrder, requestShippingOptions } from '../workers/catalog/checkout'
import { initiateRedsysPayment, processRedsysNotification } from '../workers/catalog/payments'
import { encodeMerchantParameters, signMerchantParameters } from '../workers/payments/redsys'
import { REDSYS_OFFICIAL_CONTRACT } from '../tests/fixtures/redsys-official'
import { INVENTORY_COORDINATOR_NAME, type AssignResult, type OperationInput } from '../workers/catalog/inventory'
import { publishFiscalOutbox, type FiscalEvaluationMessage } from '../workers/catalog/fiscal-outbox'
import { setTimeout as delay } from 'node:timers/promises'

const execute = promisify(execFile)
const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const exerciseQueueFailure = process.argv.includes('--queue-failure')

/**
 * Isolated checkout acceptance audit. Migrations and every seed are applied from
 * scratch into an ephemeral local D1 whose directory is always deleted, even on
 * failure; the shared canary state is never touched.
 */
const persistenceDirectory = await mkdtemp(join(tmpdir(), 'neteco-d1-checkout-audit-'))
let runtime: Miniflare | undefined

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

  // Use the actual workerd binding: SQL parameters and batch boundaries must
  // have exactly the same semantics as the application, without CLI splitting.
  const coordinatorBundle = await buildNativeCanary({
    entryPoints: ['tests/support/inventory-runtime.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    external: ['cloudflare:*', 'node:*'],
    write: false
  })
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      ...coordinatorBundle.nativeSource,
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      queueProducers: { ASYNC_JOBS: 'fiscal-audit-local' },
      queueConsumers: { 'fiscal-audit-local': { maxBatchSize: 12, maxBatchTimeout: 1, maxRetries: 1 } },
      durableObjects: { INVENTORY: { className: 'InventoryCoordinator', useSQLite: true } },
      resourcePersistencePath: join(persistenceDirectory, 'v3'),
      d1Databases: { DB: '00000000-0000-0000-0000-000000000000' }
    })
  )
  const database = (await runtime.getD1Database('DB')) as unknown as D1Database
  // Miniflare's ReplaceWorkersTypes maps this namespace to Request when combined
  // with the generated runtime declarations. Validate the two methods we use.
  const inventoryNamespace: unknown = await runtime.getDurableObjectNamespace('INVENTORY')
  function isNamespace(value: unknown): value is Pick<DurableObjectNamespace, 'get' | 'idFromName'> {
    return (
      typeof value === 'object' &&
      value !== null &&
      'get' in value &&
      typeof value.get === 'function' &&
      'idFromName' in value &&
      typeof value.idFromName === 'function'
    )
  }
  if (!isNamespace(inventoryNamespace)) throw new Error('Inventory namespace unavailable')
  const inventoryStub = inventoryNamespace.get(inventoryNamespace.idFromName(INVENTORY_COORDINATOR_NAME))
  const inventoryGateway = {
    async assign(payload: OperationInput): Promise<AssignResult> {
      const response = await inventoryStub.fetch('https://inventory.invalid/command', {
        method: 'POST',
        body: JSON.stringify({ type: 'assign', commandId: crypto.randomUUID(), payload })
      })
      if (response.status !== 200 && response.status !== 409) throw new Error(`Inventory DO status ${response.status}`)
      return (await response.json()) as AssignResult
    }
  }
  function makeStatement(sql: string) {
    return {
      first: <T>(...values: unknown[]) =>
        database
          .prepare(sql)
          .bind(...values)
          .first<T>(),
      all: (...values: unknown[]) =>
        database
          .prepare(sql)
          .bind(...values)
          .all(),
      run: (...values: unknown[]) =>
        database
          .prepare(sql)
          .bind(...values)
          .run()
    }
  }

  const failures: string[] = []
  const check = (condition: boolean, scenario: string, detail = '') => {
    if (!condition) failures.push(`${scenario}${detail ? `: ${detail}` : ''}`)
  }

  const NOW = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const offsetInstant = (seconds: number) =>
    new Date(Date.parse(NOW) + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const variantId = (productIndex: number, variantIndex: number) =>
    await_import_stableUuid()(`variant:${productIndex}:${variantIndex}`)

  function await_import_stableUuid() {
    // stableUuid is synchronous; imported statically below via dynamic binding
    return stableUuidRef
  }
  const { stableUuid: stableUuidRef } = await import('./lib/d1-category-seed')

  await provisionPublicationValidityFixture(database, {
    productIds: [stableUuidRef('product:1')],
    now: '2026-01-01T00:00:00Z'
  })

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
    token: String(placedFirst.outcome === 'order_created' ? (placedFirst.body.orderToken ?? '') : ''),
    now: NOW
  })
  check(
    guestView !== null && 'id' in guestView && guestView.id === orderId,
    'token entregado permite consultar el pedido invitado'
  )

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
  const sweepFinished = await compensateStaleAttempts(database, { at: offsetInstant(7 * 86400) })
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
               '${offsetInstant(-5 * 86400 + 1800)}', '[]', 'audit', '${'b'.repeat(64)}',
               '${offsetInstant(-5 * 86400)}', '${offsetInstant(-5 * 86400)}')`
  ).run()
  const firstSweep = await compensateStaleAttempts(database, { at: offsetInstant(8 * 86400) })
  check(firstSweep.compensatedCount >= 1, 'intento abandonado compensado')
  const secondSweep = await compensateStaleAttempts(database, { at: offsetInstant(8 * 86400) })
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

  // Synthetic Redsys callback, exclusively against this disposable D1 database.
  // Public documentation vector only: never load a production secret or call a bank.
  if (placedFirst.outcome !== 'order_created') throw new Error('Order required for payment audit')
  const paymentConfig = {
    environment: 'sandbox' as const,
    merchantName: 'NETECO',
    merchantCode: REDSYS_OFFICIAL_CONTRACT.sandbox.merchantCode,
    terminal: REDSYS_OFFICIAL_CONTRACT.sandbox.terminal,
    secretKey: REDSYS_OFFICIAL_CONTRACT.sandbox.secretKey,
    publicBaseUrl: 'https://shop.example'
  }
  const paymentInput = {
    orderId,
    orderToken: String(placedFirst.body.orderToken),
    idempotencyKey: 'audit-payment',
    method: 'card' as const,
    correlationId: 'audit-payment',
    now: NOW
  }
  const payment = await initiateRedsysPayment(database, paymentInput, paymentConfig)
  check(
    JSON.stringify(await initiateRedsysPayment(database, paymentInput, paymentConfig)) === JSON.stringify(payment),
    'payment redirect replay exact'
  )
  const intent = await makeStatement('SELECT merchant_order, amount_gross_cents FROM payment_intents').first<{
    merchant_order: string
    amount_gross_cents: number
  }>()
  if (!intent) throw new Error('Payment intent required')
  const parameterValues = {
    Ds_Order: intent.merchant_order,
    Ds_Amount: String(intent.amount_gross_cents),
    Ds_Currency: '978',
    Ds_MerchantCode: paymentConfig.merchantCode,
    Ds_Terminal: paymentConfig.terminal,
    Ds_Response: '0000',
    Ds_TransactionType: '0'
  }
  const parameters = encodeMerchantParameters(parameterValues)
  const declineParameters = encodeMerchantParameters({ ...parameterValues, Ds_Response: '0101' })
  await processRedsysNotification(
    database,
    {
      Ds_MerchantParameters: declineParameters,
      Ds_SignatureVersion: 'HMAC_SHA512_V2',
      Ds_Signature: await signMerchantParameters(declineParameters, paymentConfig.secretKey)
    },
    paymentConfig,
    { now: NOW, correlationId: 'audit-decline' }
  )
  const retry = await initiateRedsysPayment(
    database,
    { ...paymentInput, idempotencyKey: 'audit-payment-retry' },
    paymentConfig
  )
  const envelope = {
    Ds_MerchantParameters: parameters,
    Ds_SignatureVersion: 'HMAC_SHA512_V2',
    Ds_Signature: await signMerchantParameters(parameters, paymentConfig.secretKey)
  }
  const concurrentCaptures = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      processRedsysNotification(
        database,
        envelope,
        paymentConfig,
        { now: NOW, correlationId: `audit-concurrent-${index}` },
        inventoryGateway
      )
    )
  )
  check(
    concurrentCaptures.every((result) => result.outcome === 'captured'),
    '12 concurrent signed duplicate callbacks'
  )
  const domainCaptures = await makeStatement(
    "SELECT count(*) AS n FROM order_events WHERE event_type = 'payment_captured'"
  ).first<{ n: number }>()
  check(domainCaptures?.n === 1, 'concurrent callbacks emit one downstream capture event')
  const paid = await getOrderView(database, { orderId, token: paymentInput.orderToken, now: NOW })
  check(paid?.payment.status === 'paid', 'order exposes confirmed payment')
  const retryIntent = await makeStatement('SELECT merchant_order FROM payment_intents WHERE id = ?').first<{
    merchant_order: string
  }>(retry.body.paymentIntentId)
  if (!retryIntent) throw new Error('Retry payment intent required')
  const secondParameters = encodeMerchantParameters({ ...parameterValues, Ds_Order: retryIntent.merchant_order })
  const secondEnvelope = {
    Ds_MerchantParameters: secondParameters,
    Ds_SignatureVersion: 'HMAC_SHA512_V2',
    Ds_Signature: await signMerchantParameters(secondParameters, paymentConfig.secretKey)
  }
  for (const correlationId of ['audit-second-capture', 'audit-second-replay']) {
    check(
      (
        await processRedsysNotification(
          database,
          secondEnvelope,
          paymentConfig,
          { now: NOW, correlationId },
          inventoryGateway
        )
      ).outcome === 'manual_review',
      'second provider capture goes to durable review'
    )
  }
  const review = await makeStatement(
    'SELECT status, last_error_code FROM payment_recovery_jobs WHERE payment_intent_id = ?'
  ).first<{ status: string; last_error_code: string }>(retry.body.paymentIntentId)
  check(
    review?.status === 'manual_review' && review.last_error_code === 'duplicate_provider_capture',
    'duplicate capture remains discoverable'
  )
  const allocated = await makeStatement(
    "SELECT count(*) AS n FROM inventory_movements WHERE movement_type = 'allocate'"
  ).first<{ n: number }>()
  check(allocated?.n === 1, 'duplicate callback allocates inventory only once')
  const fiscalEvents = await makeStatement(
    `SELECT count(*) AS n FROM fiscal_outbox_events event
     JOIN fiscal_outbox_delivery delivery ON delivery.event_id = event.id
     WHERE event.order_id = ? AND delivery.status = 'blocked_policy'`
  ).first<{ n: number }>(orderId)
  check(fiscalEvents?.n === 1, 'paid order queues exactly one policy-blocked fiscal evaluation')
  await database.prepare('CREATE TABLE audit_queue_completion (handled INTEGER NOT NULL)').run()
  await database.prepare('INSERT INTO audit_queue_completion VALUES (0)').run()
  async function waitForQueueHandlers(expected: number, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs
    let handled = 0
    while (Date.now() < deadline) {
      handled = Number(
        (await database.prepare('SELECT handled FROM audit_queue_completion').first<{ handled: number }>())?.handled ??
          0
      )
      if (handled >= expected) return handled
      await delay(100)
    }
    throw new Error(`Queue handlers timed out: expected ${expected}, observed ${handled}`)
  }
  if (exerciseQueueFailure) {
    await database
      .prepare(
        `CREATE TRIGGER audit_reject_fiscal_receipt BEFORE INSERT ON fiscal_evaluation_inbox
      BEGIN SELECT RAISE(ABORT, 'injected receipt write failure'); END`
      )
      .run()
  }
  const queue = await runtime.getQueueProducer<FiscalEvaluationMessage>('ASYNC_JOBS')
  const sender = {
    send: async (message: FiscalEvaluationMessage) => {
      await queue.send(message)
    }
  }
  check(
    (await publishFiscalOutbox(database, sender, { now: NOW })).published === 0,
    'runtime queue respects policy block'
  )
  // Explicit fixture-only release for transport testing, not fiscal approval.
  await database.prepare("UPDATE fiscal_outbox_delivery SET status = 'ready'").run()
  check(
    (await publishFiscalOutbox(database, sender, { now: NOW })).published === 1,
    'outbox publishes to local Queue binding'
  )
  const fiscalMessage: FiscalEvaluationMessage = {
    type: 'invoice.evaluate.requested',
    version: 1,
    eventId: `invoice-evaluation:${orderId}`
  }
  if (exerciseQueueFailure) {
    await waitForQueueHandlers(1, 15000)
    const failedInbox = await database
      .prepare('SELECT count(*) AS n FROM fiscal_evaluation_inbox')
      .first<{ n: number }>()
    check(failedInbox?.n === 0, 'D1 failure leaves no acknowledged fiscal receipt')
    await database.prepare('DROP TRIGGER audit_reject_fiscal_receipt').run()
    process.stdout.write('Injected D1 receipt failure observed; awaiting the actual 60-second Queue retry.\n')
  }
  await Promise.all(Array.from({ length: 11 }, () => queue.send(fiscalMessage)))
  const expectedHandlers = exerciseQueueFailure ? 13 : 12
  const handled = await waitForQueueHandlers(expectedHandlers, exerciseQueueFailure ? 75000 : 15000)
  check(handled === expectedHandlers, 'all runtime Queue messages and requested retries finished', String(handled))
  const inbox = await database
    .prepare("SELECT count(*) AS n FROM fiscal_evaluation_inbox WHERE order_id = ?1 AND status = 'blocked_policy'")
    .bind(orderId)
    .first<{ n: number }>()
  check(inbox?.n === 1, 'runtime Queue duplicates create one policy-blocked fiscal receipt')

  if (failures.length) throw new Error(`Isolated checkout audit failed:\n- ${failures.join('\n- ')}`)
  process.stdout.write(
    `D1 isolated checkout audit passed (saga completa, replay byte-idéntico, compensaciones seguras, pago firmado y callback duplicado sin doble stock, sha256 ${createHash('sha256').update(orderId).digest('hex').slice(0, 16)}…)\n`
  )
} finally {
  try {
    await runtime?.dispose()
  } finally {
    await rm(persistenceDirectory, { recursive: true, force: true })
  }
}
