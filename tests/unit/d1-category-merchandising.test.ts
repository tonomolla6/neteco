import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  MER_CHILD,
  MER_CLAIMS,
  MER_DRAFT_CATEGORY,
  MER_ROOT,
  merProduct,
  merUtc as at,
  merchandisingWorld
} from '../support/category-merchandising-fixture'
import { assignD1CompanyB2BPriceList, upsertD1B2BPriceList } from '../../workers/catalog/b2b-pricing'
import {
  CategoryMerchandisingError,
  executeCategoryMerchandisingCommand,
  listCategoryMerchandisingRules,
  listMerchandisableCategories,
  previewCategoryMerchandising,
  readCategoryMerchandisingHistory,
  readCategoryMerchandisingReceipt,
  readCategoryMerchandisingRule,
  readLiveCategoryOrder
} from '../../workers/catalog/category-merchandising'
import { testUuid } from '../support/deterministic'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const P = merProduct
const noWeights = { stock: 0, margin: 0, popularity: 0, contract: 0, campaign: 0 }
let world: Awaited<ReturnType<typeof merchandisingWorld>>
let sqlite: DatabaseSync
let database: D1Database

const rule = (extra: Record<string, unknown> = {}) => ({
  action: 'save',
  id: null,
  expectedVersion: 0,
  categoryId: MER_ROOT,
  weights: { ...noWeights, popularity: 5, margin: 5 },
  guardrails: { minStock: 0, minMarginBps: null, maxBoosted: 10 },
  campaign: { campaignId: null, productIds: [] },
  reason: 'Priorizar productos rentables y populares',
  validFrom: at(-HOUR),
  validUntil: at(30 * DAY),
  ...extra
})
const run = (input: unknown, key = testUuid(), options: Record<string, unknown> = {}) =>
  executeCategoryMerchandisingCommand(database, MER_CLAIMS, input, { idempotencyKey: key, ...options })
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: unknown) => (error instanceof CategoryMerchandisingError ? error.code : `unexpected:${String(error)}`)
  )
const count = () => (sqlite.prepare('SELECT count(*) n FROM category_merchandising_commands').get() as { n: number }).n

beforeEach(async () => {
  world = await merchandisingWorld()
  ;({ sqlite, database } = world)
  world.addProduct({ n: 1, stock: 50, cost: 600 }) // margin 4000 bps
  world.addProduct({ n: 2, stock: 0, cost: 200 }) // out of stock
  world.addProduct({ n: 3, stock: 5, cost: null }) // unknown margin
  world.addProduct({ n: 4, status: 'draft', stock: 99, cost: 100 })
  world.addProduct({ n: 5, category: MER_CHILD, stock: 30, cost: 900 }) // margin 1000 bps
})
afterEach(() => sqlite.close())

