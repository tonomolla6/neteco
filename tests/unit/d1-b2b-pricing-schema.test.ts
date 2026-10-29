import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'

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
    installSyntheticCommandContexts(db, [
      { listId: 'list', companyId: null },
      { listId: 'bad', companyId: null },
      { listId: 'list', companyId: 'company-approved' },
      { listId: 'list', companyId: 'company-pending' }
    ])
    db.exec(`
      INSERT INTO customers(id, created_at, updated_at) VALUES
        ('customer-approved', '${now}', '${now}'), ('customer-pending', '${now}', '${now}');
      INSERT INTO companies(id, customer_id, legal_name, status, created_at, updated_at) VALUES
        ('company-approved', 'customer-approved', 'Approved', 'approved', '${now}', '${now}'),
        ('company-pending', 'customer-pending', 'Pending', 'pending', '${now}', '${now}');
      INSERT INTO b2b_price_lists(id, code, name, version, valid_from, created_at, updated_at)
      VALUES ('list', 'LIST', 'List', 1, '${now}', '${now}', '${now}');
    `)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

describe('B2B schema invariants', () => {
  it('does not create payment or credit prototype objects in migration 0101', async () => {
    const db = await fixture()
    try {
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name LIKE 'b2b_credit_%' OR name LIKE 'b2b_terms_%' OR name='b2b_payment_terms'"
          )
          .all()
      ).toEqual([])
    } finally {
      db.close()
    }
  })
  it('accepts a current assignment for an approved company', async () => {
    const db = await fixture()
    try {
      db.prepare(
        'INSERT INTO b2b_company_assignments(company_id, price_list_id, version, valid_from, updated_at) VALUES (?, ?, 1, ?, ?)'
      ).run('company-approved', 'list', now, now)
      expect(
        db.prepare('SELECT price_list_id FROM b2b_company_assignments WHERE company_id=?').get('company-approved')
      ).toMatchObject({ price_list_id: 'list' })
    } finally {
      db.close()
    }
  })

  it('rejects assignments for an unapproved company', async () => {
    const db = await fixture()
    try {
      expect(() =>
        db
          .prepare(
            'INSERT INTO b2b_company_assignments(company_id, price_list_id, version, valid_from, updated_at) VALUES (?, ?, 1, ?, ?)'
          )
          .run('company-pending', 'list', now, now)
      ).toThrow(/b2b_company_not_approved/)
    } finally {
      db.close()
    }
  })

  it('rejects invalid validity windows and noncanonical instants', async () => {
    const db = await fixture()
    try {
      const insert = db.prepare(
        'INSERT INTO b2b_price_lists(id, code, name, version, valid_from, valid_until, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)'
      )
      expect(() => insert.run('bad', 'BAD', 'Bad', now, now, now, now)).toThrow()
      expect(() => insert.run('bad', 'BAD', 'Bad', '2026-08-25', null, now, now)).toThrow()
    } finally {
      db.close()
    }
  })
  it('requires monotonically increasing versions on updates', async () => {
    const db = await fixture()
    try {
      expect(() => db.exec("UPDATE b2b_price_lists SET name='Changed' WHERE id='list'")).toThrow()
      db.exec("UPDATE b2b_price_lists SET name='Changed', version=2 WHERE id='list'")
      expect(() => db.exec("UPDATE b2b_price_lists SET version=4 WHERE id='list'")).toThrow()
    } finally {
      db.close()
    }
  })

  it('rejects discounts outside 0 to 95 percent', async () => {
    const db = await fixture()
    try {
      db.exec(
        "INSERT INTO categories(id, legacy_id, name, slug, status, sort_order) VALUES ('cat', 1, 'Category', 'category', 'published', 1)"
      )
      const insert = db.prepare(
        'INSERT INTO b2b_category_rules(price_list_id, category_id, discount_basis_points) VALUES (?, ?, ?)'
      )
      expect(() => insert.run('list', 'cat', -1)).toThrow()
      expect(() => insert.run('list', 'cat', 9501)).toThrow(/CHECK constraint failed/)
      insert.run('list', 'cat', 9500)
      expect(db.prepare('SELECT discount_basis_points FROM b2b_category_rules').get()).toMatchObject({
        discount_basis_points: 9500
      })
    } finally {
      db.close()
    }
  })
  it('requires fixed contractual prices to be at least one cent at the database boundary', async () => {
    const db = await fixture()
    try {
      seedInventoryFixture(db)
      const insert = db.prepare(
        'INSERT INTO b2b_variant_rules(price_list_id,variant_id,unit_gross_cents) VALUES (?,?,?)'
      )
      expect(() => insert.run('list', 'v-1-1', 0)).toThrow(/CHECK constraint failed/)
      insert.run('list', 'v-1-1', 1)
      expect(
        db.prepare("SELECT unit_gross_cents FROM b2b_variant_rules WHERE price_list_id='list'").get()
      ).toMatchObject({ unit_gross_cents: 1 })
    } finally {
      db.close()
    }
  })
})
