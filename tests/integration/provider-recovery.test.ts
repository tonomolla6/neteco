import { execFile, spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { createConnection, createServer as createNetServer, type Socket } from 'node:net'
import { promisify } from 'node:util'
import postgres, { type Sql } from 'postgres'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabase } from '../../server/db/client'
import { closeRedis, useRedis } from '../../server/db/redis'
import { BeplyError, BeplyInvoiceProvider } from '../../server/integrations/beply'
import { confirmMockPayment, createOrder, type CreateOrderInput } from '../../server/services/orders'
import { createOrderShipment, quoteCartShipping } from '../../server/services/shipping'
import { deterministicTestData, type DeterministicTestData } from '../fixtures/deterministic'
import { isolatedPostgresDatabase, type IsolatedPostgresDatabase } from '../fixtures/postgres'

// determinism-audit: allow-local-network-harness -- controlled loopback fault injection only.

const execFileAsync = promisify(execFile)
const baseConnection = process.env.DATABASE_URL ?? 'postgres://neteco:neteco-local@localhost:56432/neteco'
const baseRedisUrl = process.env.REDIS_URL
const encryptionKey = Buffer.alloc(32, 25).toString('base64')

let database: IsolatedPostgresDatabase
let sql: Sql
let connection: string
let testData: DeterministicTestData

function uuid(label?: string) {
  return label ? testData.uuid(label) : testData.uuid()
}

function destination() {
  return {
    name: 'Comprador recuperación',
    line1: 'Calle de pruebas 1',
    postalCode: '46800',
    city: 'Xàtiva',
    region: 'Valencia',
    countryCode: 'ES' as const,
    phone: '600000000'
  }
}

async function orderFixture(shippingMethod: 'recogida' | 'envio' = 'recogida', capture = true) {
  const [variant] = await sql<{ id: string; locationId: string }[]>`
    SELECT variant.id, balance.location_id AS "locationId"
    FROM variants variant
    JOIN products product ON product.id = variant.product_id
    JOIN inventory_balances balance ON balance.variant_id = variant.id
    WHERE variant.status = 'published' AND product.status = 'published'
      AND balance.physical_quantity - balance.blocked_quantity >= 2
    ORDER BY variant.id, balance.location_id
    LIMIT 1
  `
  if (!variant) throw new Error('The recovery catalog has no purchasable variant')
  const [cart] = await sql<{ id: string; version: number }[]>`
    INSERT INTO carts (public_token_hash, expires_at)
    VALUES (${`recovery:${uuid()}`}, now() + interval '1 day')
    RETURNING id, version
  `
  await sql`INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES (${cart!.id}, ${variant.id}, 1)`

  const rates = await quoteCartShipping(cart!.id, destination())
  const rate =
    shippingMethod === 'recogida'
      ? rates.find((candidate) => candidate.serviceCode === 'WAREHOUSE-PICKUP')
      : rates.find((candidate) => !['own_delivery', 'pickup'].includes(candidate.profile))
  if (!rate) throw new Error(`No ${shippingMethod} recovery rate is available`)

  const guestToken = uuid('guest-token')
  const marker = testData.token('customer').slice(0, 16)
  const address = {
    recipientName: 'Comprador recuperación',
    companyName: '',
    taxId: '',
    line1: 'Calle de pruebas 1',
    line2: '',
    postalCode: '46800',
    city: 'Xàtiva',
    region: 'Valencia',
    countryCode: 'ES' as const,
    phone: '600000000',
    instructions: ''
  }
  const input: CreateOrderInput = {
    customer: {
      name: 'Comprador recuperación',
      company: '',
      nif: '',
      email: `${marker}@integration.invalid`,
      phone: '600000000'
    },
    shippingAddress: address,
    billingAddress: address,
    shippingMethod,
    shippingServiceCode: rate.serviceCode,
    expectedPricingVersion: rate.pricingVersion,
    expectedTotalGrossCents: rate.totalGrossCents,
    paymentMethod: 'tarjeta',
    cartId: cart!.id,
    cartVersion: cart!.version,
    idempotencyKey: uuid('order-idempotency'),
    guestToken,
    termsAccepted: true,
    marketingConsent: false,
    newsletterSecrets: { tokenPepper: 'recovery-pepper', encryptionKey },
    correlationId: uuid('create-correlation')
  }
  const order = await createOrder(input)
  if (capture) {
    await confirmMockPayment({
      publicNumber: order.id,
      guestToken,
      method: 'tarjeta',
      correlationId: uuid('capture-correlation')
    })
  }
  const [internal] = await sql<{ id: string }[]>`SELECT id FROM orders WHERE public_number = ${order.id}`
  return {
    id: internal!.id,
    publicNumber: order.id,
    guestToken,
    variantId: variant.id,
    locationId: variant.locationId,
    serviceCode: rate.serviceCode
  }
}

