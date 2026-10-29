import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  effectiveB2BGrossCentsExpression,
  effectiveB2BVersionIdExpression,
  inlineEffectivePricingSql
} from '../../workers/catalog/pricing'
import { resolveD1EffectiveB2BVariantPrice } from '../../workers/catalog/b2b-pricing'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'

const now = '2026-08-25T09:00:00Z'
const ADMIN = '10000000-0000-4000-8000-000000009999'
const ADMIN_SESSION = '20000000-0000-4000-8000-000000009999'
function installSyntheticCommandContexts(
  db: Awaited<ReturnType<typeof openMigratedDatabase>>,
  targets: Array<{ listId: string; companyId: string | null }>
) {
  db.exec(`INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES('${ADMIN}','b2b-admin@example.invalid','synthetic','${now}','active','${now}','${now}');
    INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES('${ADMIN_SESSION}','${ADMIN}',1,1,'${now}','2026-08-27T09:00:00Z');
    INSERT INTO roles(code,name,description) VALUES('b2b-admin','Admin','Synthetic');
    INSERT INTO permissions(code,resource,action,description) VALUES('administration.manage','administration','manage','Synthetic');
    INSERT INTO role_permissions(role_code,permission_code) VALUES('b2b-admin','administration.manage');
    INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES('${ADMIN}','b2b-admin','${now}')`)
  for (const [index, target] of targets.entries()) {
    const command = `fixture-${index}`
    db.prepare(
      'INSERT INTO b2b_pricing_commands(actor_id,command_id,session_id,session_version,action,payload_hash,input_json,receipt_json,created_at) VALUES(?,?,?,1,?,?,?,?,?)'
    ).run(
      ADMIN,
      command,
      ADMIN_SESSION,
      'fixture',
      '0'.repeat(64),
      '{}',
      JSON.stringify({ priceListId: target.listId, companyId: target.companyId }),
      now
    )
    db.prepare(
      'INSERT INTO b2b_pricing_write_context(actor_id,command_id,price_list_id,company_id) VALUES(?,?,?,?)'
    ).run(ADMIN, command, target.listId, target.companyId)
  }
}

async function fixture() {
  const db = await openMigratedDatabase()
  try {
    db.exec(await readFile('db/d1/migrations/0101_b2b_price_lists_credit.sql', 'utf8'))
    seedInventoryFixture(db)
    installSyntheticCommandContexts(db, [
      { listId: 'list', companyId: null },
      { listId: 'list', companyId: 'company' }
    ])
    db.exec(`
      INSERT INTO customers(id,created_at,updated_at) VALUES('customer','${now}','${now}');
      INSERT INTO companies(id,customer_id,legal_name,status,created_at,updated_at) VALUES('company','customer','Company','approved','${now}','${now}');
      INSERT INTO b2b_price_lists(id,code,name,version,valid_from,valid_until,created_at,updated_at) VALUES('list','LIST','List',1,'${now}','2026-08-26T09:00:00Z','${now}','${now}');
      INSERT INTO b2b_company_assignments(company_id,price_list_id,version,valid_from,valid_until,updated_at) VALUES('company','list',1,'${now}','2026-08-26T09:00:00Z','${now}');
      INSERT INTO b2b_category_rules(price_list_id,category_id,discount_basis_points) VALUES('list','c1',1500);
      INSERT INTO b2b_variant_rules(price_list_id,variant_id,unit_gross_cents) VALUES('list','v-1-1',333);
      UPDATE variants SET price_gross_cents=1333 WHERE id='v-2-1';
    `)
    return db
  } catch (e) {
    db.close()
    throw e
  }
}
function price(db: Awaited<ReturnType<typeof fixture>>, variant: string, customer: string | null, instant = now) {
  const gross = inlineEffectivePricingSql(effectiveB2BGrossCentsExpression('v', '?1'), instant)
  const version = inlineEffectivePricingSql(effectiveB2BVersionIdExpression('v', '?1'), instant)
  return db
    .prepare(`SELECT ${gross} AS gross, ${version} AS version FROM variants v WHERE v.id=?2`)
    .get(customer, variant) as { gross: number; version: string }
}
describe('contractual effective pricing', () => {
  it('clamps a rounded category price to one cent', async () => {
    const db = await fixture()
    try {
      db.exec(
        "UPDATE variants SET price_gross_cents=1 WHERE id='v-2-1'; UPDATE b2b_category_rules SET discount_basis_points=9500 WHERE price_list_id='list' AND category_id='c1'"
      )
      expect(price(db, 'v-2-1', 'customer').gross).toBe(1)
      expect(
        await resolveD1EffectiveB2BVariantPrice(d1OverSqlite(db), {
          variantId: 'v-2-1',
          customerId: 'customer',
          instant: now
        })
      ).toMatchObject({ unitGrossCents: 1, source: 'b2b_category' })
    } finally {
      db.close()
    }
  })
  it('prioritizes variant over category and embeds list and assignment versions', async () => {
    const db = await fixture()
    try {
      expect(price(db, 'v-1-1', 'customer')).toEqual({ gross: 333, version: 'b2b:list:v3:a1:variant:v-1-1' })
      expect(price(db, 'v-2-1', 'customer')).toEqual({
        gross: 1133,
        version: 'b2b:list:v3:a1:category:c1:legacy:v-2-1'
      })
    } finally {
      db.close()
    }
  })
  it('uses public price when anonymous, outside validity or company not approved', async () => {
    const db = await fixture()
    try {
      expect(price(db, 'v-1-1', null)).toEqual({ gross: 500, version: 'legacy:v-1-1' })
      expect(price(db, 'v-1-1', 'customer', '2026-08-25T08:59:59Z').gross).toBe(500)
      expect(price(db, 'v-1-1', 'customer', '2026-08-26T09:00:00Z').gross).toBe(500)
      db.exec("UPDATE companies SET status='suspended' WHERE id='company'")
      expect(price(db, 'v-1-1', 'customer').gross).toBe(500)
    } finally {
      db.close()
    }
  })
  it('falls back for an inactive assignment', async () => {
    const db = await fixture()
    try {
      db.exec("UPDATE b2b_company_assignments SET active=0,version=version+1 WHERE company_id='company'")
      expect(price(db, 'v-1-1', 'customer').gross).toBe(500)
    } finally {
      db.close()
    }
  })
  it('returns tax split using the same contractual winner', async () => {
    const db = await fixture()
    try {
      const result = await resolveD1EffectiveB2BVariantPrice(d1OverSqlite(db), {
        variantId: 'v-1-1',
        customerId: 'customer',
        instant: now
      })
      expect(result).toMatchObject({
        unitGrossCents: 333,
        netCents: 275,
        taxCents: 58,
        taxRateBasisPoints: 2100,
        source: 'b2b_variant'
      })
    } finally {
      db.close()
    }
  })
  it('does not mistake a public price id for a contractual price marker', async () => {
    const db = await fixture()
    try {
      db.exec(
        "INSERT INTO variant_price_versions(id,variant_id,gross_cents,valid_from,status,reason,created_at) VALUES ('b2b:looks-like:variant:x','v-1-1',499,'2026-01-01T00:00:00Z','approved','Public','2026-01-01T00:00:00Z')"
      )
      const result = await resolveD1EffectiveB2BVariantPrice(d1OverSqlite(db), {
        variantId: 'v-1-1',
        customerId: null,
        instant: now
      })
      expect(result).toMatchObject({ unitGrossCents: 499, source: 'public' })
    } finally {
      db.close()
    }
  })
})
