import { readFile } from 'node:fs/promises'
import { supportFixture, CLAIMS, utc } from './d1-support-fixture'
import { publishEmailOutbox, receiveEmailDispatch } from '../../workers/communications/email-outbox'

export { CLAIMS, utc }
export async function communicationHistoryFixture() {
  const f = await supportFixture()
  f.sqlite.exec("INSERT INTO role_permissions VALUES('operator','administration.manage')")
  f.sqlite.exec(
    await readFile(new URL('../../db/d1/migrations/0070_delivery_preferences.sql', import.meta.url), 'utf8')
  )
  const migration = new URL('../../db/d1/migrations/0080_communication_history_commands.sql', import.meta.url)
  f.sqlite.exec(await readFile(migration, 'utf8'))
  await publishEmailOutbox(
    f.database,
    {
      send: async (message) => {
        await receiveEmailDispatch(f.database, message, utc())
      }
    },
    { now: utc(), limit: 100 }
  )
  const event = f.sqlite
    .prepare("SELECT id FROM email_outbox_events WHERE source_id=? AND event_type='order.created'")
    .get(f.order) as { id: string }
  if (!event) throw new Error('missing_real_order_created_fixture')
  const availableAt = utc(3600000)
  // Explicit preparation-failed work fixture: no provider or domain state is fabricated.
  f.sqlite
    .prepare(
      "UPDATE transactional_email_deliveries SET attempts=2,available_at=?,last_error_code='preparation_failed' WHERE event_id=?"
    )
    .run(availableAt, event.id)
  return {
    ...f,
    eventId: event.id,
    input: {
      expectedAttempts: 2,
      expectedAvailableAt: availableAt,
      reason: 'Revisada la causa transitoria de preparación local.'
    }
  }
}
