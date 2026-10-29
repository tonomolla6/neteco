import { readFile } from 'node:fs/promises'
import { openMigratedDatabase, d1OverSqlite } from '../support/d1-sqlite'
import { deterministicUuid } from '../fixtures/deterministic'
export const NOW = '2030-01-02T12:00:00Z',
  BEFORE = '2020-01-01T00:00:00Z'
export const CUSTOMER = deterministicUuid('preferences-customer'),
  ACTOR = deterministicUuid('preferences-actor'),
  SESSION = deterministicUuid('preferences-session'),
  KEY = deterministicUuid('preferences-key')
export const CLAIMS = { identityId: ACTOR, sessionId: SESSION, sessionVersion: 1 },
  OPTIONS = { now: () => NOW }
export function preferenceSeeds() {
  return [
    `INSERT INTO customers(id,name,created_at,updated_at) VALUES('${CUSTOMER}','Cliente sintético','${BEFORE}','${BEFORE}')`,
    `INSERT INTO identities(id,email,password_hash,status,email_verified_at,customer_id,created_at,updated_at) VALUES('${ACTOR}','preferences@example.invalid','synthetic','active','${BEFORE}','${CUSTOMER}','${BEFORE}','${BEFORE}')`,
    `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES('${SESSION}','${ACTOR}',1,0,'${BEFORE}','2099-01-01T00:00:00Z')`
  ]
}
export async function preferencesFixture(withSchema = false) {
  const sqlite = await openMigratedDatabase()
  if (withSchema && !sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='customer_account_preferences'").get())
    sqlite.exec(await readFile('db/d1/migrations/0066_account_preferences.sql', 'utf8'))
  for (const sql of preferenceSeeds()) sqlite.exec(sql)
  return { sqlite, database: d1OverSqlite(sqlite) }
}
