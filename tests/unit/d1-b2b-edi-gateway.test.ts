import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import {
  registerEdiClient,
  createEdiApiKey,
  authenticateEdiRequest,
  processEdiOrderPlacement,
  getEdiMonitoringSummary,
  revokeEdiApiKey,
  computeEdiHmacSignature
} from '../../workers/b2b/edi-gateway'

const NOW = '2026-10-29T10:00:00Z'
const COMPANY_ID = '40000000-0000-4000-8000-000000000001'
const CUSTOMER_ID = '30000000-0000-4000-8000-000000000001'
const IDENTITY_ID = '10000000-0000-4000-8000-000000000001'

describe('CUS-030: Key B2B Client EDI & Versioned API Gateway', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let publication: Awaited<ReturnType<typeof provisionPublicationValidityFixture>>

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    sqlite = await openMigratedDatabase()
    sqlite.limits.exprDepth = 100
    sqlite.exec(await readFile('db/d1/migrations/0108_b2b_shared_lists_edi_scoring.sql', 'utf8'))
    database = d1OverSqlite(sqlite)
    seedInventoryFixture(sqlite)
    publication = await provisionPublicationValidityFixture(database, {
      productIds: ['p-1', 'p-2'],
      now: NOW
    })

    // Seed customer and company
    sqlite.prepare('INSERT INTO customers(id, created_at, updated_at) VALUES (?, ?, ?)').run(CUSTOMER_ID, NOW, NOW)
    sqlite
      .prepare(
        `INSERT INTO identities(id, email, password_hash, email_verified_at, status, customer_id, created_at, updated_at)
         VALUES (?, 'edi-client@example.invalid', 'synthetic', ?, 'active', ?, ?, ?)`
      )
      .run(IDENTITY_ID, NOW, CUSTOMER_ID, NOW, NOW)
    sqlite
      .prepare(
        `INSERT INTO companies(id, customer_id, legal_name, tax_id, country_code, status, created_at, updated_at)
         VALUES (?, ?, 'Acme Industrial Supplies S.L.', 'B12345678', 'ES', 'approved', ?, ?)`
      )
      .run(COMPANY_ID, CUSTOMER_ID, NOW, NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('registra un cliente EDI con soporte de contratos versionados y límites', async () => {
    const client = await registerEdiClient(database, {
      companyId: COMPANY_ID,
      customerId: CUSTOMER_ID,
      name: 'Acme ERP Connector',
      environment: 'sandbox',
      rateLimitPerMinute: 120,
      dailyRequestQuota: 10000,
      supportedVersions: ['2026-01', '2026-10']
    })

    expect(client.id).toBeDefined()
    expect(client.name).toBe('Acme ERP Connector')
    expect(client.environment).toBe('sandbox')
    expect(client.rateLimitPerMinute).toBe(120)
    expect(client.dailyRequestQuota).toBe(10000)
    expect(client.supportedVersions).toEqual(['2026-01', '2026-10'])
  })

  it('emite claves API y secretos HMAC, y valida firmas criptográficas', async () => {
    const client = await registerEdiClient(database, {
      companyId: COMPANY_ID,
      customerId: CUSTOMER_ID,
      name: 'Acme EDI',
      environment: 'sandbox'
    })

    const keyResult = await createEdiApiKey(database, {
      clientId: client.id,
      name: 'Producción Clave 1'
    })

    expect(keyResult.keyId).toBeDefined()
    expect(keyResult.apiKey).toMatch(/^neteco_edi_/)
    expect(keyResult.hmacSecret).toBeDefined()

    // Sign payload
    const payload = JSON.stringify({ action: 'ping' })
    const timestamp = Math.floor(new Date(NOW).getTime() / 1000).toString()
    const signature = await computeEdiHmacSignature(keyResult.hmacSecret, timestamp, payload)

    const authResult = await authenticateEdiRequest(database, {
      apiKey: keyResult.apiKey,
      timestamp,
      signature,
      payload,
      now: NOW
    })

    expect(authResult.authenticated).toBe(true)
    expect(authResult.client?.id).toBe(client.id)
  })

  it('rechaza firmas manipuladas o con timestamp desfasado > 300s', async () => {
    const client = await registerEdiClient(database, {
      companyId: COMPANY_ID,
      customerId: CUSTOMER_ID,
      name: 'Acme Test'
    })
    const key = await createEdiApiKey(database, { clientId: client.id, name: 'Key' })

    const payload = JSON.stringify({ test: 1 })
    const oldTimestamp = (Math.floor(new Date(NOW).getTime() / 1000) - 301).toString()
    const signature = await computeEdiHmacSignature(key.hmacSecret, oldTimestamp, payload)

    const replayResult = await authenticateEdiRequest(database, {
      apiKey: key.apiKey,
      timestamp: oldTimestamp,
      signature,
      payload,
      now: NOW
    })
    expect(replayResult.authenticated).toBe(false)
    expect(replayResult.code).toBe('timestamp_out_of_range')

    // Tampered payload
    const nowTimestamp = Math.floor(new Date(NOW).getTime() / 1000).toString()
    const tamperedResult = await authenticateEdiRequest(database, {
      apiKey: key.apiKey,
      timestamp: nowTimestamp,
      signature: 'invalid_sig',
      payload,
      now: NOW
    })
    expect(tamperedResult.authenticated).toBe(false)
    expect(tamperedResult.code).toBe('invalid_signature')
  })

  it('procesa pedidos en modo Sandbox simulando confirmación sin impacto en stock real', async () => {
    const client = await registerEdiClient(database, {
      companyId: COMPANY_ID,
      customerId: CUSTOMER_ID,
      name: 'Sandbox Client',
      environment: 'sandbox'
    })

    const variantId = 'v-1-1'
    const orderInput = {
      orderReference: 'PO-2026-999',
      lines: [{ variantId, quantity: 10, expectedUnitGrossCents: 2000 }],
      shippingAddress: {
        street: 'Polígono Industrial Las Palmeras 12',
        postalCode: '46001',
        city: 'Valencia',
        countryCode: 'ES'
      },
      contactEmail: 'edi-purchasing@acme.invalid'
    }

    const res = await processEdiOrderPlacement(database, {
      client,
      contractVersion: '2026-10',
      idempotencyKey: 'idemp-sandbox-01',
      input: orderInput,
      now: NOW
    })

    expect(res.status).toBe('sandbox_accepted')
    expect(res.environment).toBe('sandbox')
    expect(res.totalGrossCents).toBeGreaterThan(0)
    expect(res.lines[0].status).toBe('confirmed')
    expect(res.estimatedDeliveryDate).toBeDefined()
  })

  it('respeta la idempotencia exacta y detecta conflictos por modificación de payload', async () => {
    const client = await registerEdiClient(database, {
      companyId: COMPANY_ID,
      customerId: CUSTOMER_ID,
      name: 'Idempotency Client',
      environment: 'sandbox'
    })

    const variantId = 'v-1-1'
    const orderInput = {
      orderReference: 'PO-IDEM-1',
      lines: [{ variantId, quantity: 2 }],
      shippingAddress: { street: 'Calle Mayor 1', postalCode: '28001', city: 'Madrid', countryCode: 'ES' },
      contactEmail: 'orders@example.invalid'
    }

    const first = await processEdiOrderPlacement(database, {
      client,
      contractVersion: '2026-10',
      idempotencyKey: 'key-12345',
      input: orderInput,
      now: NOW
    })
    expect(first.idempotentReplay).toBe(false)

    // Replay with identical input
    const replay = await processEdiOrderPlacement(database, {
      client,
      contractVersion: '2026-10',
      idempotencyKey: 'key-12345',
      input: orderInput,
      now: NOW
    })
    expect(replay.idempotentReplay).toBe(true)
    expect(replay.ediOrderId).toBe(first.ediOrderId)

    // Conflict with changed payload under same idempotency key
    await expect(
      processEdiOrderPlacement(database, {
        client,
        contractVersion: '2026-10',
        idempotencyKey: 'key-12345',
        input: { ...orderInput, orderReference: 'PO-IDEM-CHANGED' },
        now: NOW
      })
    ).rejects.toThrow(/idempotency_conflict/)
  })

  it('monitoriza peticiones, latencias y consumo de cuota por cliente', async () => {
    const client = await registerEdiClient(database, {
      companyId: COMPANY_ID,
      customerId: CUSTOMER_ID,
      name: 'Monitored Client',
      dailyRequestQuota: 100
    })

    // Process an order
    const variantId = 'v-1-1'
    await processEdiOrderPlacement(database, {
      client,
      contractVersion: '2026-10',
      idempotencyKey: 'req-1',
      input: {
        orderReference: 'PO-MON-1',
        lines: [{ variantId, quantity: 1 }],
        shippingAddress: { street: 'C/ A 1', postalCode: '08001', city: 'Barcelona', countryCode: 'ES' },
        contactEmail: 'mon@example.invalid'
      },
      now: NOW
    })

    const summary = await getEdiMonitoringSummary(database, client.id, NOW)
    expect(summary.clientId).toBe(client.id)
    expect(summary.requestsToday).toBe(1)
    expect(summary.quotaRemaining).toBe(99)
    expect(summary.successCount).toBe(1)
    expect(summary.recentLogs).toHaveLength(1)
  })

  it('permite revocar claves API de clientes comprometidas', async () => {
    const client = await registerEdiClient(database, {
      companyId: COMPANY_ID,
      customerId: CUSTOMER_ID,
      name: 'Client Revoke'
    })
    const key = await createEdiApiKey(database, { clientId: client.id, name: 'ToRevoke' })

    await revokeEdiApiKey(database, key.keyId, NOW)

    const payload = '{}'
    const ts = Math.floor(new Date(NOW).getTime() / 1000).toString()
    const sig = await computeEdiHmacSignature(key.hmacSecret, ts, payload)

    const check = await authenticateEdiRequest(database, {
      apiKey: key.apiKey,
      timestamp: ts,
      signature: sig,
      payload,
      now: NOW
    })
    expect(check.authenticated).toBe(false)
    expect(check.code).toBe('key_revoked')
  })
})
