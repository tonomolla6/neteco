import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  buildMinimizedWebhookPayload,
  signOutboundWebhook,
  verifyOutboundWebhookSignature,
  type CreateWebhookSubscriptionInput
} from '../../shared/outbound-webhooks'
import {
  createWebhookSubscription,
  dispatchWebhookDeliveriesBatch,
  getWebhookDeliveryLogs,
  listWebhookDeliveries,
  listWebhookSubscriptions,
  queueWebhookEvent,
  replayDeadLetterDelivery,
  rotateWebhookSubscriptionSecret
} from '../../workers/integrations/outbound-webhooks'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const CUSTOMER_ID = '10000000-0000-4000-8000-000000000002'

async function setupTestDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0138_integration_sandbox_faults_webhooks.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Rol administrador'),
      ('customer', 'Cliente', 'Rol cliente');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('integrations.manage', 'integrations', 'manage', 'Gestión de integraciones');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'integrations.manage');

    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
      ('${CUSTOMER_ID}', 'customer@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('20000000-0000-4000-8000-000000000001', '${ADMIN_ID}', 1, 1, '${NOW}', '2099-12-31T23:59:59Z'),
      ('20000000-0000-4000-8000-000000000002', '${CUSTOMER_ID}', 1, 1, '${NOW}', '2099-12-31T23:59:59Z');

    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}'),
      ('${CUSTOMER_ID}', 'customer', '${NOW}');
  `)

  return sqlite
}

describe('INT-021: Webhooks salientes para clientes', () => {
  let sqlite: DatabaseSync

  beforeEach(async () => {
    sqlite = await setupTestDb()
  })

  afterEach(() => {
    sqlite.close()
  })

  describe('Firma HMAC y rotación de secretos con cero tiempo de inactividad', () => {
    it('firma payload con HMAC SHA-256 y verifica con tiempo seguro', () => {
      const secret = 'sec_0123456789abcdef0123456789abcdef'
      const payload = JSON.stringify({ event: 'order.paid', id: 'ord_123' })

      const signature = signOutboundWebhook(payload, secret)
      expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/)

      const valid = verifyOutboundWebhookSignature({
        payload,
        signature,
        primarySecret: secret
      })
      expect(valid).toBe(true)

      const invalid = verifyOutboundWebhookSignature({
        payload: payload + 'tampered',
        signature,
        primarySecret: secret
      })
      expect(invalid).toBe(false)
    })

    it('permite verificar tanto con secreto primario como con el secundario durante rotación', () => {
      const oldSecret = 'sec_old_0123456789abcdef0123456789a'
      const newSecret = 'sec_new_0123456789abcdef0123456789b'
      const payload = JSON.stringify({ event: 'invoice.issued', id: 'inv_456' })

      const signedWithOld = signOutboundWebhook(payload, oldSecret)

      // Verificación con rotación activa y ventana de gracia
      const validOld = verifyOutboundWebhookSignature({
        payload,
        signature: signedWithOld,
        primarySecret: newSecret,
        secondarySecret: oldSecret,
        secondarySecretExpiresAt: '2026-10-30T12:00:00Z',
        now: NOW
      })
      expect(validOld).toBe(true)

      // Verificación falla si la ventana de gracia del secreto secundario ha expirado
      const expiredOld = verifyOutboundWebhookSignature({
        payload,
        signature: signedWithOld,
        primarySecret: newSecret,
        secondarySecret: oldSecret,
        secondarySecretExpiresAt: '2026-10-28T12:00:00Z',
        now: NOW
      })
      expect(expiredOld).toBe(false)
    })
  })

  describe('Payload minimizado y versionado', () => {
    it('genera payload estrictamente minimizado y versionado sin PII sensible', () => {
      const rawOrder = {
        orderId: 'ord-777',
        status: 'paid',
        customerName: 'Cliente Privado S.L.',
        customerTaxId: 'B12345678',
        internalApiKey: 'super-secret-key-internal',
        paymentMethod: 'redsys',
        totalCents: 4500,
        currency: 'EUR',
        linesCount: 2,
        cardPan: '411111******1111'
      }

      const minimized = buildMinimizedWebhookPayload('order.paid', rawOrder, 'v1', NOW)

      expect(minimized.version).toBe('v1')
      expect(minimized.event).toBe('order.paid')
      expect(minimized.occurred_at).toBe(NOW)
      expect(minimized.data).toEqual({
        order_id: 'ord-777',
        status: 'paid',
        total_cents: 4500,
        currency: 'EUR',
        lines_count: 2
      })

      // Asegura que no viajan claves internas ni PAN de tarjeta
      const serialized = JSON.stringify(minimized)
      expect(serialized).not.toContain('super-secret-key-internal')
      expect(serialized).not.toContain('cardPan')
    })
  })

  describe('Ciclo de vida de suscripciones y CAS', () => {
    it('crea suscripción válida con URL HTTPS y secreto autogenerado', async () => {
      const db = d1OverSqlite(sqlite)
      const input: CreateWebhookSubscriptionInput = {
        url: 'https://cliente.empresa.es/webhooks/neteco',
        topics: ['order.paid', 'order.fulfilled'],
        description: 'Suscripción ERP almacén'
      }

      const sub = await createWebhookSubscription(db, input, {
        ownerId: CUSTOMER_ID,
        now: NOW
      })

      expect(sub.id).toBeDefined()
      expect(sub.url).toBe(input.url)
      expect(sub.topics).toEqual(input.topics)
      expect(sub.version).toBe(1)
      expect(sub.primarySecret).toMatch(/^[0-9a-f]{32,}$/)
      expect(sub.secondarySecret).toBeNull()

      const list = await listWebhookSubscriptions(db, CUSTOMER_ID)
      expect(list).toHaveLength(1)
      expect(list[0]!.id).toBe(sub.id)
    })

    it('rechaza URLs sin HTTPS', async () => {
      const db = d1OverSqlite(sqlite)
      const input: CreateWebhookSubscriptionInput = {
        url: 'http://inseguro.empresa.es/webhooks',
        topics: ['order.paid'],
        description: 'No seguro'
      }

      await expect(
        createWebhookSubscription(db, input, {
          ownerId: CUSTOMER_ID,
          now: NOW
        })
      ).rejects.toThrowError(/https_required/)
    })

    it('rota secreto preservando el anterior con periodo de gracia y CAS', async () => {
      const db = d1OverSqlite(sqlite)
      const sub = await createWebhookSubscription(
        db,
        {
          url: 'https://cliente.empresa.es/webhooks',
          topics: ['order.paid'],
          description: 'Suscripción rotación'
        },
        { ownerId: CUSTOMER_ID, now: NOW }
      )

      const rotated = await rotateWebhookSubscriptionSecret(db, sub.id, {
        ownerId: CUSTOMER_ID,
        now: '2026-10-29T12:05:00Z',
        gracePeriodSeconds: 86400,
        expectedVersion: 1
      })

      expect(rotated.version).toBe(2)
      expect(rotated.secondarySecret).toBe(sub.primarySecret)
      expect(rotated.primarySecret).not.toBe(sub.primarySecret)
      expect(rotated.secondarySecretExpiresAt).toBe('2026-10-30T12:05:00Z')

      // Falla CAS si versión no coincide
      await expect(
        rotateWebhookSubscriptionSecret(db, sub.id, {
          ownerId: CUSTOMER_ID,
          now: '2026-10-29T12:06:00Z',
          expectedVersion: 1 // ya está en 2
        })
      ).rejects.toThrowError(/concurrency_conflict/)
    })
  })

  describe('Cola de entregas, reintentos con backoff, DLQ y replay', () => {
    it('encola entregas al publicarse evento y despacha con éxito', async () => {
      const db = d1OverSqlite(sqlite)
      const sub = await createWebhookSubscription(
        db,
        {
          url: 'https://cliente.empresa.es/webhooks',
          topics: ['order.paid'],
          description: 'Suscripción despacho'
        },
        { ownerId: CUSTOMER_ID, now: NOW }
      )

      await queueWebhookEvent(
        db,
        {
          topic: 'order.paid',
          eventId: 'evt-1001',
          payload: { order_id: 'ord-1001', status: 'paid', amount_cents: 2500 }
        },
        NOW
      )

      const deliveries = await listWebhookDeliveries(db, { subscriptionId: sub.id })
      expect(deliveries).toHaveLength(1)
      expect(deliveries[0]!.status).toBe('pending')

      // Simular despacho con fetch simulado exitoso
      const mockFetch = async () =>
        new Response(JSON.stringify({ received: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })

      const dispatchResult = await dispatchWebhookDeliveriesBatch(db, {
        fetchImpl: mockFetch as typeof fetch,
        now: NOW
      })

      expect(dispatchResult.delivered).toBe(1)

      const updated = await listWebhookDeliveries(db, { subscriptionId: sub.id })
      expect(updated[0]!.status).toBe('delivered')
      expect(updated[0]!.attempts).toBe(1)

      // Logs de intento
      const logs = await getWebhookDeliveryLogs(db, updated[0]!.id)
      expect(logs).toHaveLength(1)
      expect(logs[0]!.httpStatus).toBe(200)
    })

    it('enruta a DLQ tras alcanzar el máximo de reintentos', async () => {
      const db = d1OverSqlite(sqlite)
      const sub = await createWebhookSubscription(
        db,
        {
          url: 'https://cliente-error.empresa.es/webhooks',
          topics: ['order.paid'],
          description: 'Suscripción con error 500'
        },
        { ownerId: CUSTOMER_ID, now: NOW }
      )

      await queueWebhookEvent(
        db,
        {
          topic: 'order.paid',
          eventId: 'evt-2002',
          payload: { order_id: 'ord-2002', status: 'paid' }
        },
        NOW
      )

      // Simular fallo constante 500
      const failingFetch = async () => new Response('Internal Server Error', { status: 500 })

      let currentTime = NOW
      // Ejecutar reintentos hasta llegar a max_attempts
      for (let i = 0; i < 5; i++) {
        await dispatchWebhookDeliveriesBatch(db, {
          fetchImpl: failingFetch as typeof fetch,
          now: currentTime
        })
        currentTime = new Date(Date.parse(currentTime) + 36000000).toISOString().replace(/\.\d{3}Z$/, 'Z')
      }

      const deliveries = await listWebhookDeliveries(db, {
        subscriptionId: sub.id,
        status: 'dead_letter'
      })
      expect(deliveries).toHaveLength(1)
      expect(deliveries[0]!.status).toBe('dead_letter')
      expect(deliveries[0]!.attempts).toBe(5)

      // Replay desde DLQ
      const replayed = await replayDeadLetterDelivery(db, deliveries[0]!.id, {
        actorId: ADMIN_ID,
        now: currentTime
      })
      expect(replayed.status).toBe('pending')
      expect(replayed.nextAttemptAt).toBe(currentTime)

      // Siguiente despacho exitoso recupera la entrega
      const successFetch = async () => new Response('{"ok":true}', { status: 200 })
      await dispatchWebhookDeliveriesBatch(db, {
        fetchImpl: successFetch as typeof fetch,
        now: currentTime
      })

      const finalDeliveries = await listWebhookDeliveries(db, { subscriptionId: sub.id })
      expect(finalDeliveries[0]!.status).toBe('delivered')
    })

    it('enruta inmediatamente a DLQ en caso de 410 Gone', async () => {
      const db = d1OverSqlite(sqlite)
      const sub = await createWebhookSubscription(
        db,
        {
          url: 'https://cliente-desaparecido.empresa.es/webhooks',
          topics: ['order.cancelled'],
          description: 'Suscripción endpoint eliminado'
        },
        { ownerId: CUSTOMER_ID, now: NOW }
      )

      await queueWebhookEvent(
        db,
        {
          topic: 'order.cancelled',
          eventId: 'evt-3003',
          payload: { order_id: 'ord-3003', reason: 'cancelled' }
        },
        NOW
      )

      const goneFetch = async () => new Response('Endpoint Gone', { status: 410 })
      await dispatchWebhookDeliveriesBatch(db, {
        fetchImpl: goneFetch as typeof fetch,
        now: NOW
      })

      const deliveries = await listWebhookDeliveries(db, { subscriptionId: sub.id })
      expect(deliveries[0]!.status).toBe('dead_letter')
      expect(deliveries[0]!.lastHttpStatus).toBe(410)
    })
  })
})
