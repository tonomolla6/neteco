import postgres from 'postgres'

const connection = process.env.DATABASE_URL?.trim()
if (!connection) throw new Error('DATABASE_URL is required')
const sql = postgres(connection, { max: 1, connect_timeout: 10 })

try {
  const [signals] = await sql<
    Array<{
      deadLetters: number
      oldestQueueMinutes: number | null
      invalidPaymentWebhooks: number
      stalePayments: number
      inventoryExceptions: number
      fiscalExceptions: number
      staleShipments: number
      supportOverdue: number
      communicationFailures: number
    }>
  >`
    SELECT
      (SELECT count(*)::int FROM outbox_events WHERE status = 'dead') AS "deadLetters",
      (SELECT floor(extract(epoch FROM (now() - min(created_at))) / 60)::int FROM outbox_events
       WHERE status IN ('pending', 'retry', 'processing')) AS "oldestQueueMinutes",
      (SELECT count(*)::int FROM webhook_inbox
       WHERE provider = 'redsys' AND NOT signature_valid AND received_at > now() - interval '15 minutes') AS "invalidPaymentWebhooks",
      (SELECT count(*)::int FROM orders
       WHERE payment_status IN ('initiated', 'pending') AND created_at < now() - interval '30 minutes') AS "stalePayments",
      (SELECT count(*)::int FROM inventory_balances balance
       WHERE balance.physical_quantity < 0 OR balance.blocked_quantity > balance.physical_quantity
          OR balance.physical_quantity <> COALESCE((
            SELECT sum(movement.physical_delta)::int FROM inventory_movements movement
            WHERE movement.variant_id = balance.variant_id AND movement.location_id = balance.location_id
          ), 0)) AS "inventoryExceptions",
      (SELECT count(*)::int FROM invoices
       WHERE reconciliation_required OR status IN ('failed', 'fiscal_pending')) AS "fiscalExceptions",
      (SELECT count(*)::int FROM shipments
       WHERE status NOT IN ('delivered', 'cancelled', 'returned')
         AND updated_at < now() - interval '48 hours') AS "staleShipments",
      (SELECT count(*)::int FROM support_tickets
       WHERE status NOT IN ('resolved', 'closed') AND sla_due_at < now()) AS "supportOverdue",
      (SELECT count(*)::int FROM communication_deliveries
       WHERE status IN ('bounced', 'complained') AND updated_at > now() - interval '15 minutes') AS "communicationFailures"
  `
  if (!signals) throw new Error('Operational signal query returned no row')
  const thresholds = {
    deadLetters: 0,
    oldestQueueMinutes: Number(process.env.ALERT_MAX_QUEUE_AGE_MINUTES ?? 15),
    invalidPaymentWebhooks: Number(process.env.ALERT_INVALID_PAYMENT_WEBHOOKS ?? 5),
    stalePayments: 0,
    inventoryExceptions: 0,
    fiscalExceptions: 0,
    staleShipments: 0,
    supportOverdue: 0,
    communicationFailures: Number(process.env.ALERT_COMMUNICATION_FAILURES ?? 0)
  }
  const alerts = [
    signals.deadLetters > thresholds.deadLetters ? 'dead_letters' : null,
    (signals.oldestQueueMinutes ?? 0) > thresholds.oldestQueueMinutes ? 'queue_age' : null,
    signals.invalidPaymentWebhooks > thresholds.invalidPaymentWebhooks ? 'invalid_payment_webhooks' : null,
    signals.stalePayments > thresholds.stalePayments ? 'stale_payments' : null,
    signals.inventoryExceptions > thresholds.inventoryExceptions ? 'inventory_reconciliation' : null,
    signals.fiscalExceptions > thresholds.fiscalExceptions ? 'fiscal_reconciliation' : null,
    signals.staleShipments > thresholds.staleShipments ? 'stale_shipments' : null,
    signals.supportOverdue > thresholds.supportOverdue ? 'support_sla' : null,
    signals.communicationFailures > thresholds.communicationFailures ? 'communication_delivery' : null
  ].filter(Boolean)
  process.stdout.write(
    `${JSON.stringify({
      event: alerts.length ? 'operational.alerts.active' : 'operational.alerts.clear',
      occurredAt: new Date().toISOString(),
      alerts,
      signals,
      thresholds
    })}\n`
  )
  if (alerts.length) process.exitCode = 2
} finally {
  await sql.end({ timeout: 5 })
}