async function capturedOrder(shippingMethod: 'recogida' | 'envio' = 'recogida') {
  return orderFixture(shippingMethod, true)
}

function workerEnvironment(overrides: NodeJS.ProcessEnv = {}) {
  return {
    ...process.env,
    DATABASE_URL: connection,
    APP_ENV: 'test',
    APP_BASE_URL: 'http://127.0.0.1:3000',
    AUTH_ENCRYPTION_KEY: encryptionKey,
    PAYMENT_PROVIDER: 'mock',
    ...overrides
  }
}

async function runWorker(script: string, aggregateId: string, environment: NodeJS.ProcessEnv) {
  await execFileAsync('node_modules/.bin/tsx', [script, '--once', `--aggregate-id=${aggregateId}`], {
    cwd: process.cwd(),
    env: environment,
    timeout: 15_000
  })
}

async function unavailablePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a loopback port')
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

async function smtpServer(port: number) {
  let accepted = 0
  const server = createNetServer((socket) => {
    let buffer = ''
    let dataMode = false
    socket.setEncoding('utf8')
    socket.write('220 recovery.smtp ESMTP\r\n')
    socket.on('data', (chunk) => {
      buffer += chunk
      while (true) {
        if (dataMode) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0) return
          buffer = buffer.slice(end + 5)
          dataMode = false
          accepted += 1
          socket.end(`250 2.0.0 queued-${accepted}\r\n`)
          return
        }
        const end = buffer.indexOf('\r\n')
        if (end < 0) return
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const command = line.split(' ', 1)[0]!.toUpperCase()
        if (command === 'EHLO' || command === 'HELO') socket.write('250-recovery.smtp\r\n250 PIPELINING\r\n')
        else if (command === 'MAIL' || command === 'RCPT' || command === 'RSET') socket.write('250 2.1.0 OK\r\n')
        else if (command === 'DATA') {
          dataMode = true
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n')
        } else if (command === 'QUIT') {
          socket.end('221 2.0.0 Bye\r\n')
        } else socket.write('250 2.0.0 OK\r\n')
      }
    })
    socket.on('error', () => undefined)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  return {
    accepted: () => accepted,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  }
}

