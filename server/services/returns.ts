import { randomBytes, randomUUID } from 'node:crypto'
import { createError, getCookie, type H3Event } from 'h3'
import { assertTransition, returnTransitions, type ReturnState } from '../domain/states'
import { splitGross } from '../domain/money'
import { useDatabase } from '../db/client'
import { hashAccessToken } from '../utils/access-token'

function publicReturnNumber() {
  return `RMA${randomBytes(7).toString('hex').slice(0, 10).toUpperCase()}`
}

const returnStatusLabels: Record<ReturnState, string> = {
  requested: 'solicitada',
  approved: 'aprobada',
  rejected: 'rechazada',
  in_transit: 'en tránsito',
  received: 'recibida',
  inspected: 'inspeccionada',
  resolved: 'resuelta'
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
      { id: string; fulfillment_status: string; delivered_at: Date | null; customer_id: string | null }[]
    >`
      SELECT orders.id, orders.fulfillment_status, orders.delivered_at, orders.customer_id
      FROM orders
      WHERE orders.public_number = ${input.orderNumber}
        AND (
          EXISTS (
            SELECT 1 FROM order_access_sessions guest_session
            WHERE guest_session.order_id = orders.id
              AND guest_session.token_hash = ${access.tokenHash}
              AND guest_session.revoked_at IS NULL AND guest_session.expires_at > now()
          )
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
    if (!order.delivered_at || order.delivered_at.getTime() < Date.now() - 30 * 24 * 60 * 60_000) {
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
    if (record.status === input.status) {
      if (input.refundAmountCents) {
        const [existingRefund] = await transaction<{ id: string }[]>`
          SELECT id FROM refunds WHERE idempotency_key = ${`refund:${record.id}:v1`}
        `
        if (existingRefund) {
          return { id: input.publicNumber, status: record.status, refundId: existingRefund.id, duplicate: true }
        }
      } else {
        return { id: input.publicNumber, status: record.status, duplicate: true }
      }
    }
    if (record.status !== input.status) assertTransition(returnTransitions, record.status, input.status)
    if (input.status === 'resolved' && record.status !== 'resolved' && !input.resolution?.trim()) {
      throw createError({ statusCode: 422, statusMessage: 'La resolución es obligatoria' })
    }

    let refundId: string | null = null
    if (input.status === 'resolved' && record.status !== 'resolved') {
      const restockLines = await transaction<
        { returnLineId: string; variantId: string; quantity: number; locationId: string }[]
      >`
        SELECT returned.id AS "returnLineId", line.variant_id AS "variantId", returned.quantity,
               reservation.location_id AS "locationId"
        FROM return_lines returned
        JOIN order_lines line ON line.id = returned.order_line_id
        JOIN LATERAL (
          SELECT location_id
          FROM inventory_reservations
          WHERE order_id = ${record.order_id} AND variant_id = line.variant_id
          ORDER BY created_at
          LIMIT 1
        ) reservation ON true
        WHERE returned.return_id = ${record.id}
        ORDER BY line.variant_id, reservation.location_id, returned.id
      `
      for (const line of restockLines) {
        await transaction`
          UPDATE inventory_balances
          SET physical_quantity = physical_quantity + ${line.quantity},
              version = version + 1,
              updated_at = now()
          WHERE variant_id = ${line.variantId} AND location_id = ${line.locationId}
        `
        await transaction`
          INSERT INTO inventory_movements (
            variant_id, location_id, movement_type, quantity, physical_delta, reserved_delta,
            reference_type, reference_id, actor_id, reason, idempotency_key
          ) VALUES (
            ${line.variantId}, ${line.locationId}, 'return', ${line.quantity}, ${line.quantity}, 0,
            'return', ${record.id}, ${input.actorId}, ${input.reason.trim()},
            ${`return:${record.id}:restock:${line.returnLineId}`}
          ) ON CONFLICT (idempotency_key) DO NOTHING
        `
      }
      if (restockLines.length > 0) {
        const [returnCoverage] = await transaction<{ fullyReturned: boolean }[]>`
          SELECT NOT EXISTS (
            SELECT 1
            FROM order_lines ordered
            WHERE ordered.order_id = ${record.order_id}
              AND ordered.quantity > (
                SELECT COALESCE(sum(returned.quantity), 0)
                FROM return_lines returned
                JOIN returns return_record ON return_record.id = returned.return_id
                WHERE returned.order_line_id = ordered.id
                  AND (return_record.status = 'resolved' OR return_record.id = ${record.id})
              )
          ) AS "fullyReturned"
        `
        if (returnCoverage?.fullyReturned) {
          await transaction`
            UPDATE orders
            SET inventory_status = 'returned', fulfillment_status = 'returned', updated_at = now()
            WHERE id = ${record.order_id}
          `
          await transaction`
            UPDATE fulfillments SET status = 'returned', updated_at = now()
            WHERE order_id = ${record.order_id}
          `
        }
      }
    }
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
      const refundSourceLines = await transaction<
        Array<{
          orderLineId: string
          quantity: number
          orderQuantity: number
          totalGrossCents: number
          taxRateBasisPoints: number
          sku: string
          name: string
          variantName: string
        }>
      >`
        SELECT line.id AS "orderLineId", returned.quantity, line.quantity AS "orderQuantity",
               line.total_gross_cents AS "totalGrossCents",
               line.tax_rate_basis_points AS "taxRateBasisPoints", line.sku, line.name,
               line.variant_name AS "variantName"
        FROM return_lines returned
        JOIN order_lines line ON line.id = returned.order_line_id
        WHERE returned.return_id = ${record.id}
        ORDER BY line.id
        FOR UPDATE OF line
      `
      const refundableGross = refundSourceLines.reduce(
        (total, line) => total + Math.floor((line.totalGrossCents * line.quantity) / line.orderQuantity),
        0
      )
      if (input.refundAmountCents > refundableGross) {
        throw createError({ statusCode: 422, statusMessage: 'El reembolso supera el valor de las líneas devueltas' })
      }
      let allocatedGross = 0
      for (const [index, line] of refundSourceLines.entries()) {
        const lineCapacity = Math.floor((line.totalGrossCents * line.quantity) / line.orderQuantity)
        const grossCents =
          index === refundSourceLines.length - 1
            ? input.refundAmountCents - allocatedGross
            : Math.min(
                lineCapacity,
                Math.floor((input.refundAmountCents * lineCapacity) / Math.max(refundableGross, 1))
              )
        if (grossCents <= 0) continue
        allocatedGross += grossCents
        const split = splitGross(grossCents, line.taxRateBasisPoints)
        await transaction`
          INSERT INTO refund_lines (
            refund_id, order_line_id, component_type, quantity, gross_cents, net_cents, tax_cents,
            tax_rate_basis_points, fiscal_snapshot
          ) VALUES (
            ${refundId}, ${line.orderLineId}, 'line', ${line.quantity}, ${grossCents}, ${split.netCents},
            ${split.taxCents}, ${line.taxRateBasisPoints},
            ${transaction.json({ sku: line.sku, name: line.name, variantName: line.variantName })}
          )
        `
      }
      if (allocatedGross !== input.refundAmountCents) throw new Error('Refund fiscal allocation does not balance')
      await transaction`
        INSERT INTO outbox_events (
          aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
        ) VALUES (
          'refund', ${refundId}, 'refund.execute.requested',
          ${transaction.json({ refundId, returnId: record.id, amountCents: input.refundAmountCents })},
          ${input.correlationId}, ${`refund:${refundId}:execute`}
        )
      `
      await transaction`
        INSERT INTO order_events (
          order_id, event_type, actor_type, actor_id, origin, reason, to_state,
          public_data, private_data, correlation_id, idempotency_key
        ) VALUES (
          ${record.order_id}, 'refund.requested', 'staff', ${input.actorId}, 'admin', ${input.reason.trim()},
          ${transaction.json({ refund: 'requested' })},
          ${transaction.json({ amountCents: input.refundAmountCents })},
          ${transaction.json({ refundId, returnId: record.id })}, ${input.correlationId},
          ${`refund:${refundId}:requested`}
        ) ON CONFLICT (order_id, idempotency_key) DO NOTHING
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
      INSERT INTO outbox_events (
        aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
      ) VALUES (
        'return', ${record.id}, 'return.status.updated',
        ${transaction.json({
          returnNumber: input.publicNumber,
          statusLabel: returnStatusLabels[input.status],
          refundAmountCents: input.refundAmountCents ?? null
        })},
        ${input.correlationId}, ${`return:${record.id}:notification:${input.status}`}
      ) ON CONFLICT (idempotency_key) DO NOTHING
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
