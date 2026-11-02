import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { issueStoreCredit } from '../../workers/pricing/store-credit'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { d1OverSqlite } from '../support/d1-sqlite'
import { CLAIMS } from './d1-fulfillment-fixture'

const migration = (name: string) => readFile(new URL(`../../db/d1/migrations/${name}`, import.meta.url), 'utf8')

/** PRI-018 downstream: pricing/credit tables (0146), pre-authorisations (0126), checkout wiring (0152) and the downstream rules (0153). */
export async function applyStoreCreditMigrations(sqlite: DatabaseSync) {
  for (const name of ['0089_sales_quotes.sql', '0101_b2b_price_lists_credit.sql'])
    if (
      !sqlite
        .prepare('SELECT 1 FROM sqlite_schema WHERE name=?')
        .get(name === '0089_sales_quotes.sql' ? 'sales_quotes' : 'b2b_price_lists')
    )
      sqlite.exec(await migration(name))
  if (!sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='store_credit_ledger'").get())
    sqlite.exec(await migration('0146_pricing_auto_discounts_credit_deposits.sql'))
  if (!sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='promotion_rules'").get()) {
    const adapter = d1OverSqlite(sqlite)
    await adapter.batch(splitDemoSql(await migration('0072_promotions.sql')).map((sql) => adapter.prepare(sql)))
  }
  if (!sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='payment_preauths'").get())
    sqlite.exec(await migration('0126_payment_extended.sql'))
  sqlite.exec(await migration('0152_checkout_pricing_wire.sql'))
  sqlite.exec(await migration('0153_store_credit_downstream.sql'))
}

/** Funds the customer's store credit through the real admin issuance path. */
export async function fundStoreCredit(database: D1Database, customerId: string, amountCents: number) {
  const at = new Date(Date.now() - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  await issueStoreCredit(
    database,
    CLAIMS,
    {
      customerId,
      kind: 'compensation_coupon',
      sourceRef: `downstream-${crypto.randomUUID()}`,
      amountCents,
      expiresInDays: 60,
      reason: 'Compensacion para pruebas de devolucion'
    },
    crypto.randomUUID(),
    at
  )
}
