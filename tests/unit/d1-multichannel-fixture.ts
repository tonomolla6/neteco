import { readFile } from 'node:fs/promises'
import {
  returnsFixture,
  CLAIMS as ADMIN_CLAIMS,
  BUYER_CLAIMS,
  CUSTOMER,
  BUYER,
  BUYER_SESSION,
  utc
} from './d1-returns-fixture'

export { ADMIN_CLAIMS, BUYER_CLAIMS, CUSTOMER, BUYER, BUYER_SESSION, utc }

export const OTHER_CUSTOMER = '40000000-0000-4000-8000-000000000046'
export const OTHER_BUYER = '50000000-0000-4000-8000-000000000046'
export const OTHER_SESSION = '60000000-0000-4000-8000-000000000046'
export const OTHER_BUYER_CLAIMS = {
  identityId: OTHER_BUYER,
  sessionId: OTHER_SESSION,
  sessionVersion: 1
}

export async function multichannelFixture() {
  const f = await returnsFixture()
  const { sqlite, database } = f

  // Ensure 0135 migration is loaded
  const migration0135 = await readFile(
    'db/d1/migrations/0135_multichannel_orchestration_notification_center.sql',
    'utf8'
  )
  sqlite.exec(migration0135)

  // Seed another customer for tenant isolation testing
  const now = utc(-30000)
  sqlite
    .prepare('INSERT INTO customers(id,name,created_at,updated_at) VALUES(?,?,?,?)')
    .run(OTHER_CUSTOMER, 'Other Tenant Customer', now, now)
  sqlite
    .prepare(
      "INSERT INTO identities(id,email,password_hash,email_verified_at,status,customer_id,created_at,updated_at) VALUES(?,?,'synthetic',?,'active',?,?,?)"
    )
    .run(OTHER_BUYER, 'other@example.invalid', now, OTHER_CUSTOMER, now, now)
  sqlite
    .prepare(
      'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,0,?,?)'
    )
    .run(OTHER_SESSION, OTHER_BUYER, now, utc(3600000))

  return {
    ...f,
    sqlite,
    database
  }
}
