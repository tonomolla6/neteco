import { readFile } from 'node:fs/promises'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'

export { CLAIMS, BUYER_CLAIMS, CUSTOMER, utc }
export const OTHER_CLAIMS = {
  identityId: '10000000-0000-4000-8000-000000000999',
  sessionId: '20000000-0000-4000-8000-000000000999',
  sessionVersion: 1
}
export const key = () => crypto.randomUUID()

/**
 * Migrated D1 with an MFA admin (CLAIMS), a verified buyer owning CUSTOMER (BUYER_CLAIMS, no MFA),
 * an MFA identity without permissions (OTHER_CLAIMS), 0089, 0101 and 0148.
 * `order({ paid: false, delivered: false })` creates an awaiting-payment order owned by the buyer.
 */
export async function pricingFixture() {
  const f = await returnsFixture()
  const { sqlite } = f
  for (const name of [
    '0089_sales_quotes.sql',
    '0101_b2b_price_lists_credit.sql',
    '0148_pricing_auto_discounts_credit_deposits.sql'
  ])
    sqlite.exec(await readFile(new URL(`../../db/d1/migrations/${name}`, import.meta.url), 'utf8'))
  const before = utc(-60000)
  sqlite
    .prepare(
      "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES(?,?,'synthetic',?,'active',?,?)"
    )
    .run(OTHER_CLAIMS.identityId, 'other148@example.invalid', before, before, before)
  sqlite
    .prepare(
      'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,?)'
    )
    .run(OTHER_CLAIMS.sessionId, OTHER_CLAIMS.identityId, before, utc(3600000))
  return f
}
