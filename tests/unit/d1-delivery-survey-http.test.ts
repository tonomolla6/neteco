import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fulfillmentFixture, CLAIMS, REASON, utc } from './d1-fulfillment-fixture'
import { executeD1AdminFulfillmentCommand } from '../../workers/fulfillment/admin'
import {
  handleDeliverySurveyHttp,
  ownsDeliverySurveyNamespace,
  type DeliverySurveyHttpEnvironment
} from '../../workers/fulfillment/delivery-survey-http'
import { scheduleDeliverySurveyInvitation } from '../../workers/fulfillment/delivery-survey'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'

describe('ORD-017 Delivery Surveys HTTP Endpoints', () => {
  let f: Awaited<ReturnType<typeof fulfillmentFixture>>
  let deliveredOrderId: string
  let validToken: string
  const sessionPassword = 'synthetic_test_secret_for_cookies_32_bytes_long!'

  const makeEnv = (): DeliverySurveyHttpEnvironment => ({
    DB: f.database,
    AUTH_ENABLED: 'true',
    AUTH_ORIGIN: 'https://test.neteco.invalid',
    NUXT_SESSION_PASSWORD: sessionPassword
  })

  beforeEach(async () => {
    f = await fulfillmentFixture({ stock: 20 })
    const migration = await readFile(
      new URL('../../db/d1/migrations/0098_delivery_surveys.sql', import.meta.url),
      'utf8'
    )
    f.sqlite.exec(migration)

    try {
      const supportMigration = await readFile(
        new URL('../../db/d1/migrations/0049_support_operations.sql', import.meta.url),
        'utf8'
      )
      f.sqlite.exec(supportMigration)
    } catch {
      // 0049 may be in baseline
    }

    deliveredOrderId = await f.order('pickup')
    await executeD1AdminFulfillmentCommand(
      f.database,
      CLAIMS,
      deliveredOrderId,
      {
        action: 'picking',
        expectedVersion: 0,
        reason: REASON
      },
      { idempotencyKey: crypto.randomUUID() }
    )
    await executeD1AdminFulfillmentCommand(
      f.database,
      CLAIMS,
      deliveredOrderId,
      {
        action: 'packed',
        expectedVersion: 1,
        reason: REASON
      },
      { idempotencyKey: crypto.randomUUID() }
    )
    await executeD1AdminFulfillmentCommand(
      f.database,
      CLAIMS,
      deliveredOrderId,
      {
        action: 'ready_for_pickup',
        expectedVersion: 2,
        reason: REASON
      },
      { idempotencyKey: crypto.randomUUID() }
    )
    await executeD1AdminFulfillmentCommand(
      f.database,
      CLAIMS,
      deliveredOrderId,
      {
        action: 'delivered',
        expectedVersion: 3,
        reason: REASON,
        evidence: 'Entregado OK'
      },
      { idempotencyKey: crypto.randomUUID() }
    )

    const scheduled = await scheduleDeliverySurveyInvitation(f.database, {
      orderId: deliveredOrderId,
      now: utc()
    })
    validToken = scheduled.invitation.token
  })

  afterEach(() => {
    f.sqlite.close()
  })

  describe('Namespace Ownership', () => {
    it('reconoce las rutas públicas y de administración', () => {
      expect(ownsDeliverySurveyNamespace('/api/fulfillment/delivery-survey')).toBe(true)
      expect(ownsDeliverySurveyNamespace('/api/fulfillment/delivery-survey/submit')).toBe(true)
      expect(ownsDeliverySurveyNamespace('/api/fulfillment/delivery-survey/opt-out')).toBe(true)
      expect(ownsDeliverySurveyNamespace('/api/admin/fulfillment/delivery-surveys')).toBe(true)
      expect(ownsDeliverySurveyNamespace('/api/admin/delivery-surveys')).toBe(true)
      expect(ownsDeliverySurveyNamespace('/api/catalog/products')).toBe(false)
    })
  })

  describe('GET /api/fulfillment/delivery-survey (Public read)', () => {
    it('devuelve 200 con la información del pedido cuando el token es válido', async () => {
      const env = makeEnv()
      const request = new Request(`https://test.neteco.invalid/api/fulfillment/delivery-survey?token=${validToken}`, {
        method: 'GET'
      })

      const response = await handleDeliverySurveyHttp(request, env)
      expect(response).not.toBeNull()
      expect(response!.status).toBe(200)

      const body = (await response!.json()) as { orderId: string; status: string }
      expect(body.orderId).toBe(deliveredOrderId)
      expect(body.status).toBe('scheduled')
    })

    it('devuelve 400 si falta el parámetro token', async () => {
      const env = makeEnv()
      const request = new Request('https://test.neteco.invalid/api/fulfillment/delivery-survey', {
        method: 'GET'
      })

      const response = await handleDeliverySurveyHttp(request, env)
      expect(response).not.toBeNull()
      expect(response!.status).toBe(400)
    })

    it('devuelve 404 si el token no existe', async () => {
      const env = makeEnv()
      const request = new Request(
        'https://test.neteco.invalid/api/fulfillment/delivery-survey?token=inventado12345678',
        {
          method: 'GET'
        }
      )

      const response = await handleDeliverySurveyHttp(request, env)
      expect(response).not.toBeNull()
      expect(response!.status).toBe(404)
    })
  })

  describe('POST /api/fulfillment/delivery-survey/submit (Public submit)', () => {
    it('devuelve 200/201 al enviar una valoración válida', async () => {
      const env = makeEnv()
      const request = new Request('https://test.neteco.invalid/api/fulfillment/delivery-survey/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: validToken,
          score: 5,
          arrivedGood: true,
          contactReason: 'compliment',
          comment: 'Todo fantástico.'
        })
      })

      const response = await handleDeliverySurveyHttp(request, env)
      expect(response).not.toBeNull()
      expect([200, 201]).toContain(response!.status)

      const body = (await response!.json()) as { ok: boolean; hasProblem: boolean }
      expect(body.ok).toBe(true)
      expect(body.hasProblem).toBe(false)
    })

    it('devuelve 409 al intentar reenviar con el mismo token (un solo uso)', async () => {
      const env = makeEnv()
      const req1 = new Request('https://test.neteco.invalid/api/fulfillment/delivery-survey/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: validToken,
          score: 5,
          arrivedGood: true
        })
      })
      await handleDeliverySurveyHttp(req1, env)

      const req2 = new Request('https://test.neteco.invalid/api/fulfillment/delivery-survey/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: validToken,
          score: 4,
          arrivedGood: true
        })
      })
      const res2 = await handleDeliverySurveyHttp(req2, env)
      expect(res2).not.toBeNull()
      expect(res2!.status).toBe(409)
    })

    it('devuelve 422 si los datos del formulario son inválidos', async () => {
      const env = makeEnv()
      const request = new Request('https://test.neteco.invalid/api/fulfillment/delivery-survey/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: validToken,
          score: 10, // Inválido (debe ser 1-5)
          arrivedGood: true
        })
      })

      const response = await handleDeliverySurveyHttp(request, env)
      expect(response).not.toBeNull()
      expect(response!.status).toBe(422)
    })
  })

  describe('POST /api/fulfillment/delivery-survey/opt-out (Public opt-out)', () => {
    it('devuelve 200 y registra el opt-out al enviar el token', async () => {
      const env = makeEnv()
      const request = new Request('https://test.neteco.invalid/api/fulfillment/delivery-survey/opt-out', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: validToken
        })
      })

      const response = await handleDeliverySurveyHttp(request, env)
      expect(response).not.toBeNull()
      expect(response!.status).toBe(200)

      const body = (await response!.json()) as { ok: boolean; optedOut: boolean }
      expect(body.ok).toBe(true)
      expect(body.optedOut).toBe(true)
    })
  })

  describe('GET /api/admin/fulfillment/delivery-surveys (Admin aggregates)', () => {
    it('devuelve 401 si no hay sesión autenticada', async () => {
      const env = makeEnv()
      const request = new Request('https://test.neteco.invalid/api/admin/fulfillment/delivery-surveys', {
        method: 'GET'
      })

      const response = await handleDeliverySurveyHttp(request, env)
      expect(response).not.toBeNull()
      expect(response!.status).toBe(401)
    })

    it('devuelve 200 y agregados con umbral de muestra cuando la sesión de admin es válida', async () => {
      const env = makeEnv()
      const cookieHeader = await issueD1SessionCookie(f.database, CLAIMS, {
        password: sessionPassword,
        maxAgeSeconds: 3600
      })
      const cookieValue = cookieHeader ? cookieHeader.split(';')[0] : ''

      const request = new Request('https://test.neteco.invalid/api/admin/fulfillment/delivery-surveys', {
        method: 'GET',
        headers: {
          cookie: cookieValue,
          origin: 'https://test.neteco.invalid'
        }
      })

      const response = await handleDeliverySurveyHttp(request, env)
      expect(response).not.toBeNull()
      expect(response!.status).toBe(200)

      const body = (await response!.json()) as {
        summary: { totalInvitations: number; completedSurveys: number; hasSufficientSample: boolean }
        minSampleThreshold: number
      }
      expect(body.summary).toBeDefined()
      expect(body.minSampleThreshold).toBeDefined()
    })

    it('rechaza con 403 peticiones de origen cruzado CSRF en endpoint admin', async () => {
      const env = makeEnv()
      const cookieHeader = await issueD1SessionCookie(f.database, CLAIMS, {
        password: sessionPassword,
        maxAgeSeconds: 3600
      })
      const cookieValue = cookieHeader ? cookieHeader.split(';')[0] : ''

      const request = new Request('https://test.neteco.invalid/api/admin/fulfillment/delivery-surveys', {
        method: 'GET',
        headers: {
          cookie: cookieValue,
          'sec-fetch-site': 'cross-site'
        }
      })

      const response = await handleDeliverySurveyHttp(request, env)
      expect(response).not.toBeNull()
      expect(response!.status).toBe(403)
    })

    it('devuelve 403 si la identidad carece de permisos de administración y soporte', async () => {
      const env = makeEnv()
      // Revoke roles from the test operator
      f.sqlite.exec(`DELETE FROM identity_roles;`)

      const cookieHeader = await issueD1SessionCookie(f.database, CLAIMS, {
        password: sessionPassword,
        maxAgeSeconds: 3600
      })
      const cookieValue = cookieHeader ? cookieHeader.split(';')[0] : ''

      const request = new Request('https://test.neteco.invalid/api/admin/fulfillment/delivery-surveys', {
        method: 'GET',
        headers: {
          cookie: cookieValue,
          origin: 'https://test.neteco.invalid'
        }
      })

      const response = await handleDeliverySurveyHttp(request, env)
      expect(response).not.toBeNull()
      expect(response!.status).toBe(403)
    })
  })
})
