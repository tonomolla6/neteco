import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'

/** Extend an explicitly older email fixture with the real new sender schema.
 * Duplicate application deliberately fails; never hide a fixture's baseline. */
export async function applyDeliveryPreferencesMigration(database: DatabaseSync) {
  database.exec(
    await readFile(new URL('../../db/d1/migrations/0070_delivery_preferences.sql', import.meta.url), 'utf8')
  )
}
