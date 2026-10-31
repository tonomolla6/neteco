import type { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'

// canary.scheduled runs these stages whenever AUTH_ENABLED=true. Their tables
// live in migrations beyond the historical base fixture, so a test that drives
// the real scheduled entrypoint must provision exactly that schema (and no more).
const SCHEDULED_AUTH_STAGE_MIGRATIONS = [
  '0066_account_preferences.sql', // replenishment.reminders consent
  '0086_admin_order_bulk.sql', // orders.bulk-fulfillment
  '0136_account_lifecycle_preference_center_impersonation.sql', // replenishment.reminders
  '0149_category_merchandising_promo_fraud.sql' // security.promo-fraud-retention
] as const

export async function applyScheduledAuthStageSchema(sqlite: DatabaseSync): Promise<void> {
  for (const name of SCHEDULED_AUTH_STAGE_MIGRATIONS)
    sqlite.exec(await readFile(new URL(`../../db/d1/migrations/${name}`, import.meta.url), 'utf8'))
}
