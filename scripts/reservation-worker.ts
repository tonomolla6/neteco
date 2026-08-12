import { closeDatabase } from '../server/db/client'
import { expireInventoryReservations } from '../server/services/orders'

const batchSize = Number(process.env.RESERVATION_EXPIRY_BATCH_SIZE ?? 100)

try {
  const result = await expireInventoryReservations(batchSize)
  process.stdout.write(`${JSON.stringify({ event: 'inventory.reservations.expired', ...result })}\n`)
} finally {
  await closeDatabase()
}