describe('SEA-015 rule lifecycle', () => {
  it('creates an audited rule; replay and GET recovery are exact and nothing is duplicated', async () => {
    const receipt = await run(rule(), 'create-one')
    expect(receipt).toMatchObject({ source: 'cloudflare', action: 'save' })
    expect(receipt.item).toMatchObject({
      categoryId: MER_ROOT,
      status: 'active',
      version: 1,
      reason: 'Priorizar productos rentables y populares'
    })
    expect(receipt.item.authorId).toBe(MER_CLAIMS.identityId)
    expect(await run(rule(), 'create-one')).toEqual(receipt)
    expect(await readCategoryMerchandisingReceipt(database, MER_CLAIMS, 'create-one')).toEqual(receipt)
    expect(await readCategoryMerchandisingReceipt(database, MER_CLAIMS, 'missing')).toBeNull()
    expect(count()).toBe(1)
  })
  it('updates with compare-and-set and keeps the full history', async () => {
    const first = await run(rule())
    const second = await run(
      rule({ id: first.item.id, expectedVersion: 1, weights: { ...noWeights, stock: 3 }, reason: 'Ajuste por stock' })
    )
    expect(second.item).toMatchObject({ version: 2, weights: { stock: 3 } })
    expect(await code(run(rule({ id: first.item.id, expectedVersion: 1 })))).toBe('version_conflict')
    const history = await readCategoryMerchandisingHistory(database, MER_CLAIMS, first.item.id)
    expect(history?.items.map((item) => item.version)).toEqual([1, 2])
    expect(await readCategoryMerchandisingHistory(database, MER_CLAIMS, testUuid())).toBeNull()
    expect((await readCategoryMerchandisingRule(database, MER_CLAIMS, first.item.id))?.version).toBe(2)
  })
  it('refuses to update an unknown rule and a different category through the same id', async () => {
    expect(await code(run(rule({ id: testUuid(), expectedVersion: 1 })))).toBe('version_conflict')
    const first = await run(rule())
    expect(await code(run(rule({ id: first.item.id, expectedVersion: 1, categoryId: MER_CHILD })))).toBe(
      'version_conflict'
    )
  })
  it('retires a rule and refuses any further change', async () => {
    const first = await run(rule())
    const retired = await run({ action: 'retire', id: first.item.id, expectedVersion: 1, reason: 'Fin de campaña' })
    expect(retired.item).toMatchObject({ status: 'retired', version: 2 })
    expect((await readCategoryMerchandisingRule(database, MER_CLAIMS, first.item.id))?.state).toBe('retired')
    expect(await code(run(rule({ id: first.item.id, expectedVersion: 2 })))).toBe('version_conflict')
    expect(await code(run({ action: 'retire', id: first.item.id, expectedVersion: 2, reason: 'Otra vez' }))).toBe(
      'version_conflict'
    )
  })
  it('rejects a reused key with another payload and honours target/action guards', async () => {
    await run(rule(), 'same-key')
    expect(await code(run(rule({ reason: 'Otro motivo distinto' }), 'same-key'))).toBe('idempotency_conflict')
    expect(await code(run(rule(), 'k2', { target: testUuid() }))).toBe('invalid_input')
    expect(await code(run(rule(), 'k3', { action: 'retire' }))).toBe('invalid_input')
    expect(await code(run(rule(), 'bad key with spaces'))).toBe('invalid_input')
  })
  it('validates the input and the referenced category and products', async () => {
    expect(await code(run({ action: 'save' }))).toBe('invalid_input')
    expect(await code(run(rule({ weights: noWeights })))).toBe('invalid_input')
    expect(await code(run(rule({ categoryId: testUuid() })))).toBe('category_unavailable')
    expect(await code(run(rule({ categoryId: MER_DRAFT_CATEGORY })))).toBe('category_unavailable')
    expect(
      await code(
        run(
          rule({
            weights: { ...noWeights, campaign: 5 },
            campaign: { campaignId: null, productIds: [testUuid()] }
          })
        )
      )
    ).toBe('product_unavailable')
    expect(await code(run(rule({ validFrom: at(-2 * DAY), validUntil: at(-DAY) })))).toBe('expiry_invalid')
    expect(count()).toBe(0)
  })
  it('accepts campaign products that exist and rejects a campaign that does not', async () => {
    expect(
      await code(
        run(rule({ weights: { ...noWeights, campaign: 5 }, campaign: { campaignId: null, productIds: [P(1), P(5)] } }))
      )
    ).toBe('ok')
    expect(
      await code(
        run(
          rule({
            categoryId: MER_CHILD,
            weights: { ...noWeights, campaign: 5 },
            campaign: { campaignId: testUuid(), productIds: [P(5)] }
          })
        )
      )
    ).toBe('campaign_unavailable')
  })
  it('allows one active rule per category and period', async () => {
    await run(rule())
    expect(await code(run(rule({ validFrom: at(DAY), validUntil: at(40 * DAY) })))).toBe('rule_conflict')
    expect(await code(run(rule({ categoryId: MER_CHILD })))).toBe('ok')
    expect(await code(run(rule({ validFrom: at(31 * DAY), validUntil: at(60 * DAY) })))).toBe('ok')
  })
  it('lets only one of two concurrent creations for the same category win', async () => {
    const results = await Promise.all([code(run(rule())), code(run(rule({ reason: 'Segunda regla en paralelo' })))])
    expect(results.filter((r) => r === 'ok')).toHaveLength(1)
    expect(results.filter((r) => r === 'rule_conflict')).toHaveLength(1)
    expect(count()).toBe(1)
  })
  it('collapses two concurrent identical commands into one revision', async () => {
    const [a, b] = await Promise.all([run(rule(), 'twin'), run(rule(), 'twin')])
    expect(a).toEqual(b)
    expect(count()).toBe(1)
  })
  it('is append-only at the database level', async () => {
    await run(rule())
    expect(() => sqlite.exec("UPDATE category_merchandising_commands SET status='retired'")).toThrow()
    expect(() => sqlite.exec('DELETE FROM category_merchandising_commands')).toThrow()
  })
  it('requires live catalog.write with MFA, before and at the moment of the write', async () => {
    const past = at(-DAY)
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'nobody@example.invalid','synthetic',?,'active',?,?)"
      )
      .run('10000000-0000-4000-8000-0000000c0009', past, past, past)
    sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)'
      )
      .run('20000000-0000-4000-8000-0000000c0009', '10000000-0000-4000-8000-0000000c0009', past, at(HOUR))
    const nobody = {
      identityId: '10000000-0000-4000-8000-0000000c0009',
      sessionId: '20000000-0000-4000-8000-0000000c0009',
      sessionVersion: 1
    }
    expect(await code(executeCategoryMerchandisingCommand(database, nobody, rule(), { idempotencyKey: 'x' }))).toBe(
      'forbidden'
    )
    expect(
      await code(
        executeCategoryMerchandisingCommand(database, { ...MER_CLAIMS, sessionVersion: 4 }, rule(), {
          idempotencyKey: 'x'
        })
      )
    ).toBe('unauthenticated')
    sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(MER_CLAIMS.sessionId)
    expect(await code(run(rule()))).toBe('mfa_required')
    sqlite.prepare('UPDATE auth_sessions SET mfa_verified=1 WHERE id=?').run(MER_CLAIMS.sessionId)
    const racing = new Proxy(database, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (property === 'prepare')
          return (sql: string) => {
            if (/^\s*INSERT INTO category_merchandising_commands/i.test(sql))
              sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(MER_CLAIMS.identityId)
            return (value as (s: string) => unknown).call(target, sql)
          }
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    expect(
      await code(executeCategoryMerchandisingCommand(racing, MER_CLAIMS, rule(), { idempotencyKey: 'race' }))
    ).toBe('forbidden')
    expect(count()).toBe(0)
  })
  it('lists with pagination and filters', async () => {
    const a = await run(rule())
    await run(rule({ categoryId: MER_CHILD }))
    await run({ action: 'retire', id: a.item.id, expectedVersion: 1, reason: 'Fin de campaña' })
    const open = await listCategoryMerchandisingRules(database, MER_CLAIMS, {})
    expect(open.total).toBe(1)
    expect(open.items[0]!.categoryId).toBe(MER_CHILD)
    expect((await listCategoryMerchandisingRules(database, MER_CLAIMS, { status: 'all' })).total).toBe(2)
    expect(
      (await listCategoryMerchandisingRules(database, MER_CLAIMS, { status: 'all', categoryId: MER_ROOT })).total
    ).toBe(1)
    expect(
      (await listCategoryMerchandisingRules(database, MER_CLAIMS, { status: 'all', perPage: 1, page: 2 })).items
    ).toHaveLength(1)
    expect(await code(listCategoryMerchandisingRules(database, MER_CLAIMS, { perPage: 101 }))).toBe('invalid_input')
    expect(await code(listCategoryMerchandisingRules(database, { ...MER_CLAIMS, sessionVersion: 3 }, {}))).toBe(
      'unauthenticated'
    )
  })
})

