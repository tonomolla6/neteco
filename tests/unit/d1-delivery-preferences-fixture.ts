import { readFile } from 'node:fs/promises'
import { preferencesFixture } from './d1-account-preferences-fixture'
export { CLAIMS, OPTIONS, KEY, ACTOR, CUSTOMER, SESSION, NOW, BEFORE } from './d1-account-preferences-fixture'
export async function deliveryPreferencesFixture() {
  const f = await preferencesFixture()
  try {
    f.sqlite.exec(await readFile('db/d1/migrations/0070_delivery_preferences.sql', 'utf8'))
    return f
  } catch (cause) {
    f.sqlite.close()
    throw cause
  }
}
