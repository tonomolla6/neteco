import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { handleCartCommand } from '../../workers/cart-coordinator'
import { createCart, quoteCart, setCartLine } from '../../workers/catalog/cart'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'

const NOW = '2026-08-25T09:00:00Z'
const ADMIN = '10000000-0000-4000-8000-000000009999'
const ADMIN_SESSION = '20000000-0000-4000-8000-000000009999'
function installSyntheticCommandContexts(
  db: Awaited<ReturnType<typeof openMigratedDatabase>>,
  targets: Array<{ listId: string; companyId: string | null }>
) {
  db.exec(`INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES('${ADMIN}','b2b-admin@example.invalid','synthetic','${NOW}','active','${NOW}','${NOW}');
    INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES('${ADMIN_SESSION}','${ADMIN}',1,1,'${NOW}','2026-08-27T09:00:00Z');
    INSERT INTO roles(code,name,description) VALUES('b2b-admin','Admin','Synthetic');
    INSERT INTO permissions(code,resource,action,description) VALUES('administration.manage','administration','manage','Synthetic');
    INSERT INTO role_permissions(role_code,permission_code) VALUES('b2b-admin','administration.manage');
    INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES('${ADMIN}','b2b-admin','${NOW}')`)
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
      NOW
    )
    db.prepare(
      'INSERT INTO b2b_pricing_write_context(actor_id,command_id,price_list_id,company_id) VALUES(?,?,?,?)'
    ).run(ADMIN, command, target.listId, target.companyId)
  }
}

const CUSTOMER = '30000000-0000-4000-8000-000000000001'
const BUYER = '10000000-0000-4000-8000-000000000001'
const SESSION = '20000000-0000-4000-8000-000000000001'
const CLAIMS = { identityId: BUYER, sessionId: SESSION, sessionVersion: 1 }

async function world() {
  const sqlite = await openMigratedDatabase()
  try {
    sqlite.limits.exprDepth = 100
    sqlite.exec(await readFile('db/d1/migrations/0101_b2b_price_lists_credit.sql', 'utf8'))
    seedInventoryFixture(sqlite)
    installSyntheticCommandContexts(sqlite, [
      { listId: 'list', companyId: null },
      { listId: 'list', companyId: 'company' }
    ])
    const database = d1OverSqlite(sqlite)
    await provisionPublicationValidityFixture(database, {
      productIds: ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6'],
      now: '2026-01-01T00:00:00Z'
    })
    sqlite.exec(`
      INSERT INTO customers(id, created_at, updated_at) VALUES ('${CUSTOMER}', '${NOW}', '${NOW}');
      INSERT INTO companies(id, customer_id, legal_name, status, created_at, updated_at) VALUES ('company', '${CUSTOMER}', 'Empresa', 'approved', '${NOW}', '${NOW}');
      INSERT INTO identities(id,email,password_hash,email_verified_at,status,customer_id,created_at,updated_at) VALUES('${BUYER}','b2b@example.invalid','synthetic','${NOW}','active','${CUSTOMER}','${NOW}','${NOW}');
      INSERT INTO auth_sessions(id,identity_id,session_version,created_at,expires_at) VALUES('${SESSION}','${BUYER}',1,'${NOW}','2026-08-26T09:00:00Z');
      INSERT INTO b2b_price_lists(id,code,name,version,valid_from,created_at,updated_at) VALUES('list','LIST','Tarifa',1,'${NOW}','${NOW}','${NOW}');
      INSERT INTO b2b_variant_rules(price_list_id,variant_id,unit_gross_cents) VALUES('list','v-1-1',333);
      INSERT INTO b2b_company_assignments(company_id,price_list_id,version,valid_from,updated_at) VALUES('company','list',1,'${NOW}','${NOW}');
    `)
    const cart = await createCart(database, { correlationId: 'b2b', now: NOW })
    await setCartLine(database, {
      ...cart,
      expectedVersion: 1,
      idempotencyKey: 'add',
      variantId: 'v-1-1',
      quantity: 2,
      correlationId: 'b2b',
      now: NOW
    })
    return {
      sqlite,
      database,
      input: {
        cartId: cart.cartId,
        token: cart.token,
        expectedVersion: 2,
        idempotencyKey: 'quote',
        correlationId: 'b2b',
        now: NOW
      }
    }
  } catch (error) {
    sqlite.close()
    throw error
  }
}

