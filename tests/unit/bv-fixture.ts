import { readFile } from 'node:fs/promises'
import { fulfillmentFixture, CLAIMS, utc } from './d1-fulfillment-fixture'
import { seedDefaultMarkets } from '../../workers/catalog/market-catalog'

export { CLAIMS, utc }
export const ID = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000bb1`

const MIGRATIONS = [
  '0120_market_catalog_international_shipping.sql',
  '0141_templates_brand_warehouse_adr.sql',
  '0150_international_seo_channel_feeds_adr_lq.sql'
]

/** Admin (MFA, administration.manage) fixture plus the BV migrations; relative dates only. */
export async function bvFixture() {
  const fixture = await fulfillmentFixture()
  for (const name of MIGRATIONS) {
    fixture.sqlite.exec(await readFile(new URL(`../../db/d1/migrations/${name}`, import.meta.url), 'utf8'))
  }
  await seedDefaultMarkets(fixture.database, { now: () => utc(-30000) })
  const now = utc(-60000)
  const operator = '10000000-0000-4000-8000-0000000bb002'
  const operatorSession = '20000000-0000-4000-8000-0000000bb002'
  fixture.sqlite.exec(`
    INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
      VALUES('${operator}','plain@example.invalid','synthetic','${now}','active','${now}','${now}');
    INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
      VALUES('${operatorSession}','${operator}',1,1,'${now}','${utc(3600000)}');
  `)
  return {
    ...fixture,
    plainClaims: { identityId: operator, sessionId: operatorSession, sessionVersion: 1 }
  }
}
