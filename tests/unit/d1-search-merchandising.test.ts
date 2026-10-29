import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  categoryCommandFixture,
  CATEGORY_CLAIMS,
  CATEGORY_IDENTITY,
  CATEGORY_SESSION,
  ROOT_CATEGORY
} from '../support/category-command-fixture'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { searchPublishedProducts } from '../../workers/catalog/search'
import {
  executeSearchMerchandisingCommand,
  isAllowedSearchRedirectPath,
  listSearchMerchandisingRules,
  readSearchMerchandisingHistory,
  readSearchMerchandisingReceipt,
  readSearchMerchandisingRule,
  searchMerchandisingInputSchema
} from '../../workers/catalog/search-merchandising'

const P = {
  A: '10000000-0000-4000-8000-000000000a01',
  B: '10000000-0000-4000-8000-000000000a02',
  C: '10000000-0000-4000-8000-000000000a03',
  D: '10000000-0000-4000-8000-000000000a04',
  E: '10000000-0000-4000-8000-000000000a05'
}
const at = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
const HOUR = 3_600_000,
  DAY = 24 * HOUR

describe('governed D1 search merchandising rules (SEA-013)', () => {
  let sqlite: DatabaseSync, database: D1Database
  beforeEach(async () => {
    ;({ sqlite, database } = await categoryCommandFixture())
    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='search_merchandising_commands'").get())
      sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0091_search_merchandising_rules.sql', import.meta.url), 'utf8')
      )
    sqlite.exec(`INSERT INTO brands(id,name,slug,status) VALUES ('mer-brand','NETECO','mer-brand','published');
      INSERT INTO tax_classes(id,code,name,rate_basis_points,valid_from) VALUES ('mer-tax','MER21','IVA',2100,'2020-01-01T00:00:00Z');
      INSERT INTO shipping_profiles(id,code,name,kind) VALUES ('mer-shipping','MER','Paquete','parcel');
      INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES ('mer-loc','MER-LOC','Almacén','warehouse',1,'2026-08-12T00:00:00Z');`)
    const names: Record<string, [string, string]> = {
      A: ['Lejía neutra A', 'published'],
      B: ['Lejía neutra B', 'published'],
      C: ['Lejía neutra C', 'published'],
      D: ['Lejía neutra D', 'draft'],
      E: ['Lejía neutra E', 'published']
    }
    let legacy = 200
    for (const [key, [name, status]] of Object.entries(names)) {
      const id = P[key as keyof typeof P],
        stock = key === 'C' ? 0 : 10
      legacy++
      sqlite
        .prepare(
          `INSERT INTO products(id,legacy_id,name,slug,category_id,brand_id,status) VALUES (?,?,?,?,?,'mer-brand',?)`
        )
        .run(id, legacy, name, `lejia-${key.toLowerCase()}`, ROOT_CATEGORY, status)
      sqlite
        .prepare(
          `INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents)
           VALUES (?,?,?,'mer-tax','mer-shipping',?,'1 L','published',1210)`
        )
        .run(`v-${key}`, legacy, id, `MER-${key}`)
      sqlite
        .prepare(
          `INSERT INTO inventory_balances(variant_id,location_id,physical_quantity,blocked_quantity,version,created_at,updated_at)
           VALUES (?,'mer-loc',?,0,1,'2026-08-12T00:00:00Z','2026-08-12T00:00:00Z')`
        )
        .run(`v-${key}`, stock)
    }
    await provisionPublicationValidityFixture(database, {
      productIds: [P.A, P.B, P.C, P.D, P.E],
      now: '2026-08-19T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
  })
  afterEach(() => sqlite.close())

  const rule = (extra: Record<string, unknown> = {}) => ({
    action: 'save',
    id: null,
    expectedVersion: 0,
    term: 'Lejía neutra',
    kind: 'boost',
    productId: P.E,
    weight: 5,
    redirectPath: null,
    reason: 'Campaña comercial revisada',
    validFrom: at(-HOUR),
    validUntil: at(7 * DAY),
    ...extra
  })
  const redirect = (extra: Record<string, unknown> = {}) =>
    rule({
      kind: 'redirect',
      term: 'oferta limpieza',
      productId: null,
      weight: null,
      redirectPath: '/catalogo?categoria=limpieza',
      ...extra
    })
  const run = (input: unknown, key = crypto.randomUUID(), options: Record<string, unknown> = {}) =>
    executeSearchMerchandisingCommand(database, CATEGORY_CLAIMS, input, { idempotencyKey: key, ...options })
  const count = () => (sqlite.prepare('SELECT count(*) n FROM search_merchandising_commands').get() as { n: number }).n
  const slugs = async (query = 'lejía neutra', instant?: string) =>
    (await searchPublishedProducts(database, query, instant ? { instant } : undefined)).items.map((item) => item.slug)
  const BASELINE = ['lejia-a', 'lejia-b', 'lejia-c', 'lejia-e']

  describe('lifecycle, audit and idempotency', () => {
    it('creates an audited rule with reason, author and bounded validity; replay and GET recovery are exact', async () => {
      const receipt = await run(rule(), 'create-one')
      expect(receipt.action).toBe('save')
      expect(receipt.item).toMatchObject({
        term: 'Lejía neutra',
        termNormalized: 'lejia neutra',
        kind: 'boost',
        productId: P.E,
        weight: 5,
        redirectPath: null,
        reason: 'Campaña comercial revisada',
        authorId: CATEGORY_IDENTITY,
        status: 'active',
        version: 1
      })
      expect(receipt.item.validUntil > receipt.item.validFrom).toBe(true)
      expect(await run(rule(), 'create-one')).toEqual(receipt)
      expect(await readSearchMerchandisingReceipt(database, CATEGORY_CLAIMS, 'create-one')).toEqual(receipt)
      expect(await readSearchMerchandisingReceipt(database, CATEGORY_CLAIMS, 'missing')).toBeNull()
      expect(count()).toBe(1)
      expect(() => sqlite.exec("UPDATE search_merchandising_commands SET status='retired'")).toThrow()
      expect(() => sqlite.exec('DELETE FROM search_merchandising_commands')).toThrow()
    })

    it('rejects the same idempotency key with a different payload and a replay through another target/action', async () => {
      const first = await run(rule(), 'same-key')
      await expect(run(rule({ weight: 6 }), 'same-key')).rejects.toMatchObject({ code: 'idempotency_conflict' })
      await expect(run(rule(), 'same-key', { target: first.item.id })).rejects.toMatchObject({
        code: 'invalid_input'
      })
      await expect(run(rule(), 'same-key', { action: 'retire' })).rejects.toMatchObject({ code: 'invalid_input' })
      expect(count()).toBe(1)
    })

    it('edits with CAS, keeps every version and retires without losing content', async () => {
      const first = await run(rule())
      const edited = await run(rule({ id: first.item.id, expectedVersion: 1, weight: 9, reason: 'Peso revisado' }))
      expect(edited.item).toMatchObject({ version: 2, weight: 9, reason: 'Peso revisado', status: 'active' })
      await expect(run(rule({ id: first.item.id, expectedVersion: 1, weight: 2 }))).rejects.toMatchObject({
        code: 'version_conflict'
      })
      const retired = await run({
        action: 'retire',
        id: first.item.id,
        expectedVersion: 2,
        reason: 'Campaña terminada antes de tiempo'
      })
      expect(retired.action).toBe('retire')
      expect(retired.item).toMatchObject({
        version: 3,
        status: 'retired',
        weight: 9,
        productId: P.E,
        reason: 'Campaña terminada antes de tiempo'
      })
      await expect(
        run({ action: 'retire', id: first.item.id, expectedVersion: 3, reason: 'Otra vez retirada' })
      ).rejects.toMatchObject({ code: 'version_conflict' })
      await expect(run(rule({ id: first.item.id, expectedVersion: 3 }))).rejects.toMatchObject({
        code: 'version_conflict'
      })
      const history = await readSearchMerchandisingHistory(database, CATEGORY_CLAIMS, first.item.id)
      expect(history!.items.map((item) => [item.version, item.status, item.weight])).toEqual([
        [1, 'active', 5],
        [2, 'active', 9],
        [3, 'retired', 9]
      ])
      expect(count()).toBe(3)
    })

    it('lets exactly one of two simultaneous edits from the same version win', async () => {
      const first = await run(rule())
      const results = await Promise.allSettled([
        run(rule({ id: first.item.id, expectedVersion: 1, weight: 3 })),
        run(rule({ id: first.item.id, expectedVersion: 1, weight: 4 }))
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      const failed = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
      expect(failed.reason).toMatchObject({ code: 'version_conflict' })
      expect(count()).toBe(2)
    })

    it('serializes simultaneous exact retries and recovers a committed write whose response was lost', async () => {
      const [a, b] = await Promise.all([run(rule(), 'parallel'), run(rule(), 'parallel')])
      expect(a).toEqual(b)
      expect(count()).toBe(1)
      const lost = new Proxy(database, {
        get(target, key, receiver) {
          if (key === 'prepare')
            return (sql: string) => {
              const statement = database.prepare(sql)
              if (!sql.startsWith('INSERT INTO search_merchandising_commands')) return statement
              return {
                ...statement,
                bind(...args: unknown[]) {
                  statement.bind(...args)
                  return this
                },
                async run() {
                  await statement.run()
                  throw new Error('synthetic lost response')
                }
              }
            }
          return Reflect.get(target, key, receiver)
        }
      })
      const receipt = await executeSearchMerchandisingCommand(lost, CATEGORY_CLAIMS, rule({ term: 'otro termino' }), {
        idempotencyKey: 'lost-response'
      })
      expect(await readSearchMerchandisingReceipt(database, CATEGORY_CLAIMS, 'lost-response')).toEqual(receipt)
      expect(count()).toBe(2)
    })

    it('rolls back completely when a late SQLite write fails', async () => {
      sqlite.exec(
        "CREATE TRIGGER synthetic_failure AFTER INSERT ON search_merchandising_commands BEGIN SELECT RAISE(ABORT,'synthetic failure'); END"
      )
      await expect(run(rule())).rejects.toThrow('synthetic failure')
      expect(count()).toBe(0)
      expect((await listSearchMerchandisingRules(database, CATEGORY_CLAIMS)).total).toBe(0)
    })

    it('keeps receipts private to the actor that issued the command', async () => {
      await run(rule(), 'private-key')
      const other = {
        identityId: '10000000-0000-4000-8000-000000000041',
        sessionId: '20000000-0000-4000-8000-000000000041',
        sessionVersion: 1
      }
      sqlite
        .prepare(
          `INSERT INTO identities(id,email,password_hash,email_verified_at,status,session_version,created_at,updated_at) SELECT ?, 'other-merch@example.invalid',password_hash,email_verified_at,status,session_version,created_at,updated_at FROM identities WHERE id=?`
        )
        .run(other.identityId, CATEGORY_IDENTITY)
      sqlite
        .prepare(
          `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) SELECT ?,?,session_version,mfa_verified,created_at,expires_at FROM auth_sessions WHERE id=?`
        )
        .run(other.sessionId, other.identityId, CATEGORY_SESSION)
      sqlite
        .prepare(
          `INSERT INTO identity_roles(identity_id,role_code,granted_at) SELECT ?,role_code,granted_at FROM identity_roles WHERE identity_id=?`
        )
        .run(other.identityId, CATEGORY_IDENTITY)
      expect(await readSearchMerchandisingReceipt(database, other, 'private-key')).toBeNull()
    })
  })

  describe('authorization', () => {
    it.each(['revoke', 'email', 'mfa', 'grant'])(
      'fails closed on current %s authority including historical GET/replay/list/history',
      async (cause) => {
        const first = await run(rule(), 'receipt')
        if (cause === 'revoke')
          sqlite.prepare('UPDATE auth_sessions SET revoked_at=created_at WHERE id=?').run(CATEGORY_SESSION)
        if (cause === 'mfa') sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CATEGORY_SESSION)
        if (cause === 'email')
          sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(CATEGORY_IDENTITY)
        if (cause === 'grant') sqlite.exec("DELETE FROM role_permissions WHERE permission_code='catalog.write'")
        await expect(readSearchMerchandisingReceipt(database, CATEGORY_CLAIMS, 'receipt')).rejects.toBeInstanceOf(Error)
        await expect(run(rule(), 'receipt')).rejects.toBeInstanceOf(Error)
        await expect(run(rule({ term: 'nuevo termino' }))).rejects.toBeInstanceOf(Error)
        await expect(listSearchMerchandisingRules(database, CATEGORY_CLAIMS)).rejects.toBeInstanceOf(Error)
        await expect(readSearchMerchandisingRule(database, CATEGORY_CLAIMS, first.item.id)).rejects.toBeInstanceOf(
          Error
        )
        await expect(readSearchMerchandisingHistory(database, CATEGORY_CLAIMS, first.item.id)).rejects.toBeInstanceOf(
          Error
        )
      }
    )

    it('rejects revocation in the last D1 write and leaves zero command rows', async () => {
      const raced = new Proxy(database, {
        get(target, key, receiver) {
          if (key === 'prepare')
            return (sql: string) => {
              if (sql.startsWith('INSERT INTO search_merchandising_commands'))
                sqlite.prepare('UPDATE auth_sessions SET revoked_at=created_at WHERE id=?').run(CATEGORY_SESSION)
              return database.prepare(sql)
            }
          return Reflect.get(target, key, receiver)
        }
      })
      await expect(
        executeSearchMerchandisingCommand(raced, CATEGORY_CLAIMS, rule(), { idempotencyKey: 'revoked-during-commit' })
      ).rejects.toBeInstanceOf(Error)
      expect(count()).toBe(0)
    })
  })

  describe('input validation and safety limits', () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ['short reason', { reason: 'x' }],
      ['control character in reason', { reason: 'motivo\u0000oculto' }],
      ['missing validUntil', { validUntil: undefined }],
      ['null validUntil', { validUntil: null }],
      ['missing validFrom', { validFrom: undefined }],
      ['non-canonical instant', { validUntil: '2030-01-01' }],
      ['validUntil before validFrom', { validFrom: at(2 * DAY), validUntil: at(DAY) }],
      ['validUntil equals validFrom', { validFrom: at(DAY), validUntil: at(DAY) }],
      ['validity longer than 180 days', { validFrom: at(0), validUntil: at(181 * DAY) }],
      ['weight zero', { weight: 0 }],
      ['weight above the bound', { weight: 11 }],
      ['fractional weight', { weight: 1.5 }],
      ['missing weight', { weight: null }],
      ['boost without product', { productId: null }],
      ['boost with non-uuid product', { productId: 'not-a-uuid' }],
      ['boost carrying a redirect path', { redirectPath: '/catalogo' }],
      ['bury without product', { kind: 'bury', productId: null }],
      ['unknown kind', { kind: 'pin' }],
      ['term too short', { term: 'a' }],
      ['term without letters or numbers', { term: '%_*' }],
      ['term with control characters', { term: 'test\u0000x' }],
      ['create with an id', { id: P.A }],
      ['update without id', { expectedVersion: 1 }],
      ['unexpected property', { unexpected: true }]
    ]
    it.each(bad)('rejects %s before any write', async (_name, change) => {
      const input = { ...rule(), ...change }
      expect(searchMerchandisingInputSchema.safeParse(input).success).toBe(false)
      await expect(run(input)).rejects.toMatchObject({ code: 'invalid_input' })
      expect(count()).toBe(0)
    })

    const badRedirects: Array<[string, unknown]> = [
      ['absolute https URL', 'https://evil.example/catalogo'],
      ['protocol-relative URL', '//evil.example/catalogo'],
      ['backslash trick', '/\\evil.example'],
      ['javascript scheme', 'javascript:alert(1)'],
      ['relative without slash', 'catalogo'],
      ['other internal area', '/admin'],
      ['api route', '/api/admin/search-merchandising'],
      ['prefix lookalike', '/catalogofalso'],
      ['dot segments', '/catalogo/../admin'],
      ['empty segment', '/catalogo//x'],
      ['percent-encoded traversal', '/catalogo/%2e%2e/admin'],
      ['query smuggling an absolute target', '/catalogo?next=https://evil.example'],
      ['fragment', '/catalogo#x'],
      ['whitespace', '/catalogo x'],
      ['non-ascii', '/catalogo/ñ'],
      ['product with extra path', '/producto/lejia-a/mas'],
      ['product with query', '/producto/lejia-a?x=1'],
      ['product without slug', '/producto/'],
      ['too long', '/catalogo/' + 'a'.repeat(400)],
      ['empty', '']
    ]
    it.each(badRedirects)('refuses a redirect to %s', async (_name, path) => {
      expect(isAllowedSearchRedirectPath(String(path))).toBe(false)
      await expect(run(redirect({ redirectPath: path }))).rejects.toMatchObject({ code: 'invalid_input' })
      expect(count()).toBe(0)
    })
    it.each([
      '/catalogo',
      '/catalogo/limpieza',
      '/catalogo?categoria=limpieza&orden=precio',
      '/producto/lejia-a',
      '/contenido/guia-lejia',
      '/recursos',
      '/recursos/fichas'
    ])('accepts the internal store path %s', async (path) => {
      expect(isAllowedSearchRedirectPath(path)).toBe(true)
      const receipt = await run(redirect({ redirectPath: path }))
      expect(receipt.item.redirectPath).toBe(path)
    })
    it('requires a redirect to carry a path and no product or weight', async () => {
      await expect(run(redirect({ redirectPath: null }))).rejects.toMatchObject({ code: 'invalid_input' })
      await expect(run(redirect({ productId: P.A }))).rejects.toMatchObject({ code: 'invalid_input' })
      await expect(run(redirect({ weight: 3 }))).rejects.toMatchObject({ code: 'invalid_input' })
      expect(count()).toBe(0)
    })
    it('accepts exactly 180 days and no more, and refuses a rule that is already expired or backdated', async () => {
      const from = at(0)
      const exact = at(180 * DAY)
      expect((await run(rule({ validFrom: from, validUntil: exact }))).item.validUntil).toBe(exact)
      await expect(
        run(rule({ term: 'caducada', validFrom: at(-2 * DAY), validUntil: at(-HOUR) }))
      ).rejects.toMatchObject({ code: 'expiry_invalid' })
      const backdated = await run(rule({ term: 'retroactiva', validFrom: at(-170 * DAY), validUntil: at(10 * DAY) }))
      expect(backdated.item.version).toBe(1)
    })
    it('rejects an expiry beyond 180 days from the moment of writing even with a late validFrom', async () => {
      await expect(
        run(rule({ term: 'futuro lejano', validFrom: at(100 * DAY), validUntil: at(200 * DAY) }))
      ).rejects.toMatchObject({ code: 'expiry_invalid' })
      expect(count()).toBe(0)
    })
  })

  describe('products and targets must be real and public', () => {
    it('refuses to boost or bury an unpublished or unknown product', async () => {
      await expect(run(rule({ productId: P.D }))).rejects.toMatchObject({ code: 'product_unavailable' })
      await expect(run(rule({ kind: 'bury', productId: P.D }))).rejects.toMatchObject({ code: 'product_unavailable' })
      await expect(run(rule({ productId: '10000000-0000-4000-8000-000000000fff' }))).rejects.toMatchObject({
        code: 'product_unavailable'
      })
      expect(count()).toBe(0)
    })
    it('refuses a redirect to an unpublished or unknown product page but accepts a published one', async () => {
      await expect(run(redirect({ redirectPath: '/producto/lejia-d' }))).rejects.toMatchObject({
        code: 'redirect_target_unavailable'
      })
      await expect(run(redirect({ redirectPath: '/producto/no-existe' }))).rejects.toMatchObject({
        code: 'redirect_target_unavailable'
      })
      expect((await run(redirect({ redirectPath: '/producto/lejia-c' }))).item.redirectPath).toBe('/producto/lejia-c')
    })
    it('allows only one live rule per normalized term and product, and one live redirect per term', async () => {
      await run(rule())
      await expect(run(rule({ term: '  LEJIA   NEUTRA ', kind: 'bury', weight: 2 }))).rejects.toMatchObject({
        code: 'rule_conflict'
      })
      expect((await run(rule({ productId: P.A, kind: 'bury' }))).item.productId).toBe(P.A)
      await run(redirect())
      await expect(run(redirect({ redirectPath: '/catalogo' }))).rejects.toMatchObject({ code: 'rule_conflict' })
      expect(count()).toBe(3)
    })
    it('frees the slot once the earlier rule expired or was retired', async () => {
      await run(rule({ validFrom: at(-10 * HOUR), validUntil: at(-HOUR) }), 'old', { now: at(-9 * HOUR) })
      const replacement = await run(rule({ weight: 2 }))
      expect(replacement.item.version).toBe(1)
      const retired = await run({
        action: 'retire',
        id: replacement.item.id,
        expectedVersion: 1,
        reason: 'Retirada manual'
      })
      expect(retired.item.status).toBe('retired')
      expect((await run(rule({ weight: 3 }))).item.weight).toBe(3)
    })
    it('bounds the number of live rules per term', async () => {
      const ids = Array.from(
        { length: 21 },
        (_, index) => `10000000-0000-4000-8000-0000000b${String(index).padStart(4, '0')}`
      )
      ids.forEach((id, index) => {
        const legacy = 400 + index
        sqlite
          .prepare(
            `INSERT INTO products(id,legacy_id,name,slug,category_id,brand_id,status) VALUES (?,?,?,?,?,'mer-brand','published')`
          )
          .run(id, legacy, `Bulk ${index}`, `bulk-${index}`, ROOT_CATEGORY)
      })
      for (const id of ids.slice(0, 20)) await run(rule({ productId: id }))
      await expect(run(rule({ productId: ids[20] }))).rejects.toMatchObject({ code: 'rule_limit' })
    })
  })

  describe('listing and reading', () => {
    it('lists non-retired rules with computed live/scheduled/expired state, filters and paginates', async () => {
      const live = await run(rule({ term: 'alfa lejia' }))
      await run(rule({ term: 'beta lejia', validFrom: at(2 * DAY), validUntil: at(9 * DAY) }))
      await run(rule({ term: 'gamma lejia', validFrom: at(-10 * HOUR), validUntil: at(-HOUR) }), 'past', {
        now: at(-9 * HOUR)
      })
      const gone = await run(rule({ term: 'delta lejia' }))
      await run({ action: 'retire', id: gone.item.id, expectedVersion: 1, reason: 'Retirada para prueba' })
      const all = await listSearchMerchandisingRules(database, CATEGORY_CLAIMS)
      expect(all).toMatchObject({ source: 'cloudflare', total: 3, page: 1, perPage: 25 })
      expect(all.items.map((item) => [item.termNormalized, item.state])).toEqual([
        ['alfa lejia', 'live'],
        ['beta lejia', 'scheduled'],
        ['gamma lejia', 'expired']
      ])
      expect((await listSearchMerchandisingRules(database, CATEGORY_CLAIMS, { q: 'BETA' })).items).toHaveLength(1)
      expect(
        (await listSearchMerchandisingRules(database, CATEGORY_CLAIMS, { perPage: 1, page: 2 })).items[0]!
          .termNormalized
      ).toBe('beta lejia')
      const retired = await listSearchMerchandisingRules(database, CATEGORY_CLAIMS, { status: 'retired' })
      expect(retired.items.map((item) => [item.id, item.state])).toEqual([[gone.item.id, 'retired']])
      expect((await listSearchMerchandisingRules(database, CATEGORY_CLAIMS, { status: 'all' })).total).toBe(4)
      expect(await readSearchMerchandisingRule(database, CATEGORY_CLAIMS, live.item.id)).toMatchObject({
        state: 'live'
      })
      expect(await readSearchMerchandisingRule(database, CATEGORY_CLAIMS, P.A)).toBeNull()
      expect(await readSearchMerchandisingHistory(database, CATEGORY_CLAIMS, P.A)).toBeNull()
    })
    it.each([
      { page: 0 },
      { page: 1_000_001 },
      { perPage: 0 },
      { perPage: 101 },
      { q: 'x'.repeat(161) },
      { q: 'a\u0000' },
      { status: 'bogus' }
    ])('rejects invalid list query %j', async (query) => {
      await expect(listSearchMerchandisingRules(database, CATEGORY_CLAIMS, query as never)).rejects.toMatchObject({
        code: 'invalid_input'
      })
    })
  })

  describe('database defenses independent of the worker', () => {
    const base = () => {
      const id = crypto.randomUUID(),
        ruleId = crypto.randomUUID(),
        created = at(),
        item = {
          id: ruleId,
          term: 'Lejía neutra',
          termNormalized: 'lejia neutra',
          kind: 'boost',
          productId: P.A,
          weight: 3,
          redirectPath: null,
          reason: 'Inserción directa de prueba',
          validFrom: at(-HOUR),
          validUntil: at(DAY),
          status: 'active',
          authorId: CATEGORY_IDENTITY,
          version: 1,
          updatedAt: created
        }
      return { id, item, created }
    }
    const insert = (change: Record<string, unknown> = {}, itemChange: Record<string, unknown> = {}) => {
      const { id, item: baseItem, created } = base()
      const item = { ...baseItem, ...itemChange }
      const row: Record<string, unknown> = {
        id,
        actor_id: CATEGORY_IDENTITY,
        session_id: CATEGORY_SESSION,
        session_version: 1,
        idempotency_key: id,
        payload_hash: 'a'.repeat(64),
        rule_id: item.id,
        expected_version: 0,
        version: 1,
        term_normalized: 'lejia neutra',
        kind: item.kind,
        product_id: item.productId,
        weight: item.weight,
        redirect_path: item.redirectPath,
        reason: item.reason,
        valid_from: item.validFrom,
        valid_until: item.validUntil,
        status: item.status,
        snapshot: JSON.stringify(item),
        response: JSON.stringify({ source: 'cloudflare', commandId: id, action: 'save', item }),
        created_at: created,
        ...change
      }
      const keys = Object.keys(row)
      sqlite
        .prepare(
          `INSERT INTO search_merchandising_commands(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
        )
        .run(...(keys.map((key) => row[key]) as never[]))
    }
    it('control: a well-formed direct insert passes every trigger and CHECK', () => {
      expect(() => insert()).not.toThrow()
    })
    it.each([
      ['weight above the bound', { weight: 99 }, { weight: 99 }],
      ['weight zero', { weight: 0 }, { weight: 0 }],
      ['no expiry', { valid_until: null }, {}],
      ['inverted validity', { valid_from: at(DAY), valid_until: at(HOUR) }, {}],
      ['validity longer than 180 days', { valid_from: at(0), valid_until: at(200 * DAY) }, {}],
      ['reason too short', { reason: 'x' }, {}],
      ['unknown kind', { kind: 'pin' }, {}],
      [
        'external redirect',
        { kind: 'redirect', product_id: null, weight: null, redirect_path: 'https://evil.example' },
        {}
      ],
      [
        'protocol-relative redirect',
        { kind: 'redirect', product_id: null, weight: null, redirect_path: '//evil.example' },
        {}
      ],
      ['boost carrying a path', { redirect_path: '/catalogo' }, {}],
      ['redirect carrying a product', { kind: 'redirect', redirect_path: '/catalogo' }, {}],
      ['forged author in snapshot', {}, { authorId: '10000000-0000-4000-8000-000000000099' }],
      ['snapshot version mismatch', {}, { version: 7 }],
      ['actor that is not the session owner', { actor_id: '10000000-0000-4000-8000-000000000099' }, {}],
      ['version skipping CAS', { expected_version: 3, version: 4 }, { version: 4 }]
    ])('refuses a direct insert with %s', (_name, change, itemChange) => {
      expect(() => insert(change, itemChange)).toThrow()
      expect(count()).toBe(0)
    })
    it('refuses a retired version whose content differs from the previous version', async () => {
      const first = await run(rule())
      const forged = {
        ...first.item,
        version: 2,
        status: 'retired',
        weight: 9,
        reason: 'Retirada con contenido cambiado'
      }
      const id = crypto.randomUUID()
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO search_merchandising_commands(id,actor_id,session_id,session_version,idempotency_key,payload_hash,rule_id,expected_version,version,term_normalized,kind,product_id,weight,redirect_path,reason,valid_from,valid_until,status,snapshot,response,created_at)
             VALUES (?,?,?,1,?,?,?,1,2,'lejia neutra','boost',?,9,NULL,?,?,?,'retired',?,?,?)`
          )
          .run(
            id,
            CATEGORY_IDENTITY,
            CATEGORY_SESSION,
            id,
            'b'.repeat(64),
            first.item.id,
            forged.reason,
            first.item.validFrom,
            first.item.validUntil,
            JSON.stringify({ ...forged, updatedAt: at() }),
            JSON.stringify({
              source: 'cloudflare',
              commandId: id,
              action: 'retire',
              item: { ...forged, updatedAt: at() }
            }),
            at()
          )
      ).toThrow()
    })
  })

  describe('public search ordering', () => {
    it('keeps the baseline order and no redirect when there is no rule', async () => {
      expect(await slugs()).toEqual(BASELINE)
      expect(await searchPublishedProducts(database, 'lejía neutra')).not.toHaveProperty('redirect')
    })
    it('boosts an available product ahead of equivalent ones for the normalized term only', async () => {
      await run(rule({ term: 'Lejía neutra', productId: P.E, weight: 5 }))
      expect(await slugs('  LEJIA   neutra ')).toEqual(['lejia-e', 'lejia-a', 'lejia-b', 'lejia-c'])
      expect(await slugs('lejía neutra a')).toEqual(['lejia-a'])
    })
    it('orders several boosts by weight', async () => {
      await run(rule({ productId: P.E, weight: 3 }))
      await run(rule({ productId: P.B, weight: 8 }))
      expect(await slugs()).toEqual(['lejia-b', 'lejia-e', 'lejia-a', 'lejia-c'])
    })
    it('never lets an out-of-stock boosted product overtake available equivalents, and keeps it visible', async () => {
      await run(rule({ productId: P.C, weight: 10 }))
      expect(await slugs()).toEqual(BASELINE)
      sqlite.exec("UPDATE inventory_balances SET physical_quantity=5 WHERE variant_id='v-C'")
      expect(await slugs()).toEqual(['lejia-c', 'lejia-a', 'lejia-b', 'lejia-e'])
      sqlite.exec("UPDATE inventory_balances SET physical_quantity=0 WHERE variant_id='v-C'")
      expect(await slugs()).toEqual(BASELINE)
    })
    it('treats reserved or blocked stock as unavailable for a boost', async () => {
      await run(rule({ productId: P.E, weight: 10 }))
      expect((await slugs())[0]).toBe('lejia-e')
      sqlite.exec("UPDATE inventory_balances SET blocked_quantity=10 WHERE variant_id='v-E'")
      expect(await slugs()).toEqual(BASELINE)
      sqlite.exec("UPDATE inventory_balances SET blocked_quantity=0 WHERE variant_id='v-E'")
      sqlite.exec("UPDATE variants SET safety_stock=10 WHERE id='v-E'")
      expect(await slugs()).toEqual(BASELINE)
    })
    it('does not boost a backorder-only product as if it were in stock', async () => {
      await run(rule({ productId: P.C, weight: 10 }))
      sqlite.exec("UPDATE variants SET backorder_allowed=1 WHERE id='v-C'")
      expect(await slugs()).toEqual(BASELINE)
    })
    it('never surfaces an unpublished product even if a rule predates its unpublication', async () => {
      await run(rule({ productId: P.E, weight: 10 }))
      sqlite.exec("UPDATE products SET status='draft' WHERE id='" + P.E + "'")
      expect(await slugs()).toEqual(['lejia-a', 'lejia-b', 'lejia-c'])
    })
    it('buries a product by reordering only: the result set is identical to the baseline', async () => {
      await run(rule({ kind: 'bury', productId: P.A, weight: 7 }))
      const buried = await slugs()
      expect(buried).toEqual(['lejia-b', 'lejia-c', 'lejia-e', 'lejia-a'])
      expect([...buried].sort()).toEqual([...BASELINE].sort())
    })
    it('lets a buried product stay inside the top results even with more matches than the limit', async () => {
      for (let index = 0; index < 8; index++) {
        const id = `10000000-0000-4000-8000-0000000c${String(index).padStart(4, '0')}`
        sqlite
          .prepare(
            `INSERT INTO products(id,legacy_id,name,slug,category_id,brand_id,status) VALUES (?,?,?,?,?,'mer-brand','published')`
          )
          .run(id, 500 + index, `Lejía neutra Z${index}`, `lejia-z${index}`, ROOT_CATEGORY)
        sqlite
          .prepare(
            `INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents)
             VALUES (?,?,?,'mer-tax','mer-shipping',?,'1 L','published',1210)`
          )
          .run(`vz-${index}`, 500 + index, id, `MER-Z${index}`)
      }
      await provisionPublicationValidityFixture(database, {
        productIds: Array.from(
          { length: 8 },
          (_, index) => `10000000-0000-4000-8000-0000000c${String(index).padStart(4, '0')}`
        ),
        now: '2026-08-19T00:00:00Z',
        validUntil: '2099-01-01T00:00:00Z'
      })
      const before = await slugs()
      expect(before).toHaveLength(8)
      await run(rule({ kind: 'bury', productId: P.A, weight: 10 }))
      const after = await slugs()
      expect([...after].sort()).toEqual([...before].sort())
      expect(after.at(-1)).toBe('lejia-a')
    })
    it('ignores retired, scheduled and expired rules using the same instant as pricing', async () => {
      const first = await run(rule({ productId: P.E, weight: 5 }))
      expect((await slugs('lejía neutra', at()))[0]).toBe('lejia-e')
      expect(await slugs('lejía neutra', at(30 * DAY))).toEqual(BASELINE)
      expect(await slugs('lejía neutra', at(-2 * HOUR))).toEqual(BASELINE)
      await run({ action: 'retire', id: first.item.id, expectedVersion: 1, reason: 'Retirada para prueba' })
      expect(await slugs()).toEqual(BASELINE)
    })
    it('ignores a rule exactly at its validUntil instant and applies it exactly at validFrom', async () => {
      const validFrom = at(-HOUR),
        validUntil = at(DAY)
      await run(rule({ validFrom, validUntil }))
      expect((await slugs('lejía neutra', validFrom))[0]).toBe('lejia-e')
      expect(await slugs('lejía neutra', validUntil)).toEqual(BASELINE)
    })
    it('answers with the same three bounded reads whether or not rules exist', async () => {
      await run(rule({ productId: P.E }))
      await run(rule({ productId: P.A, kind: 'bury' }))
      await run(redirect({ term: 'lejia neutra', redirectPath: '/catalogo' }))
      let statements = 0
      const counted = {
        ...database,
        prepare(sql: string) {
          statements++
          return database.prepare(sql)
        }
      } as D1Database
      const result = await searchPublishedProducts(counted, 'lejía neutra')
      expect(result.items.map((item) => item.slug)).toEqual(['lejia-e', 'lejia-b', 'lejia-c', 'lejia-a'])
      expect(statements).toBe(3)
    })
  })

  describe('public search redirects', () => {
    it('returns the redirect for a normalized term while still returning every result', async () => {
      await run(redirect({ term: 'Lejía neutra', redirectPath: '/catalogo?categoria=limpieza' }))
      const result = await searchPublishedProducts(database, ' LEJIA  neutra')
      expect(result.redirect).toEqual({ path: '/catalogo?categoria=limpieza' })
      expect(result.items.map((item) => item.slug)).toEqual(BASELINE)
    })
    it('returns a redirect even when the term matches no product', async () => {
      await run(redirect())
      const result = await searchPublishedProducts(database, 'OFERTA limpieza')
      expect(result).toEqual({ items: [], redirect: { path: '/catalogo?categoria=limpieza' } })
    })
    it('does not apply a redirect to other terms, after expiry or after retirement', async () => {
      const first = await run(redirect())
      expect(await searchPublishedProducts(database, 'oferta')).not.toHaveProperty('redirect')
      expect(await searchPublishedProducts(database, 'oferta limpieza', { instant: at(30 * DAY) })).not.toHaveProperty(
        'redirect'
      )
      expect(await searchPublishedProducts(database, 'oferta limpieza', { instant: at(-2 * HOUR) })).not.toHaveProperty(
        'redirect'
      )
      await run({ action: 'retire', id: first.item.id, expectedVersion: 1, reason: 'Redirección retirada' })
      expect(await searchPublishedProducts(database, 'oferta limpieza')).toEqual({ items: [] })
    })
    it('stops redirecting to a product page once that product is no longer published', async () => {
      await run(redirect({ redirectPath: '/producto/lejia-c' }))
      expect((await searchPublishedProducts(database, 'oferta limpieza')).redirect).toEqual({
        path: '/producto/lejia-c'
      })
      sqlite.exec("UPDATE products SET status='draft' WHERE id='" + P.C + "'")
      expect(await searchPublishedProducts(database, 'oferta limpieza')).toEqual({ items: [] })
    })
  })
})