describe('contractual quotes', () => {
  it('prices a verified company quote and preserves its tariff version in the immutable snapshot', async () => {
    const f = await world()
    try {
      const result = await quoteCart(f.database, { ...f.input, ownerSession: CLAIMS })
      expect(result.outcome).toBe('quoted')
      if (result.outcome !== 'quoted') throw new Error(result.outcome)
      expect(result.quote.lines[0]).toMatchObject({
        unitGrossCents: 333,
        quantity: 2,
        grossCents: 666,
        priceVersionId: 'b2b:list:v1:a1:variant:v-1-1'
      })
      expect(result.quote.snapshotHash).toMatch(/^[0-9a-f]{64}$/)
      const row = f.sqlite
        .prepare('SELECT unit_gross_cents,price_version_id FROM checkout_quote_lines WHERE quote_id=?')
        .get(result.quote.quoteId)
      expect(row).toMatchObject({ unit_gross_cents: 333, price_version_id: 'b2b:list:v1:a1:variant:v-1-1' })
      expect(await quoteCart(f.database, { ...f.input, ownerSession: CLAIMS })).toEqual(result)
    } finally {
      f.sqlite.close()
    }
  })
  it('gives an anonymous quote the public price', async () => {
    const f = await world()
    try {
      const result = await quoteCart(f.database, f.input)
      expect(result.outcome).toBe('quoted')
      if (result.outcome !== 'quoted') throw new Error(result.outcome)
      expect(result.quote.lines[0]).toMatchObject({ unitGrossCents: 500, priceVersionId: 'legacy:v-1-1' })
    } finally {
      f.sqlite.close()
    }
  })
  it('does not replay a contractual quote to an anonymous caller with the same key', async () => {
    const f = await world()
    try {
      await quoteCart(f.database, { ...f.input, ownerSession: CLAIMS })
      expect(await quoteCart(f.database, f.input)).toEqual({ outcome: 'conflict', code: 'conflict' })
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects an expired or revoked session even without a coupon', async () => {
    const f = await world()
    try {
      f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(NOW, SESSION)
      await expect(quoteCart(f.database, { ...f.input, ownerSession: CLAIMS })).rejects.toMatchObject({
        code: 'unauthorized'
      })
      expect(f.sqlite.prepare('SELECT count(*) n FROM checkout_quotes').get()).toMatchObject({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
  it('falls back to public price after company suspension', async () => {
    const f = await world()
    try {
      f.sqlite.exec("UPDATE companies SET status='suspended' WHERE id='company'")
      const result = await quoteCart(f.database, { ...f.input, ownerSession: CLAIMS })
      expect(result.outcome).toBe('quoted')
      if (result.outcome !== 'quoted') throw new Error(result.outcome)
      expect(result.quote.lines[0]?.unitGrossCents).toBe(500)
    } finally {
      f.sqlite.close()
    }
  })
  it('does not commit a stale contractual snapshot if the tariff changes before the quote batch', async () => {
    const f = await world()
    try {
      let fired = false
      const db = new Proxy(f.database, {
        get(target, key) {
          if (key === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              if (!fired) {
                fired = true
                f.sqlite.exec("UPDATE b2b_price_lists SET status='inactive',version=version+1 WHERE id='list'")
              }
              return target.batch(statements)
            }
          const value: unknown = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      await expect(quoteCart(db, { ...f.input, ownerSession: CLAIMS })).rejects.toThrow()
      expect(f.sqlite.prepare('SELECT count(*) n FROM checkout_quotes').get()).toMatchObject({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
  it('does not commit a private quote if the session is revoked before the quote batch', async () => {
    const f = await world()
    try {
      let fired = false
      const db = new Proxy(f.database, {
        get(target, key) {
          if (key === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              if (!fired) {
                fired = true
                f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(NOW, SESSION)
              }
              return target.batch(statements)
            }
          const value: unknown = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      await expect(quoteCart(db, { ...f.input, ownerSession: CLAIMS })).rejects.toThrow()
      expect(f.sqlite.prepare('SELECT count(*) n FROM checkout_quotes').get()).toMatchObject({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
  it('does not replay a private quote from the coordinator cache to a guest', async () => {
    const f = await world()
    try {
      const cache = new Map<string, { payloadHash: string; status: number; body: unknown }>()
      const deps = {
        database: f.database,
        getResponse: async (key: string) => cache.get(key),
        putResponse: async (key: string, value: { payloadHash: string; status: number; body: unknown }) => {
          cache.set(key, value)
        },
        setAlarm: async () => {}
      }
      const command = {
        type: 'quote',
        cartId: f.input.cartId,
        commandId: f.input.idempotencyKey,
        payload: { ...f.input, ownerSession: CLAIMS }
      }
      expect(await handleCartCommand(command, deps)).toMatchObject({
        status: 200,
        body: { quote: { totals: { grossCents: 666 } } }
      })
      expect(await handleCartCommand({ ...command, payload: f.input }, deps)).toMatchObject({ status: 409 })
    } finally {
      f.sqlite.close()
    }
  })
  it('quotes one-cent lines when the category discount would round to zero', async () => {
    const f = await world()
    try {
      f.sqlite.exec(
        "DELETE FROM b2b_variant_rules WHERE price_list_id='list'; UPDATE variants SET price_gross_cents=1 WHERE id='v-1-1'; INSERT INTO b2b_category_rules(price_list_id,category_id,discount_basis_points) VALUES('list','c1',9500)"
      )
      const result = await quoteCart(f.database, { ...f.input, ownerSession: CLAIMS })
      expect(result.outcome).toBe('quoted')
      if (result.outcome !== 'quoted') throw new Error(result.outcome)
      expect(result.quote.lines[0]).toMatchObject({ unitGrossCents: 1, quantity: 2, grossCents: 2 })
      expect(result.quote.lines[0]?.priceVersionId).toMatch(/^b2b:list:v\d+:a1:category:c1:/)
      expect(f.sqlite.prepare('SELECT count(*) n FROM checkout_quotes').get()).toMatchObject({ n: 1 })
    } finally {
      f.sqlite.close()
    }
  })
})
