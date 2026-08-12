import { randomBytes, randomUUID } from 'node:crypto'
import { createError, getCookie, type H3Event } from 'h3'
import { assertTransition, returnTransitions, type ReturnState } from '../domain/states'
import { useDatabase } from '../db/client'
import { hashAccessToken } from '../utils/access-token'

function publicReturnNumber() {
  return `RMA${randomBytes(7).toString('hex').slice(0, 10).toUpperCase()}`
}

async function accessContext(event: H3Event, publicNumber: string) {
  const cookie = getCookie(event, 'neteco-order-access')
  const token = cookie?.startsWith(`${publicNumber}.`) ? cookie.slice(publicNumber.length + 1) : ''
  const session = await getUserSession(event)
  return {
    tokenHash: token ? hashAccessToken(token) : '',
    identityId: session.user?.id ?? null,
    sessionId: session.sessionId ?? null
  }
}

export async function requestReturn(
  event: H3Event,
  input: {
    orderNumber: string
    reason: string
    lines: Array<{ orderLineId: string; quantity: number }>
    idempotencyKey: string
  }
) {
  const access = await accessContext(event, input.orderNumber)
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? randomUUID()
  return sql.begin('isolation level serializable', async (transaction) => {
    const [order] = await transaction<
      { id: string; fulfillment_status: string; updated_at: Date; customer_id: string | null }[]
    >`
      SELECT orders.id, orders.fulfillment_status, orders.updated_at, orders.customer_id
      FROM orders
      WHERE orders.public_number = ${input.orderNumber}
        AND (
          (${access.tokenHash} <> '' AND orders.guest_access_hash = ${access.tokenHash})
          OR EXISTS (
            SELECT 1 FROM identities identity
            JOIN auth_sessions active ON active.identity_id = identity.id
            WHERE identity.customer_id = orders.customer_id
              AND identity.id = ${access.identityId} AND active.id = ${access.sessionId}
              AND active.revoked_at IS NULL AND active.expires_at > now()
              AND active.session_version = identity.session_version
          )
        )
      FOR UPDATE
    `
    if (!order) throw createError({ statusCode: 404, statusMessage: 'Pedido no encontrado' })
    const [existing] = await transaction<{ public_number: string; status: string }[]>`
      SELECT public_number, status FROM returns
      WHERE order_id = ${order.id} AND idempotency_key = ${input.idempotencyKey}
    `
    if (existing) return { id: existing.public_number, status: existing.status, duplicate: true }
    if (order.fulfillment_status !== 'delivered') {
      throw createError({ statusCode: 409, statusMessage: 'La devolución se solicita después de la entrega' })
    }
    if (order.updated_at.getTime() < Date.now() - 30 * 24 * 60 * 60_000) {
      throw createError({ statusCode: 409, statusMessage: 'El plazo de devolución requiere revisión de soporte' })
    }

    const requested = new Map<string, number>()
    for (const line of input.lines)
      requested.set(line.orderLineId, (requested.get(line.orderLineId) ?? 0) + line.quantity)
    const lines = await transaction<{ id: string; quantity: number; returned_quantity: number }[]>`
      SELECT line.id, line.quantity, (
        SELECT COALESCE(sum(returned.quantity), 0)::int
        FROM return_lines returned
        JOIN returns prior ON prior.id = returned.return_id
        WHERE returned.order_line_id = line.id AND prior.status <> 'rejected'
      ) AS returned_quantity
      FROM order_lines line
      WHERE line.order_id = ${order.id} AND line.id IN ${transaction([...requested.keys()])}
      FOR UPDATE OF line
    `
    if (lines.length !== requested.size) {
      throw createError({ statusCode: 422, statusMessage: 'Una línea no pertenece al pedido' })
    }
    for (const line of lines) {
      const quantity = requested.get(line.id)!
      if (quantity < 1 || quantity > line.quantity - line.returned_quantity) {
        throw createError({ statusCode: 422, statusMessage: 'La cantidad a devolver no está disponible' })
      }
    }

    const returnId = randomUUID()
    const publicNumber = publicReturnNumber()
    await transaction`
      INSERT INTO returns (id, order_id, public_number, status, reason, idempotency_key)
      VALUES (${returnId}, ${order.id}, ${publicNumber}, 'requested', ${input.reason.trim()}, ${input.idempotencyKey})
    `
    for (const line of lines) {
      await transaction`
        INSERT INTO return_lines (return_id, order_line_id, quantity)
        VALUES (${returnId}, ${line.id}, ${requested.get(line.id)!})
      `
    }
    await transaction`
      INSERT INTO order_events (
        order_id, event_type, actor_type, origin, to_state, public_data, private_data,
        correlation_id, idempotency_key
      ) VALUES (
        ${order.id}, 'return.requested', 'customer', 'self-service', ${transaction.json({ return: 'requested' })},
        ${transaction.json({ returnNumber: publicNumber })}, ${transaction.json({ reason: input.reason.trim() })},
        ${correlationId}, ${`return:${returnId}:requested`}
      )
    `
    await transaction`
      INSERT INTO outbox_events (
        aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
      ) VALUES (
        'return', ${returnId}, 'return.requested',
        ${transaction.json({ returnId, returnNumber: publicNumber, orderNumber: input.orderNumber })},
        ${correlationId}, ${`return:${returnId}:notification:requested`}
      )
    `
    return { id: publicNumber, status: 'requested', duplicate: false }
  })
}

