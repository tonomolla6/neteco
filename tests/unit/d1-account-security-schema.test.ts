import { readFile, readdir } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { d1OverSqlite } from '../support/d1-sqlite'
import { prepareEmailOutboxEnqueue } from '../../workers/communications/email-outbox'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'

const directory = new URL('../../db/d1/migrations/', import.meta.url)
async function migrated() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys=ON')
  const database = d1OverSqlite(sqlite)
  const files = (await readdir(directory)).filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)).sort()
  try {
    for (const file of files) {
      await database.batch(
        splitDemoSql(await readFile(new URL(file, directory), 'utf8')).map((sql) => database.prepare(sql))
      )
    }
    return { sqlite, database }
  } catch (error) {
    sqlite.close()
    throw error
  }
}

it.each(['identity.security.password_rotated', 'identity.security.mfa_changed', 'identity.security.fiscal_changed'])(
  'permits the governed %s occurrence through the real outbox schema',
  async (eventType) => {
    const { sqlite, database } = await migrated()
    try {
      // Exercise the schema directly first, independent of the TS registration.
      sqlite
        .prepare(
          `INSERT INTO email_outbox_events(id,source_event_id,event_type,source_kind,source_id,schema_version,created_at)
        VALUES(?,?,?,'identity',?,1,'2026-10-09T12:00:00Z')`
        )
        .run(
          'email:' + 'a'.repeat(64),
          '10000000-0000-4000-8000-000000000001',
          eventType,
          '10000000-0000-4000-8000-000000000002'
        )
      expect(sqlite.prepare('SELECT event_type FROM email_outbox_events').get()).toEqual({ event_type: eventType })
      expect(sqlite.prepare('SELECT count(*) n FROM email_outbox_delivery').get()).toEqual({ n: 1 })
      expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(() => sqlite.exec(`UPDATE email_outbox_events SET source_kind='order'`)).toThrow('immutable')
      expect(() => sqlite.exec('DELETE FROM email_outbox_events')).toThrow('immutable')
      // The public internal enqueue contract must agree with SQL, not bypass it.
      const statement = await prepareEmailOutboxEnqueue(database, {
        sourceEventId: '10000000-0000-4000-8000-000000000003',
        sourceId: '10000000-0000-4000-8000-000000000002',
        sourceKind: 'identity',
        eventType: eventType as Parameters<typeof prepareEmailOutboxEnqueue>[1]['eventType'],
        now: '2026-10-09T12:00:00Z'
      })
      await database.batch([statement.statement])
      expect(sqlite.prepare('SELECT count(*) n FROM email_outbox_events').get()).toEqual({ n: 2 })
    } finally {
      sqlite.close()
    }
  }
)

async function preservePopulatedOutbox(database: D1Database) {
  const files = (await readdir(directory)).filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)).sort()
  for (const file of files.filter((file) => Number(file.slice(0, 4)) <= 70)) {
    await database.batch(
      splitDemoSql(await readFile(new URL(file, directory), 'utf8')).map((sql) => database.prepare(sql))
    )
  }
  const eventId = 'email:' + 'b'.repeat(64)
  await database.batch([
    database
      .prepare(
        `INSERT INTO email_outbox_events(id,source_event_id,event_type,source_kind,source_id,schema_version,created_at)
      VALUES(?,'10000000-0000-4000-8000-000000000001','order.created','order','10000000-0000-4000-8000-000000000002',1,'2026-10-09T12:00:00Z')`
      )
      .bind(eventId),
    database
      .prepare("INSERT INTO email_dispatch_inbox(event_id,received_at) VALUES(?,'2026-10-09T12:00:00Z')")
      .bind(eventId)
  ])
  const tables = [
    'email_outbox_events',
    'email_outbox_delivery',
    'email_dispatch_inbox',
    'transactional_email_deliveries'
  ]
  const before = await Promise.all(
    tables.map(async (table) => (await database.prepare(`SELECT * FROM ${table}`).all()).results)
  )
  const sql = await readFile(new URL('0071_account_security_notices.sql', directory), 'utf8')
  const broken = sql.replace(
    'INSERT INTO identity_account_security_guards(id,passed)',
    "INSERT INTO email_outbox_delivery(event_id,available_at) VALUES('synthetic-missing-parent','2026-10-09T12:00:00Z');\nINSERT INTO identity_account_security_guards(id,passed)"
  )
  await expect(database.batch(splitDemoSql(broken).map((statement) => database.prepare(statement)))).rejects.toThrow(
    'account_security_notice_atomic_guard'
  )
  for (let i = 0; i < tables.length; i++)
    expect((await database.prepare(`SELECT * FROM ${tables[i]}`).all()).results).toEqual(before[i])
  await database.batch(splitDemoSql(sql).map((statement) => database.prepare(statement)))
  for (let i = 0; i < tables.length; i++)
    expect((await database.prepare(`SELECT * FROM ${tables[i]}`).all()).results).toEqual(before[i])
  expect((await database.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  // An invalid child still fails: deferred migration must not disable FKs.
  await expect(
    database
      .prepare("INSERT INTO email_dispatch_inbox(event_id,received_at) VALUES('missing','2026-10-09T12:00:00Z')")
      .run()
  ).rejects.toThrow()
  const triggers = await database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='trigger' AND name IN('email_outbox_replay_guard','email_outbox_events_no_update','email_outbox_events_no_delete','email_outbox_delivery_on_event','operational_email_suppressions_insert_guard') ORDER BY name"
    )
    .all()
  expect(triggers.results).toHaveLength(5)
}

it('upgrades populated SQLite outbox without changing pending work or immutable receipts', async () => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys=ON')
  try {
    await preservePopulatedOutbox(d1OverSqlite(sqlite))
  } finally {
    sqlite.close()
  }
})

it('upgrades populated native workerd D1 outbox without disabling FKs or losing child rows', async () => {
  let outbound = 0
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'account-security-schema-native',
      modules: true,
      script: 'export default {fetch(){return new Response("schema probe")}}',
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      cf: false,
      telemetry: { enabled: false },
      log: new NoOpLog(),
      d1Databases: { DB: '00000000-0000-4000-8000-000000000072' },
      outboundService: () => {
        outbound++
        throw Error('unexpected_outbound')
      }
    })
  )
  try {
    await preservePopulatedOutbox((await runtime.getD1Database('DB')) as unknown as D1Database)
    expect(outbound).toBe(0)
  } finally {
    await runtime.dispose()
  }
}, 60000)