describe('SEA-015 merchandisable categories', () => {
  it('lists published categories only, for catalog.write with MFA', async () => {
    const categories = await listMerchandisableCategories(database, MER_CLAIMS)
    expect(categories.map((c) => c.slug)).toEqual(['lejias', 'limpieza'])
    expect(categories.find((c) => c.slug === 'lejias')).toMatchObject({
      id: MER_CHILD,
      parentId: MER_ROOT,
      name: 'Lejías'
    })
    expect(categories.some((c) => c.id === MER_DRAFT_CATEGORY)).toBe(false)
    expect(await code(listMerchandisableCategories(database, { ...MER_CLAIMS, sessionVersion: 7 }))).toBe(
      'unauthenticated'
    )
  })
})

describe('SEA-015 signals and preview', () => {
  const draft = (
    weights: Partial<typeof noWeights>,
    guardrails = {},
    campaign = { campaignId: null as string | null, productIds: [] as string[] }
  ) => ({
    categoryId: MER_ROOT,
    ruleId: null,
    companyId: null,
    draft: {
      weights: { ...noWeights, ...weights },
      guardrails: { minStock: 0, minMarginBps: null, maxBoosted: 10, ...guardrails },
      campaign
    }
  })
  const preview = (input: unknown) => previewCategoryMerchandising(database, MER_CLAIMS, input)
  const ids = (result: Awaited<ReturnType<typeof preview>>) => result.items.map((item) => item.productId)

  it('computes stock, backorder, margin and popularity from the real tables, in the category tree only', async () => {
    world.paidPurchase(1, at(-2 * DAY), 7)
    world.paidPurchase(5, at(-DAY), 2)
    const result = await preview(draft({ stock: 1 }))
    const byId = new Map(result.items.map((item) => [item.productId, item]))
    expect(byId.has(P(4))).toBe(false) // draft product
    expect(result.items).toHaveLength(4)
    expect(byId.get(P(1))).toMatchObject({ sellableStock: 50, marginBps: 4000, units30d: 7, name: 'Producto A' })
    expect(byId.get(P(2))).toMatchObject({ sellableStock: 0, group: 'demoted' })
    expect(byId.get(P(3))).toMatchObject({ marginBps: null })
    expect(byId.get(P(5))).toMatchObject({ marginBps: 1000, units30d: 2 })
  })
  it('ranks by a draft rule without saving anything', async () => {
    world.paidPurchase(5, at(-DAY), 9)
    world.paidPurchase(1, at(-DAY), 1)
    expect(ids(await preview(draft({ popularity: 5 })))).toEqual([P(5), P(1), P(3), P(2)])
    expect(ids(await preview(draft({ margin: 5 })))).toEqual([P(1), P(5), P(3), P(2)])
    expect(ids(await preview(draft({ stock: 5 })))).toEqual([P(1), P(5), P(3), P(2)])
    expect(count()).toBe(0)
  })
  it('applies guardrails: margin floor, minimum stock and the boost cap', async () => {
    const floor = await preview(draft({ margin: 5 }, { minMarginBps: 2000 }))
    expect(ids(floor)).toEqual([P(1), P(3), P(5), P(2)])
    expect(floor.items.find((i) => i.productId === P(3))!.guardrails).toEqual(['margin_unknown'])
    expect(floor.items.find((i) => i.productId === P(5))!.guardrails).toEqual(['margin_floor'])
    const minStock = await preview(draft({ stock: 5 }, { minStock: 40 }))
    expect(ids(minStock)).toEqual([P(1), P(3), P(5), P(2)])
    const cap = await preview(draft({ margin: 5 }, { maxBoosted: 1 }))
    expect(cap.items.filter((i) => i.group === 'boosted')).toHaveLength(1)
  })
  it('uses only paid sales inside the 30 day window', async () => {
    world.paidPurchase(1, at(-40 * DAY), 50)
    world.paidPurchase(1, at(-DAY), 50, false)
    world.paidPurchase(5, at(-DAY), 1)
    const result = await preview(draft({ popularity: 5 }))
    expect(result.items.find((i) => i.productId === P(1))!.units30d).toBe(0)
    expect(ids(result)[0]).toBe(P(5))
  })
  it('flags campaign products only while their campaign is active', async () => {
    const campaignId = testUuid()
    const campaign = { campaignId, productIds: [P(5)] }
    const input = draft({ campaign: 5 }, {}, campaign)
    sqlite
      .prepare(
        "INSERT INTO commercial_campaigns(id,code,name,description,status,channel_type,priority,start_at,end_at,version,created_at,updated_at,created_by) VALUES (?,?,?,?,?,'web',50,?,?,1,?,?,?)"
      )
      .run(
        campaignId,
        'otono-limpieza',
        'Otoño limpieza',
        'Campaña de otoño',
        'active',
        at(-DAY),
        at(10 * DAY),
        at(-DAY),
        at(-DAY),
        MER_CLAIMS.identityId
      )
    expect(ids(await preview(input))[0]).toBe(P(5))
    sqlite.prepare("UPDATE commercial_campaigns SET status='paused', updated_at=?").run(at())
    const paused = await preview(input)
    expect(paused.items.every((item) => item.score === 0)).toBe(true)
    expect(ids(paused)).toEqual([P(1), P(3), P(5), P(2)])
  })
  it('flags contract products for the chosen company only, from its assigned price list', async () => {
    const past = at(-DAY)
    sqlite.prepare('INSERT INTO customers(id,created_at,updated_at) VALUES(?,?,?)').run('mer-customer', past, past)
    sqlite
      .prepare(
        "INSERT INTO companies(id,customer_id,legal_name,status,created_at,updated_at) VALUES('mer-company','mer-customer','Hostelería SL','approved',?,?)"
      )
      .run(past, past)
    const options = () => ({ now: () => at(), idempotencyKey: testUuid() })
    await upsertD1B2BPriceList(
      database,
      MER_CLAIMS,
      {
        priceListId: 'mer-list',
        expectedVersion: 0,
        code: 'HOST',
        name: 'Hostelería',
        status: 'active',
        validFrom: at(-HOUR),
        validUntil: null,
        variantRules: [{ variantId: 'mv-3', unitGrossCents: 900 }],
        categoryRules: [],
        reason: 'Acuerdo comercial'
      },
      options()
    )
    await assignD1CompanyB2BPriceList(
      database,
      MER_CLAIMS,
      'mer-company',
      {
        priceListId: 'mer-list',
        expectedVersion: 0,
        validFrom: at(-HOUR),
        validUntil: null,
        reason: 'Acuerdo comercial'
      },
      options()
    )
    const withCompany = await preview({ ...draft({ contract: 5 }), companyId: 'mer-company' })
    expect(ids(withCompany)[0]).toBe(P(3))
    expect(withCompany.items.find((i) => i.productId === P(3))).toMatchObject({ contract: true, group: 'boosted' })
    const anonymous = await preview(draft({ contract: 5 }))
    expect(anonymous.items.every((i) => !i.contract)).toBe(true)
    expect(await code(preview({ ...draft({ contract: 5 }), companyId: 'unknown-company' }))).toBe('company_unavailable')
    sqlite.prepare("UPDATE companies SET status='suspended'").run()
    expect(await code(preview({ ...draft({ contract: 5 }), companyId: 'mer-company' }))).toBe('company_unavailable')
  })
  it('flags campaign products without a campaign id as always on', async () => {
    const result = await preview(draft({ campaign: 5 }, {}, { campaignId: null, productIds: [P(3)] }))
    expect(ids(result)[0]).toBe(P(3))
  })
  it('previews a stored rule by id and rejects ambiguous or empty requests', async () => {
    const saved = await run(rule({ weights: { ...noWeights, margin: 5 } }))
    const stored = await preview({ categoryId: MER_ROOT, ruleId: saved.item.id, companyId: null, draft: null })
    expect(ids(stored)[0]).toBe(P(1))
    expect(stored.rule).toMatchObject({ id: saved.item.id, version: 1 })
    expect(
      await code(
        preview({ categoryId: MER_ROOT, ruleId: saved.item.id, companyId: null, draft: draft({ stock: 1 }).draft })
      )
    ).toBe('invalid_input')
    expect(await code(preview({ categoryId: MER_ROOT, ruleId: null, companyId: null, draft: null }))).toBe(
      'invalid_input'
    )
    expect(await code(preview({ categoryId: MER_ROOT, ruleId: testUuid(), companyId: null, draft: null }))).toBe(
      'not_found'
    )
    expect(await code(preview({ ...draft({ stock: 1 }), categoryId: testUuid() }))).toBe('category_unavailable')
    expect(await code(preview({ ...draft({ stock: 1 }), extra: true }))).toBe('invalid_input')
  })
  it('requires catalog.write with MFA to preview', async () => {
    expect(
      await code(previewCategoryMerchandising(database, { ...MER_CLAIMS, sessionVersion: 9 }, draft({ stock: 1 })))
    ).toBe('unauthenticated')
  })
})

