import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fulfillmentFixture, CLAIMS, REASON, utc } from './d1-fulfillment-fixture'
import { createPackingOrder } from './d1-order-packing-fixture'
import { executeD1AdminFulfillmentCommand } from '../../workers/fulfillment/admin'
import {
  scheduleDeliverySurveyInvitation,
  readDeliverySurveyByToken,
  submitDeliverySurvey,
  optOutDeliverySurvey,
  readAdminDeliverySurveys,
  DeliverySurveyError,
  type ContactReason
} from '../../workers/fulfillment/delivery-survey'
import { sha256Hex } from '../../workers/catalog/inventory'
import { testUuid } from '../support/deterministic'

describe('ORD-017 Delivery Surveys & Post-Delivery Experience', () => {
  let f: Awaited<ReturnType<typeof fulfillmentFixture>>
  let deliveredOrderId: string

  beforeEach(async () => {
    f = await fulfillmentFixture({ stock: 100 })

    // Apply delivery survey migration
    const migration = await readFile(
      new URL('../../db/d1/migrations/0098_delivery_surveys.sql', import.meta.url),
      'utf8'
    )
    f.sqlite.exec(await readFile('db/d1/migrations/0101_b2b_price_lists_credit.sql', 'utf8'))
    f.sqlite.exec(migration)

    // Also ensure support migrations exist for support ticket linking
    try {
      const supportMigration = await readFile(
        new URL('../../db/d1/migrations/0049_support_operations.sql', import.meta.url),
        'utf8'
      )
      f.sqlite.exec(supportMigration)
    } catch {
      // 0049 is usually in base migrations, ignore if already applied
    }

    // Create a delivered order
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
      { idempotencyKey: testUuid() }
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
      { idempotencyKey: testUuid() }
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
      { idempotencyKey: testUuid() }
    )
    await executeD1AdminFulfillmentCommand(
      f.database,
      CLAIMS,
      deliveredOrderId,
      {
        action: 'delivered',
        expectedVersion: 3,
        reason: REASON,
        evidence: 'Entregado al cliente en mostrador'
      },
      { idempotencyKey: testUuid() }
    )
  })

  afterEach(() => {
    f.sqlite.close()
  })

  describe('1. Programación de invitaciones (Scheduling & Idempotency)', () => {
    it('programa una invitación con token único y caducidad para un pedido entregado', async () => {
      const result = await scheduleDeliverySurveyInvitation(f.database, {
        orderId: deliveredOrderId,
        now: utc()
      })

      expect(result.outcome).toBe('scheduled')
      expect(result.invitation).toBeDefined()
      expect(result.invitation.orderId).toBe(deliveredOrderId)
      expect(result.invitation.status).toBe('scheduled')
      expect(result.invitation.token).toHaveLength(32)
      expect(result.invitation.customerSegment).toBe('particular')
      expect(result.invitation.outboxEventId).toBe(result.invitation.id)
      expect(new Date(result.invitation.expiresAt).getTime()).toBeGreaterThan(
        new Date(result.invitation.scheduledAt).getTime()
      )
    })

    it('es idempotente: si se llama dos veces para el mismo pedido devuelve la invitación existente sin duplicar', async () => {
      const first = await scheduleDeliverySurveyInvitation(f.database, {
        orderId: deliveredOrderId,
        now: utc()
      })
      const second = await scheduleDeliverySurveyInvitation(f.database, {
        orderId: deliveredOrderId,
        now: utc()
      })

      expect(first.outcome).toBe('scheduled')
      expect(second.outcome).toBe('idempotent')
      expect(second.invitation.id).toBe(first.invitation.id)
      expect(second.invitation.token).toBe(first.invitation.token)

      // Verificar que solo hay 1 fila en la base de datos
      const count = f.sqlite
        .prepare('SELECT count(*) as cnt FROM delivery_survey_invitations WHERE order_id = ?')
        .get(deliveredOrderId) as { cnt: number }
      expect(count.cnt).toBe(1)
    })

    it('falla con order_not_delivered si el pedido aún no está en estado delivered', async () => {
      const pendingOrderId = await f.order('pickup')
      // Está en 'pending', no 'delivered'
      await expect(
        scheduleDeliverySurveyInvitation(f.database, {
          orderId: pendingOrderId,
          now: utc()
        })
      ).rejects.toThrow(DeliverySurveyError)

      try {
        await scheduleDeliverySurveyInvitation(f.database, {
          orderId: pendingOrderId,
          now: utc()
        })
      } catch (err) {
        expect((err as DeliverySurveyError).code).toBe('order_not_delivered')
      }
    })

    it('falla con not_found si el pedido no existe', async () => {
      await expect(
        scheduleDeliverySurveyInvitation(f.database, {
          orderId: '00000000-0000-4000-8000-000000000999',
          now: utc()
        })
      ).rejects.toThrow(DeliverySurveyError)

      try {
        await scheduleDeliverySurveyInvitation(f.database, {
          orderId: '00000000-0000-4000-8000-000000000999',
          now: utc()
        })
      } catch (err) {
        expect((err as DeliverySurveyError).code).toBe('not_found')
      }
    })

    it('respeta opt-out: si el email está en delivery_survey_opt_outs se suprime la invitación sin enviar outbox', async () => {
      const email = 'buyer@example.invalid'
      const emailHash = await sha256Hex(email.toLowerCase().trim())
      f.sqlite
        .prepare('INSERT INTO delivery_survey_opt_outs (email_hash, opted_out_at, reason) VALUES (?, ?, ?)')
        .run(emailHash, utc(), 'unsubscribe_link')

      const result = await scheduleDeliverySurveyInvitation(f.database, {
        orderId: deliveredOrderId,
        now: utc()
      })

      expect(result.outcome).toBe('suppressed')
      expect(result.invitation.status).toBe('suppressed')
      expect(result.invitation.suppressionReason).toBe('opt_out')
    })

    it('respeta preferencias de entrega: suprime la invitación si delivery_updates = 0 en delivery_preferences', async () => {
      const customerId = '00000000-0000-4000-8000-000000000555'
      const now = utc()
      f.sqlite
        .prepare('INSERT INTO customers (id, status, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(customerId, 'active', now, now)
      f.sqlite.prepare('UPDATE identities SET customer_id = ? WHERE id = ?').run(customerId, CLAIMS.identityId)

      // Crear pedido con el cliente
      let customerOrderId = ''
      await createPackingOrder(f.database, {
        ownerSession: CLAIMS,
        method: 'pickup',
        stage: 'pending',
        now,
        onOrderCreated: (o) => {
          customerOrderId = o.id
        }
      })

      // Avanzar a delivered
      await executeD1AdminFulfillmentCommand(
        f.database,
        CLAIMS,
        customerOrderId,
        { action: 'picking', expectedVersion: 0, reason: REASON },
        { idempotencyKey: testUuid() }
      )
      await executeD1AdminFulfillmentCommand(
        f.database,
        CLAIMS,
        customerOrderId,
        { action: 'packed', expectedVersion: 1, reason: REASON },
        { idempotencyKey: testUuid() }
      )
      await executeD1AdminFulfillmentCommand(
        f.database,
        CLAIMS,
        customerOrderId,
        { action: 'ready_for_pickup', expectedVersion: 2, reason: REASON },
        { idempotencyKey: testUuid() }
      )
      await executeD1AdminFulfillmentCommand(
        f.database,
        CLAIMS,
        customerOrderId,
        { action: 'delivered', expectedVersion: 3, reason: REASON, evidence: 'Entregado OK' },
        { idempotencyKey: testUuid() }
      )

      // Crear preferencia delivery_updates = 0
      try {
        const prefMigration = await readFile(
          new URL('../../db/d1/migrations/0070_delivery_preferences.sql', import.meta.url),
          'utf8'
        )
        f.sqlite.exec(prefMigration)
      } catch {
        // Ignorar si ya existe
      }
      f.sqlite
        .prepare(
          `INSERT INTO delivery_preference_commands (customer_id, command_id, actor_id, session_id, session_version, payload_hash, expected_version, applied_version, delivery_updates, policy_version, text_hash, recorded_at)
           VALUES (?, ?, ?, ?, 1, ?, 0, 1, 0, 'delivery-notices-2026-10-09', ?, ?)`
        )
        .run(customerId, testUuid(), CLAIMS.identityId, CLAIMS.sessionId, 'a'.repeat(64), 'b'.repeat(64), now)

      const result = await scheduleDeliverySurveyInvitation(f.database, {
        orderId: customerOrderId,
        now: utc()
      })

      expect(result.outcome).toBe('suppressed')
      expect(result.invitation.status).toBe('suppressed')
      expect(result.invitation.suppressionReason).toBe('delivery_updates_disabled')
    })

    it('clasifica correctamente el segmento profesional vs particular', async () => {
      // Caso 1: particular (por defecto)
      const res1 = await scheduleDeliverySurveyInvitation(f.database, {
        orderId: deliveredOrderId,
        now: utc()
      })
      expect(res1.invitation.customerSegment).toBe('particular')

      // Caso 2: profesional vía empresa asignada al cliente
      const customerId = '00000000-0000-4000-8000-000000000666'
      const companyId = '00000000-0000-4000-8000-000000000667'
      const now = utc()
      f.sqlite
        .prepare('INSERT INTO customers (id, status, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(customerId, 'active', now, now)
      f.sqlite.prepare('UPDATE identities SET customer_id = ? WHERE id = ?').run(customerId, CLAIMS.identityId)

      f.sqlite
        .prepare(
          'INSERT INTO companies (id, customer_id, legal_name, country_code, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(companyId, customerId, 'Químicas Levante SL', 'ES', 'approved', now, now)

      let b2bOrderId = ''
      await createPackingOrder(f.database, {
        ownerSession: CLAIMS,
        method: 'pickup',
        stage: 'pending',
        now,
        onOrderCreated: (o) => {
          b2bOrderId = o.id
        }
      })

      await executeD1AdminFulfillmentCommand(
        f.database,
        CLAIMS,
        b2bOrderId,
        { action: 'picking', expectedVersion: 0, reason: REASON },
        { idempotencyKey: testUuid() }
      )
      await executeD1AdminFulfillmentCommand(
        f.database,
        CLAIMS,
        b2bOrderId,
        { action: 'packed', expectedVersion: 1, reason: REASON },
        { idempotencyKey: testUuid() }
      )
      await executeD1AdminFulfillmentCommand(
        f.database,
        CLAIMS,
        b2bOrderId,
        { action: 'ready_for_pickup', expectedVersion: 2, reason: REASON },
        { idempotencyKey: testUuid() }
      )
      await executeD1AdminFulfillmentCommand(
        f.database,
        CLAIMS,
        b2bOrderId,
        { action: 'delivered', expectedVersion: 3, reason: REASON, evidence: 'Entregado B2B' },
        { idempotencyKey: testUuid() }
      )

      const res2 = await scheduleDeliverySurveyInvitation(f.database, {
        orderId: b2bOrderId,
        now: utc()
      })
      expect(res2.invitation.customerSegment).toBe('profesional')
    })
  })

  describe('2. Lectura pública por token sin login', () => {
    it('permite leer la encuesta con un token válido activo', async () => {
      const scheduled = await scheduleDeliverySurveyInvitation(f.database, {
        orderId: deliveredOrderId,
        now: utc()
      })

      const details = await readDeliverySurveyByToken(f.database, scheduled.invitation.token, { now: utc() })
      expect(details.orderId).toBe(deliveredOrderId)
      expect(details.status).toBe('scheduled')
      expect(details.customerSegment).toBe('particular')
      expect(details.recipientEmail).toBe('buyer@example.invalid')
    })

    it('falla con not_found si el token no existe', async () => {
      await expect(
        readDeliverySurveyByToken(f.database, 'token_inventado_totalmente_inexistente', { now: utc() })
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it('falla con token_expired si el token ha caducado', async () => {
      const scheduled = await scheduleDeliverySurveyInvitation(f.database, {
        orderId: deliveredOrderId,
        now: utc(-30 * 86400000) // hace 30 días
      })

      // Intentamos leerlo hoy
      await expect(
        readDeliverySurveyByToken(f.database, scheduled.invitation.token, { now: utc() })
      ).rejects.toMatchObject({ code: 'token_expired' })
    })

    it('falla con token_used si la encuesta ya fue completada', async () => {
      const scheduled = await scheduleDeliverySurveyInvitation(f.database, {
        orderId: deliveredOrderId,
        now: utc()
      })

      await submitDeliverySurvey(
        f.database,
        {
          token: scheduled.invitation.token,
          score: 5,
          arrivedGood: true,
          contactReason: 'compliment',
          comment: 'Todo excelente'
        },
        { now: utc() }
      )

      await expect(
        readDeliverySurveyByToken(f.database, scheduled.invitation.token, { now: utc() })
      ).rejects.toMatchObject({ code: 'token_used' })
    })
  })

  describe('3. Envío de encuesta (Submission, Problem Detection & Support Tickets)', () => {
    it('guarda una valoración positiva sin crear ticket de soporte', async () => {
      const scheduled = await scheduleDeliverySurveyInvitation(f.database, {
        orderId: deliveredOrderId,
        now: utc()
      })

      const response = await submitDeliverySurvey(
        f.database,
        {
          token: scheduled.invitation.token,
          score: 5,
          arrivedGood: true,
          contactReason: 'compliment',
          comment: 'Muy rápido y producto de 10.'
        },
        { now: utc() }
      )

      expect(response.ok).toBe(true)
      expect(response.hasProblem).toBe(false)
      expect(response.supportTicket).toBeNull()

      // Comprobar estado de la invitación
      const inv = f.sqlite
        .prepare('SELECT status FROM delivery_survey_invitations WHERE id = ?')
        .get(scheduled.invitation.id) as { status: string }
      expect(inv.status).toBe('completed')
    })

    it('token de un solo uso: si se intenta reenviar falla con token_used', async () => {
      const scheduled = await scheduleDeliverySurveyInvitation(f.database, {
        orderId: deliveredOrderId,
        now: utc()
      })

      await submitDeliverySurvey(
        f.database,
        {
          token: scheduled.invitation.token,
          score: 4,
          arrivedGood: true
        },
        { now: utc() }
      )

      // Segundo intento con el mismo token
      await expect(
        submitDeliverySurvey(
          f.database,
          {
            token: scheduled.invitation.token,
            score: 4,
            arrivedGood: true
          },
          { now: utc() }
        )
      ).rejects.toMatchObject({ code: 'token_used' })
    })

    it('si hay problema (arrivedGood=false o motivo rotura), crea ticket de soporte vinculado al pedido sin duplicar', async () => {
      const scheduled = await scheduleDeliverySurveyInvitation(f.database, {
        orderId: deliveredOrderId,
        now: utc()
      })

      const response = await submitDeliverySurvey(
        f.database,
        {
          token: scheduled.invitation.token,
          score: 1,
          arrivedGood: false,
          contactReason: 'damaged_product',
          comment: 'La garrafa de detergente venía rota y ha manchado el paquete.'
        },
        { now: utc() }
      )

      expect(response.ok).toBe(true)
      expect(response.hasProblem).toBe(true)
      expect(response.supportTicket).toBeDefined()
      expect(response.supportTicket?.publicRef).toMatch(/^SOP-[A-Z0-9]{24}$/)
      expect(response.supportTicket?.created).toBe(true)

      // Comprobar en base de datos que el ticket existe
      const ticket = f.sqlite
        .prepare('SELECT id, public_ref, subject, state FROM support_tickets WHERE id = ?')
        .get(response.supportTicket!.ticketId) as { id: string; public_ref: string; subject: string; state: string }
      expect(ticket).toBeDefined()
      expect(ticket.public_ref).toBe(response.supportTicket!.publicRef)
      expect(ticket.state).toBe('open')
    })

    it('ticket sin duplicar: si ya existe un ticket abierto vinculado al pedido, reutiliza la referencia sin crear otro', async () => {
      // Crear un ticket de soporte previo para este pedido
      const ticketId = '00000000-0000-4000-8000-000000000777'
      const publicRef = 'SOP-' + 'A'.repeat(24)
      const now = utc()

      f.sqlite
        .prepare(
          `INSERT INTO support_commands (id, nonce, actor_key, actor_type, ticket_id, public_ref, action, idempotency_key, payload_hash, input, snapshot, expected_version, result_version, to_state, response, created_at)
           VALUES (?, ?, ?, 'anonymous', ?, ?, 'created', ?, ?, ?, ?, 0, 1, 'open', ?, ?)`
        )
        .run(
          '00000000-0000-4000-8000-000000000778',
          '00000000-0000-4000-8000-000000000779',
          'anonymous:synthetic',
          ticketId,
          publicRef,
          'idem-ticket-1',
          '0'.repeat(64),
          JSON.stringify({ message: 'Ticket previo' }),
          JSON.stringify({ priority: 'normal', customerId: null, orderId: null }),
          JSON.stringify({
            commandId: '00000000-0000-4000-8000-000000000778',
            publicRef,
            version: 1,
            state: 'open',
            inventoryEffect: 'none',
            economicEffect: 'none'
          }),
          now
        )

      f.sqlite
        .prepare(
          `INSERT INTO support_tickets (id, public_ref, customer_id, order_id, category, subject, requester, declared_order_reference, state, priority, version, last_command_id, created_at, updated_at)
           VALUES (?, ?, NULL, NULL, 'shipping', 'Incidencia previa', '{}', ?, 'open', 'normal', 1, ?, ?, ?)`
        )
        .run(ticketId, publicRef, deliveredOrderId, '00000000-0000-4000-8000-000000000778', now, now)

      f.sqlite
        .prepare(
          `INSERT INTO support_events (id, ticket_id, actor_type, type, visibility, body, state, created_at)
           VALUES (?, ?, 'anonymous', 'created', 'public', 'Ticket previo', 'open', ?)`
        )
        .run('00000000-0000-4000-8000-000000000778', ticketId, now)

      const scheduled = await scheduleDeliverySurveyInvitation(f.database, {
        orderId: deliveredOrderId,
        now: utc()
      })

      const response = await submitDeliverySurvey(
        f.database,
        {
          token: scheduled.invitation.token,
          score: 2,
          arrivedGood: false,
          contactReason: 'damaged_product',
          comment: 'Reiteración de daño'
        },
        { now: utc() }
      )

      expect(response.ok).toBe(true)
      expect(response.hasProblem).toBe(true)
      expect(response.supportTicket?.publicRef).toBe(publicRef)
      expect(response.supportTicket?.created).toBe(false) // Reutilizado, no duplicado!
    })

    it('valida el catálogo estable de motivos de contacto', async () => {
      const scheduled = await scheduleDeliverySurveyInvitation(f.database, {
        orderId: deliveredOrderId,
        now: utc()
      })

      await expect(
        submitDeliverySurvey(
          f.database,
          {
            token: scheduled.invitation.token,
            score: 3,
            arrivedGood: true,
            contactReason: 'motivo_invalido_que_no_existe' as ContactReason
          },
          { now: utc() }
        )
      ).rejects.toMatchObject({ code: 'invalid_input' })
    })

    it('valida puntuación entre 1 y 5', async () => {
      const scheduled = await scheduleDeliverySurveyInvitation(f.database, {
        orderId: deliveredOrderId,
        now: utc()
      })

      await expect(
        submitDeliverySurvey(
          f.database,
          {
            token: scheduled.invitation.token,
            score: 0 as unknown as number,
            arrivedGood: true
          },
          { now: utc() }
        )
      ).rejects.toMatchObject({ code: 'invalid_input' })

      await expect(
        submitDeliverySurvey(
          f.database,
          {
            token: scheduled.invitation.token,
            score: 6 as unknown as number,
            arrivedGood: true
          },
          { now: utc() }
        )
      ).rejects.toMatchObject({ code: 'invalid_input' })
    })

    it('nunca bloquea nada: el pedido sigue entregado y no impide reclamación o devolución', async () => {
      const scheduled = await scheduleDeliverySurveyInvitation(f.database, {
        orderId: deliveredOrderId,
        now: utc()
      })

      await submitDeliverySurvey(
        f.database,
        {
          token: scheduled.invitation.token,
          score: 1,
          arrivedGood: false,
          contactReason: 'wrong_product'
        },
        { now: utc() }
      )

      // Comprobar que el pedido sigue intacto en orders y order_fulfillments
      const order = f.sqlite.prepare('SELECT id, status FROM orders WHERE id = ?').get(deliveredOrderId) as {
        status: string
      }
      expect(order).toBeDefined()

      const fulfillment = f.sqlite
        .prepare('SELECT status, version FROM order_fulfillments WHERE order_id = ?')
        .get(deliveredOrderId) as { status: string; version: number }
      expect(fulfillment.status).toBe('delivered')
    })

    it('permite opt-out explícito a través del token de la encuesta', async () => {
      const scheduled = await scheduleDeliverySurveyInvitation(f.database, {
        orderId: deliveredOrderId,
        now: utc()
      })

      const optOutRes = await optOutDeliverySurvey(f.database, {
        token: scheduled.invitation.token,
        now: utc()
      })

      expect(optOutRes.ok).toBe(true)
      expect(optOutRes.optedOut).toBe(true)

      // Verificar que el email está en la tabla de opt-out
      const emailHash = await sha256Hex('buyer@example.invalid')
      const row = f.sqlite
        .prepare('SELECT email_hash, reason FROM delivery_survey_opt_outs WHERE email_hash = ?')
        .get(emailHash) as { email_hash: string; reason: string }
      expect(row).toBeDefined()
      expect(row.reason).toBe('unsubscribe_link')
    })
  })

  async function seedSampleSurveys(fixture: Awaited<ReturnType<typeof fulfillmentFixture>>, count = 10) {
    const now = utc()
    const orderIds: string[] = []
    for (let i = 0; i < count; i++) {
      orderIds.push(await fixture.order('pickup'))
    }

    for (let i = 0; i < count; i++) {
      const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`
      const invId = `00000000-0000-4000-9000-${String(i + 1).padStart(12, '0')}`
      const orderId = orderIds[i]
      const token = `token_${i}_${'a'.repeat(24)}`
      const segment = i < 6 ? 'particular' : 'profesional'
      const score = ((i % 5) + 1) as 1 | 2 | 3 | 4 | 5
      const arrivedGood = score >= 3 ? 1 : 0
      const hasProblem = arrivedGood === 0 || score <= 2 ? 1 : 0
      const reason = hasProblem ? 'damaged_product' : 'compliment'

      fixture.sqlite
        .prepare(
          `INSERT INTO delivery_survey_invitations (id, order_id, recipient_email, customer_segment, token, status, scheduled_at, expires_at, created_at, updated_at)
           VALUES (?, ?, 'user@example.invalid', ?, ?, 'scheduled', ?, ?, ?, ?)`
        )
        .run(invId, orderId, segment, token, now, utc(864000000), now, now)

      fixture.sqlite
        .prepare(
          `INSERT INTO delivery_survey_responses (id, invitation_id, order_id, score, arrived_good, contact_reason, customer_segment, has_problem, submitted_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, invId, orderId, score, arrivedGood, reason, segment, hasProblem, now, now)
    }
  }

  describe('4. Panel de administración y agregados con umbral de muestra', () => {
    it('aplica umbral de muestra (< 10): suprime porcentajes y marca hasSufficientSample: false cuando hay pocas respuestas', async () => {
      // Crear 3 respuestas (menor al umbral de 10)
      for (let i = 0; i < 3; i++) {
        const orderId = await f.order('pickup')
        await executeD1AdminFulfillmentCommand(
          f.database,
          CLAIMS,
          orderId,
          {
            action: 'picking',
            expectedVersion: 0,
            reason: REASON
          },
          { idempotencyKey: testUuid() }
        )
        await executeD1AdminFulfillmentCommand(
          f.database,
          CLAIMS,
          orderId,
          {
            action: 'packed',
            expectedVersion: 1,
            reason: REASON
          },
          { idempotencyKey: testUuid() }
        )
        await executeD1AdminFulfillmentCommand(
          f.database,
          CLAIMS,
          orderId,
          {
            action: 'ready_for_pickup',
            expectedVersion: 2,
            reason: REASON
          },
          { idempotencyKey: testUuid() }
        )
        await executeD1AdminFulfillmentCommand(
          f.database,
          CLAIMS,
          orderId,
          {
            action: 'delivered',
            expectedVersion: 3,
            reason: REASON,
            evidence: 'Entregado para stats'
          },
          { idempotencyKey: testUuid() }
        )

        const scheduled = await scheduleDeliverySurveyInvitation(f.database, { orderId, now: utc() })
        await submitDeliverySurvey(
          f.database,
          {
            token: scheduled.invitation.token,
            score: (4 + (i % 2)) as 4 | 5,
            arrivedGood: true,
            contactReason: 'compliment'
          },
          { now: utc() }
        )
      }

      const report = await readAdminDeliverySurveys(f.database, {
        minSampleThreshold: 10,
        now: utc()
      })

      expect(report.summary.completedSurveys).toBe(3)
      expect(report.summary.hasSufficientSample).toBe(false)
      // Con muestra insuficiente, las medias o porcentajes se devuelven null o con indicador explícito
      expect(report.summary.averageScore).toBeNull()
      expect(report.summary.arrivedGoodRate).toBeNull()
      expect(report.summary.problemRate).toBeNull()
    })

    it('calcula métricas completas cuando la muestra supera el umbral (>= 10)', async () => {
      await seedSampleSurveys(f, 10)

      const report = await readAdminDeliverySurveys(f.database, {
        minSampleThreshold: 10,
        now: utc()
      })

      expect(report.summary.completedSurveys).toBe(10)
      expect(report.summary.hasSufficientSample).toBe(true)
      expect(report.summary.averageScore).toBe(3) // (1+2+3+4+5)*2 / 10 = 30 / 10 = 3
      expect(report.summary.arrivedGoodRate).toBe(0.6) // 6 de 10
      expect(report.summary.problemRate).toBe(0.4) // 4 de 10

      // Desglose por segmento
      expect(report.bySegment.particular.count).toBe(6)
      expect(report.bySegment.profesional.count).toBe(4)

      // Desglose por motivo de contacto
      const complimentRow = report.byReason.find((r) => r.reason === 'compliment')
      expect(complimentRow).toBeDefined()
      expect(complimentRow?.count).toBe(6)

      const damagedRow = report.byReason.find((r) => r.reason === 'damaged_product')
      expect(damagedRow).toBeDefined()
      expect(damagedRow?.count).toBe(4)
    })

    it('permite filtrar por segmento profesional o particular', async () => {
      await seedSampleSurveys(f, 10)

      const report = await readAdminDeliverySurveys(f.database, {
        segment: 'profesional',
        minSampleThreshold: 3,
        now: utc()
      })

      expect(report.summary.completedSurveys).toBe(4)
      expect(report.summary.hasSufficientSample).toBe(true)
    })
  })
})