export async function transitionReturn(input: {
  publicNumber: string
  status: ReturnState
  reason: string
  resolution?: string
  refundAmountCents?: number
  actorId: string
  correlationId: string
}) {
  const sql = useDatabase()
  return sql.begin('isolation level serializable', async (transaction) => {
    const [record] = await transaction<
      { id: string; order_id: string; status: ReturnState; payment_intent_id: string; captured_cents: number }[]
    >`
      SELECT r.id, r.order_id, r.status, payment.id AS payment_intent_id,
             CASE WHEN payment.status IN ('captured', 'partially_refunded', 'refunded')
                  THEN payment.amount_cents ELSE 0 END AS captured_cents
      FROM returns r
      JOIN payment_intents payment ON payment.order_id = r.order_id
      WHERE r.public_number = ${input.publicNumber}
      FOR UPDATE OF r, payment
    `
    if (!record) throw createError({ statusCode: 404, statusMessage: 'Devolución no encontrada' })
    if (record.status === input.status) return { id: input.publicNumber, status: record.status, duplicate: true }
    assertTransition(returnTransitions, record.status, input.status)
    if (input.status === 'resolved' && !input.resolution?.trim()) {
      throw createError({ statusCode: 422, statusMessage: 'La resolución es obligatoria' })
    }

    let refundId: string | null = null
    if (input.refundAmountCents) {
      if (input.status !== 'resolved') {
        throw createError({ statusCode: 422, statusMessage: 'El reembolso requiere resolver la devolución' })
      }
      const [refunded] = await transaction<{ amount: number }[]>`
        SELECT COALESCE(sum(amount_cents), 0)::int AS amount FROM refunds
        WHERE payment_intent_id = ${record.payment_intent_id}
          AND status NOT IN ('failed', 'cancelled')
      `
      const remaining = record.captured_cents - (refunded?.amount ?? 0)
      if (input.refundAmountCents > remaining) {
        throw createError({ statusCode: 422, statusMessage: 'El reembolso supera el importe capturado pendiente' })
      }
      refundId = randomUUID()
      await transaction`
        INSERT INTO refunds (
          id, order_id, payment_intent_id, return_id, amount_cents, status, reason, idempotency_key
        ) VALUES (
          ${refundId}, ${record.order_id}, ${record.payment_intent_id}, ${record.id},
          ${input.refundAmountCents}, 'requested', ${input.reason.trim()}, ${`refund:${record.id}:v1`}
        )
      `
      await transaction`
        INSERT INTO outbox_events (
          aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
        ) VALUES (
          'refund', ${refundId}, 'refund.execute.requested',
          ${transaction.json({ refundId, returnId: record.id, amountCents: input.refundAmountCents })},
          ${input.correlationId}, ${`refund:${refundId}:execute`}
        )
      `
    }

    await transaction`
      UPDATE returns SET status = ${input.status}, resolution = ${input.resolution?.trim() || null}, updated_at = now()
      WHERE id = ${record.id}
    `
    await transaction`
      INSERT INTO order_events (
        order_id, event_type, actor_type, actor_id, origin, reason, from_state, to_state,
        public_data, private_data, correlation_id, idempotency_key
      ) VALUES (
        ${record.order_id}, 'return.transitioned', 'staff', ${input.actorId}, 'admin', ${input.reason.trim()},
        ${transaction.json({ return: record.status })}, ${transaction.json({ return: input.status })},
        ${transaction.json({ returnNumber: input.publicNumber })},
        ${transaction.json({ resolution: input.resolution?.trim() || null, refundId })},
        ${input.correlationId}, ${`return:${record.id}:${input.status}`}
      ) ON CONFLICT (order_id, idempotency_key) DO NOTHING
    `
    await transaction`
      INSERT INTO audit_log (
        actor_type, actor_id, action, resource_type, resource_id, before_redacted,
        after_redacted, reason, correlation_id
      ) VALUES (
        'staff', ${input.actorId}, 'return.transition', 'return', ${input.publicNumber},
        ${transaction.json({ status: record.status })},
        ${transaction.json({ status: input.status, refundAmountCents: input.refundAmountCents ?? null })},
        ${input.reason.trim()}, ${input.correlationId}
      )
    `
    return { id: input.publicNumber, status: input.status, refundId, duplicate: false }
  })
}