describe('SEA-015 live order for the storefront', () => {
  const live = (slug = 'limpieza', options: { instant?: string; customerId?: string | null } = {}) =>
    readLiveCategoryOrder(database, slug, { instant: options.instant ?? at(), customerId: options.customerId ?? null })

  it('returns null when no rule applies', async () => {
    expect(await live()).toBeNull()
    expect(await live('no-existe')).toBeNull()
  })
  it('returns the boosted ids in order and the sunk ids, only while the rule is live', async () => {
    world.paidPurchase(5, at(-DAY), 9)
    const saved = await run(rule({ weights: { ...noWeights, popularity: 5 } }))
    const order = await live()
    expect(order).toMatchObject({ ruleId: saved.item.id, version: 1, front: [P(5)], back: [P(2)] })
    expect(await live('limpieza', { instant: at(-2 * HOUR) })).toBeNull() // scheduled
    expect(await live('limpieza', { instant: at(31 * DAY) })).toBeNull() // expired
    await run({ action: 'retire', id: saved.item.id, expectedVersion: 1, reason: 'Fin de campaña' })
    expect(await live()).toBeNull()
  })
  it('returns null when nothing would move, so the default order is untouched', async () => {
    await run(
      rule({ weights: { ...noWeights, contract: 5 }, guardrails: { minStock: 0, minMarginBps: null, maxBoosted: 5 } })
    )
    const order = await live()
    expect(order).toMatchObject({ front: [], back: [P(2)] })
    sqlite.prepare('UPDATE inventory_balances SET physical_quantity=5 WHERE variant_id=?').run('mv-2')
    expect(await live()).toBeNull()
  })
  it('ignores unpublished categories', async () => {
    sqlite.prepare("UPDATE categories SET status='draft' WHERE id=?").run(MER_ROOT)
    expect(await live()).toBeNull()
  })
  it('degrades to null when the table does not exist yet (migration not applied)', async () => {
    sqlite.exec('DROP VIEW category_merchandising_current')
    expect(await live()).toBeNull()
  })
  it('uses a bounded number of statements', async () => {
    await run(rule({ weights: { ...noWeights, margin: 5 } }))
    let statements = 0
    const counting = new Proxy(database, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (property === 'prepare')
          return (sql: string) => {
            statements++
            return (value as (s: string) => unknown).call(target, sql)
          }
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await readLiveCategoryOrder(counting, 'limpieza', { instant: at(), customerId: null })
    expect(statements).toBeLessThanOrEqual(3)
  })
})
