import { useDatabase } from '../../db/client'

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'administration.manage', { mfa: true })
  const sql = useDatabase()
  const [summary] = await sql`
    SELECT
      (SELECT count(*)::int FROM outbox_events WHERE status IN ('pending', 'retry', 'processing')) AS "queueDepth",
      (SELECT count(*)::int FROM outbox_events WHERE status = 'dead') AS "deadLetters",
      (SELECT count(*)::int FROM support_tickets
       WHERE status NOT IN ('resolved', 'closed') AND sla_due_at < now()) AS "supportOverdue",
      (SELECT count(*)::int FROM invoices
       WHERE reconciliation_required OR status IN ('failed', 'fiscal_pending')) AS "fiscalExceptions",
      (SELECT count(*)::int FROM refunds
       WHERE status IN ('requested', 'pending') AND updated_at < now() - interval '30 minutes') AS "staleRefunds",
      (SELECT count(*)::int FROM inventory_balances balance
       WHERE balance.physical_quantity < 0 OR balance.blocked_quantity > balance.physical_quantity) AS "inventoryExceptions",
      (SELECT count(*)::int FROM shipments
       WHERE status NOT IN ('delivered', 'cancelled', 'returned')
         AND updated_at < now() - interval '48 hours') AS "staleShipments",
      (SELECT count(*)::int FROM communication_deliveries
       WHERE status IN ('bounced', 'complained')
         AND updated_at > now() - interval '24 hours') AS "communicationFailures"
  `
  const queues = await sql`
    SELECT event_type AS "eventType", status, count(*)::int AS depth,
           min(created_at) AS "oldestAt", max(attempts)::int AS "maxAttempts"
    FROM outbox_events
    WHERE status IN ('pending', 'retry', 'processing', 'dead')
    GROUP BY event_type, status
    ORDER BY CASE status WHEN 'dead' THEN 0 WHEN 'retry' THEN 1 WHEN 'processing' THEN 2 ELSE 3 END,
             min(created_at)
  `
  const deadLetters = await sql`
    SELECT id, event_type AS "eventType", attempts, last_error_code AS "errorCode",
           left(COALESCE(last_error_message, ''), 300) AS "errorMessage", created_at AS "createdAt"
    FROM outbox_events WHERE status = 'dead'
    ORDER BY created_at LIMIT 100
  `
  return { summary, queues, deadLetters, generatedAt: new Date().toISOString() }
})
