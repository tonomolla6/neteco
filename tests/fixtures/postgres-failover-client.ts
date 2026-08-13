import postgres from 'postgres'

const connection = process.env.DATABASE_URL?.trim()
const paymentIntentId = process.env.PAYMENT_INTENT_ID?.trim()
const correlationId = process.env.CORRELATION_ID?.trim()
if (!connection || !paymentIntentId || !correlationId) {
  throw new Error('DATABASE_URL, PAYMENT_INTENT_ID and CORRELATION_ID are required')
}

const sql = postgres(connection, { max: 1, connect_timeout: 5 })

try {
  await sql.begin(async (transaction) => {
    await transaction`UPDATE payment_intents SET status = 'captured' WHERE id = ${paymentIntentId}`
    await transaction`
      INSERT INTO payment_events (
        payment_intent_id, provider_event_id, event_type, status, amount_cents,
        payload_hash, sanitized_payload, correlation_id
      ) SELECT id, 'simulated-failover', 'payment.captured', 'captured', amount_cents,
               repeat('0', 64), '{}'::jsonb, ${correlationId}
        FROM payment_intents WHERE id = ${paymentIntentId}
    `
    process.stdout.write('READY\n')
    await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()))
    await transaction`SELECT 1`
  })
} finally {
  await sql.end({ timeout: 1 })
}