async function beplyRecoveryServer() {
  let available = false
  let failureStatus = 503
  let responseDelayMs = 0
  let requests = 0
  const failureStatuses: number[] = []
  let invoicesCreated = 0
  const server = createServer(async (request, response) => {
    requests += 1
    if (responseDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, responseDelayMs))
    if (!available) {
      failureStatuses.push(failureStatus)
      response.writeHead(failureStatus, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'simulated outage' }))
      return
    }
    const path = request.url ?? ''
    if (request.method === 'GET' && path.startsWith('/api/3/contactos?')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end('[]')
    } else if (request.method === 'POST' && path === '/api/3/crearFacturaCliente') {
      invoicesCreated += 1
      response
        .writeHead(201, { 'content-type': 'application/json' })
        .end(JSON.stringify({ idfactura: 7001, codigo: 'NE-7001' }))
    } else if (
      request.method === 'POST' &&
      ['/api/3/clientes', '/api/3/contactos', '/api/3/pagarFacturaCliente/7001'].includes(path)
    ) {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    } else if (request.method === 'GET' && path.startsWith('/api/3/exportarFacturaCliente/7001?')) {
      response.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF-1.4\nrecovery\n%%EOF')
    } else {
      response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not_found"}')
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Beply recovery server has no port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/3`,
    setFailureStatus(status: number) {
      failureStatus = status
    },
    setResponseDelay(delayMs: number) {
      responseDelayMs = delayMs
    },
    restore() {
      available = true
    },
    failureStatuses: () => [...failureStatuses],
    invoicesCreated: () => invoicesCreated,
    requests: () => requests,
    close: () => closeServer(server)
  }
}

async function closeServer(server: Server) {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

async function postgresCutProxy(targetConnection: string) {
  const target = new URL(targetConnection)
  const sockets = new Set<Socket>()
  const server = createNetServer((client) => {
    const upstream = createConnection({
      host: target.hostname === 'localhost' ? '127.0.0.1' : target.hostname,
      port: Number(target.port || 5432)
    })
    sockets.add(client)
    sockets.add(upstream)
    client.on('error', () => undefined)
    upstream.on('error', () => undefined)
    client.on('close', () => sockets.delete(client))
    upstream.on('close', () => sockets.delete(upstream))
    client.pipe(upstream)
    upstream.pipe(client)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('PostgreSQL cut proxy has no port')
  const proxyUrl = new URL(targetConnection)
  proxyUrl.hostname = '127.0.0.1'
  proxyUrl.port = String(address.port)
  return {
    connection: proxyUrl.toString(),
    cut() {
      for (const socket of sockets) socket.destroy()
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  }
}

async function expectCapturedExactlyOnce(orderId: string, variantId: string, locationId: string) {
  const [state] = await sql<
    Array<{
      orderStatus: string
      paymentStatus: string
      inventoryStatus: string
      paymentEvents: number
      allocations: number
      allocatedReservations: number
    }>
  >`
    SELECT orders.order_status AS "orderStatus", orders.payment_status AS "paymentStatus",
           orders.inventory_status AS "inventoryStatus",
      (SELECT count(*) FROM payment_events event
       JOIN payment_intents intent ON intent.id = event.payment_intent_id
       WHERE intent.order_id = orders.id AND event.status = 'captured')::int AS "paymentEvents",
      (SELECT count(*) FROM inventory_movements movement
       WHERE movement.reference_id = orders.id AND movement.variant_id = ${variantId}
         AND movement.location_id = ${locationId} AND movement.movement_type = 'allocate')::int AS allocations,
      (SELECT count(*) FROM inventory_reservations reservation
       WHERE reservation.order_id = orders.id AND reservation.status = 'allocated')::int AS "allocatedReservations"
    FROM orders WHERE orders.id = ${orderId}
  `
  expect(state).toEqual({
    orderStatus: 'confirmed',
    paymentStatus: 'captured',
    inventoryStatus: 'allocated',
    paymentEvents: 1,
    allocations: 1,
    allocatedReservations: 1
  })
}

beforeEach(async (context) => {
  testData = deterministicTestData(`integration:provider-recovery:${context.task.id}:${context.task.name}`)
  database = await isolatedPostgresDatabase(testData.namespace)
  connection = database.connection
  process.env.DATABASE_URL = connection
  process.env.APP_ENV = 'test'
  delete process.env.NETECO_TEST_CARRIER_FAILURE
  await closeDatabase()
  await closeRedis()
  sql = database.sql
})

afterEach(async () => {
  try {
    delete process.env.NETECO_TEST_CARRIER_FAILURE
    await closeRedis()
    await closeDatabase()
    await database.dispose()
  } finally {
    process.env.DATABASE_URL = baseConnection
    if (baseRedisUrl === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = baseRedisUrl
  }
})

describe('provider outage recovery', () => {
  it('retries Beply 503 and 429 outages with durable backoff and issues one invoice after provider recovery', async () => {
    const order = await capturedOrder()
    const beply = await beplyRecoveryServer()
    const beplyEnvironment = workerEnvironment({
      INVOICE_PROVIDER: 'beply',
      BEPLY_BASE_URL: beply.baseUrl,
      BEPLY_API_TOKEN: 'recovery-token',
      BEPLY_INVOICE_SERIES: 'NE',
      BEPLY_CORRECTIVE_SERIES: 'NR',
      BEPLY_TAX_CODE_0: 'IVA0',
      BEPLY_TAX_CODE_10: 'IVA10',
      BEPLY_TAX_CODE_21: 'IVA21',
      BEPLY_PAYMENT_CODE_REDSYS: 'REDSYS',
      BEPLY_PAYMENT_CODE_BANK_TRANSFER: 'TRANSFER',
      BEPLY_COMPANY_ID: '1'
    })
    try {
      await runWorker('scripts/invoice-worker.ts', order.id, beplyEnvironment)

      const [failed] = await sql<{ status: string; attempts: number; code: string; invoiceStatus: string }[]>`
        SELECT event.status, event.attempts, event.last_error_code AS code, invoice.status AS "invoiceStatus"
        FROM outbox_events event
        JOIN invoices invoice ON invoice.order_id = event.aggregate_id AND invoice.kind = 'invoice'
        WHERE event.aggregate_id = ${order.id} AND event.event_type = 'invoice.issue.requested'
      `
      expect(failed).toEqual({ status: 'retry', attempts: 1, code: 'beply_provider', invoiceStatus: 'failed' })
      await expectCapturedExactlyOnce(order.id, order.variantId, order.locationId)

      await sql`
        UPDATE outbox_events SET available_at = now()
        WHERE aggregate_id = ${order.id} AND event_type = 'invoice.issue.requested'
      `
      beply.setFailureStatus(429)
      await runWorker('scripts/invoice-worker.ts', order.id, beplyEnvironment)
      const [rateLimited] = await sql<
        Array<{
          status: string
          attempts: number
          code: string
          message: string
          backoffActive: boolean
          invoiceStatus: string
        }>
      >`
        SELECT event.status, event.attempts, event.last_error_code AS code,
          event.last_error_message AS message, event.available_at > now() AS "backoffActive",
          invoice.status AS "invoiceStatus"
        FROM outbox_events event
        JOIN invoices invoice ON invoice.order_id = event.aggregate_id AND invoice.kind = 'invoice'
        WHERE event.aggregate_id = ${order.id} AND event.event_type = 'invoice.issue.requested'
      `
      expect(rateLimited).toEqual({
        status: 'retry',
        attempts: 2,
        code: 'beply_provider',
        message: 'Beply POST clientes failed (429)',
        backoffActive: true,
        invoiceStatus: 'failed'
      })
      expect(beply.failureStatuses()).toEqual([503, 429])
      await expectCapturedExactlyOnce(order.id, order.variantId, order.locationId)

      await sql`
        UPDATE outbox_events SET available_at = now()
        WHERE aggregate_id = ${order.id} AND event_type = 'invoice.issue.requested'
      `
      beply.restore()
      await runWorker('scripts/invoice-worker.ts', order.id, beplyEnvironment)
      const [recovered] = await sql<
        Array<{ status: string; attempts: number; invoiceStatus: string; invoices: number; issuedEvents: number }>
      >`
        SELECT event.status, event.attempts, invoice.status AS "invoiceStatus",
          (SELECT count(*) FROM invoices WHERE order_id = ${order.id} AND kind = 'invoice')::int AS invoices,
          (SELECT count(*) FROM order_events WHERE order_id = ${order.id}
            AND event_type = 'invoice.issued')::int AS "issuedEvents"
        FROM outbox_events event
        JOIN invoices invoice ON invoice.order_id = event.aggregate_id AND invoice.kind = 'invoice'
        WHERE event.aggregate_id = ${order.id} AND event.event_type = 'invoice.issue.requested'
      `
      expect(recovered).toEqual({
        status: 'completed',
        attempts: 3,
        invoiceStatus: 'issued',
        invoices: 1,
        issuedEvents: 1
      })
      expect(beply.invoicesCreated()).toBe(1)
      expect(beply.failureStatuses()).toEqual([503, 429])
      await expectCapturedExactlyOnce(order.id, order.variantId, order.locationId)
    } finally {
      await beply.close()
    }
  })

  it('turns loopback latency above the Beply timeout into a retryable transport error and recovers locally', async () => {
    const beply = await beplyRecoveryServer()
    beply.restore()
    beply.setResponseDelay(1_100)
    const provider = new BeplyInvoiceProvider({
      baseUrl: beply.baseUrl,
      token: 'recovery-token',
      invoiceSeries: 'NE',
      correctiveSeries: 'NR',
      taxCode0: 'IVA0',
      taxCode10: 'IVA10',
      taxCode21: 'IVA21',
      paymentCodeRedsys: 'REDSYS',
      paymentCodeBankTransfer: 'TRANSFER',
      companyId: '1',
      timeoutMs: 1_000
    })
    try {
      const paidOn = '2026-08-18T12:00:00.000Z'
      const timeoutFailure = await provider.markPaid('7001', paidOn, 'redsys').catch((error) => error)
      expect(timeoutFailure).toBeInstanceOf(BeplyError)
      expect(timeoutFailure).toMatchObject({
        status: 0,
        category: 'transport',
        retryable: true
      })
      expect(beply.requests()).toBe(1)

      beply.setResponseDelay(0)
      await expect(provider.markPaid('7001', paidOn, 'redsys')).resolves.toBeUndefined()
      expect(beply.requests()).toBe(2)
    } finally {
      await beply.close()
    }
  })

  it('retries an SMTP outage and records one delivery after email recovery', async () => {
    const order = await capturedOrder()
    await sql`
      UPDATE outbox_events SET status = 'completed', completed_at = now()
      WHERE aggregate_id = ${order.id} AND event_type = 'order.created'
    `
    const [event] = await sql<{ id: string }[]>`
      SELECT id FROM outbox_events
      WHERE aggregate_id = ${order.id} AND event_type = 'order.confirmed'
    `
    const port = await unavailablePort()
    await runWorker(
      'scripts/outbox-worker.ts',
      order.id,
      workerEnvironment({
        EMAIL_PROVIDER: 'smtp',
        EMAIL_FROM: 'NETECO <no-reply@integration.invalid>',
        SMTP_HOST: '127.0.0.1',
        SMTP_ALLOWED_HOSTS: '127.0.0.1',
        EMAIL_ALLOWED_RECIPIENTS: '*@integration.invalid',
        SMTP_PORT: String(port),
        SMTP_SECURE: 'false',
        MARKETING_EMAIL_PROVIDER: 'log'
      })
    )
    const [failed] = await sql<{ status: string; attempts: number; code: string; deliveries: number }[]>`
      SELECT event.status, event.attempts, event.last_error_code AS code,
        count(delivery.id)::int AS deliveries
      FROM outbox_events event
      LEFT JOIN communication_deliveries delivery ON delivery.outbox_event_id = event.id
      WHERE event.id = ${event!.id}
      GROUP BY event.id
    `
    expect(failed).toEqual({ status: 'retry', attempts: 1, code: 'email_delivery_failed', deliveries: 0 })
    await expectCapturedExactlyOnce(order.id, order.variantId, order.locationId)

    await sql`UPDATE outbox_events SET available_at = now() WHERE id = ${event!.id}`
    const smtp = await smtpServer(port)
    try {
      await runWorker(
        'scripts/outbox-worker.ts',
        order.id,
        workerEnvironment({
          EMAIL_PROVIDER: 'smtp',
          EMAIL_FROM: 'NETECO <no-reply@integration.invalid>',
          SMTP_HOST: '127.0.0.1',
          SMTP_ALLOWED_HOSTS: '127.0.0.1',
          EMAIL_ALLOWED_RECIPIENTS: '*@integration.invalid',
          SMTP_PORT: String(port),
          SMTP_SECURE: 'false',
          MARKETING_EMAIL_PROVIDER: 'log'
        })
      )
      expect(smtp.accepted()).toBe(1)
    } finally {
      await smtp.close()
    }
    const [recovered] = await sql<{ status: string; attempts: number; deliveries: number }[]>`
      SELECT event.status, event.attempts, count(delivery.id)::int AS deliveries
      FROM outbox_events event
      LEFT JOIN communication_deliveries delivery ON delivery.outbox_event_id = event.id
      WHERE event.id = ${event!.id}
      GROUP BY event.id
    `
    expect(recovered).toEqual({ status: 'completed', attempts: 2, deliveries: 1 })
    await expectCapturedExactlyOnce(order.id, order.variantId, order.locationId)
  })

  it('rolls back carrier effects and creates one shipment after recovery', async () => {
    const order = await capturedOrder('envio')
    process.env.NETECO_TEST_CARRIER_FAILURE = 'createShipment'
    await expect(
      createOrderShipment({
        publicNumber: order.publicNumber,
        serviceCode: order.serviceCode,
        actorId: uuid('warehouse-actor'),
        correlationId: uuid('failed-shipment-correlation')
      })
    ).rejects.toThrow('Simulated carrier outage')
    const [failed] = await sql<{ shipments: number; status: string; payment: string }[]>`
      SELECT count(shipment.id)::int AS shipments, orders.order_status AS status,
             orders.payment_status AS payment
      FROM orders
      LEFT JOIN fulfillments fulfillment ON fulfillment.order_id = orders.id
      LEFT JOIN shipments shipment ON shipment.fulfillment_id = fulfillment.id
      WHERE orders.id = ${order.id}
      GROUP BY orders.id
    `
    expect(failed).toEqual({ shipments: 0, status: 'confirmed', payment: 'captured' })

    delete process.env.NETECO_TEST_CARRIER_FAILURE
    const input = {
      publicNumber: order.publicNumber,
      serviceCode: order.serviceCode,
      actorId: uuid('warehouse-actor'),
      correlationId: uuid('recovered-shipment-correlation')
    }
    const created = await createOrderShipment(input)
    const duplicate = await createOrderShipment(input)
    expect(created.duplicate).toBe(false)
    expect(duplicate.duplicate).toBe(true)
    const [recovered] = await sql<{ shipments: number; documents: number; shippedEvents: number }[]>`
      SELECT count(DISTINCT shipment.id)::int AS shipments,
             count(DISTINCT document.shipment_id)::int AS documents,
             (SELECT count(*) FROM order_events WHERE order_id = orders.id
               AND event_type = 'shipment.created')::int AS "shippedEvents"
      FROM orders
      JOIN fulfillments fulfillment ON fulfillment.order_id = orders.id
      LEFT JOIN shipments shipment ON shipment.fulfillment_id = fulfillment.id
      LEFT JOIN shipment_documents document ON document.shipment_id = shipment.id
      WHERE orders.id = ${order.id}
      GROUP BY orders.id
    `
    expect(recovered).toEqual({ shipments: 1, documents: 1, shippedEvents: 1 })
    await expectCapturedExactlyOnce(order.id, order.variantId, order.locationId)
  })

  it('keeps checkout atomic while Redis is unavailable and reconnects afterward', async () => {
    const port = await unavailablePort()
    process.env.REDIS_URL = `redis://127.0.0.1:${port}/0`
    await closeRedis()
    await expect(useRedis().connect()).rejects.toThrow()

    const order = await capturedOrder()
    await expectCapturedExactlyOnce(order.id, order.variantId, order.locationId)

    await closeRedis()
    if (baseRedisUrl === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = baseRedisUrl
    const recoveredRedis = useRedis()
    await recoveredRedis.connect()
    expect(await recoveredRedis.ping()).toBe('PONG')
  })

  it('rolls back a severed DB transaction, reconnects, and captures exactly once', async () => {
    const order = await orderFixture('recogida', false)
    const [intent] = await sql<{ id: string }[]>`SELECT id FROM payment_intents WHERE order_id = ${order.id}`
    const proxy = await postgresCutProxy(connection)
    const client = spawn('node_modules/.bin/tsx', ['tests/fixtures/postgres-failover-client.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: proxy.connection,
        PAYMENT_INTENT_ID: intent!.id,
        CORRELATION_ID: uuid('failover-correlation')
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    await new Promise<void>((resolve, reject) => {
      let output = ''
      client.once('error', reject)
      client.stderr!.once('data', (chunk) => {
        if (!output.includes('READY')) reject(new Error(String(chunk)))
      })
      client.stdout!.on('data', (chunk) => {
        output += String(chunk)
        if (output.includes('READY')) resolve()
      })
    })
    proxy.cut()
    client.stdin!.write('\n')
    const exitCode = await new Promise<number | null>((resolve) => client.once('close', resolve))
    expect(exitCode).not.toBe(0)

    const [rolledBack] = await sql<{ status: string; partialEvents: number }[]>`
      SELECT intent.status,
        (SELECT count(*) FROM payment_events event
         WHERE event.payment_intent_id = intent.id AND event.provider_event_id = 'simulated-failover')::int AS "partialEvents"
      FROM payment_intents intent WHERE intent.id = ${intent!.id}
    `
    expect(rolledBack).toEqual({ status: 'initiated', partialEvents: 0 })
    const app = postgres(proxy.connection, { max: 1, connect_timeout: 5 })
    const [reconnected] = await app<{ value: number }[]>`SELECT 1 AS value`
    expect(reconnected?.value).toBe(1)
    await app.end({ timeout: 5 })
    await proxy.close()

    await confirmMockPayment({
      publicNumber: order.publicNumber,
      guestToken: order.guestToken,
      method: 'tarjeta',
      correlationId: uuid('post-failover-capture')
    })
    await confirmMockPayment({
      publicNumber: order.publicNumber,
      guestToken: order.guestToken,
      method: 'tarjeta',
      correlationId: uuid('post-failover-capture-replay')
    })
    await expectCapturedExactlyOnce(order.id, order.variantId, order.locationId)
  })
})
