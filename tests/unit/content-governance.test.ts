import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resourceHubFixture } from './resource-hub-fixture'
import { CMS_CLAIMS } from './d1-cms-fixture'
import {
  ContentGovernanceError,
  executeContentGovernanceCommand,
  listPublicAssets,
  readContentGovernanceOverview,
  readPublicAsset,
  readPublicTrust
} from '../../workers/content/content-governance'

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const instant = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
const SECOND = {
  identityId: '10000000-0000-4000-8000-000000000151',
  sessionId: '20000000-0000-4000-8000-000000000151',
  sessionVersion: 1
}
const NOBODY = {
  identityId: '10000000-0000-4000-8000-000000000152',
  sessionId: '20000000-0000-4000-8000-000000000152',
  sessionVersion: 1
}
const source = {
  label: 'Ficha de datos de seguridad',
  url: 'https://example.invalid/fds.pdf',
  kind: 'safety_data_sheet'
}

describe('content governance domain (SEO-029/030/031)', () => {
  let f: Awaited<ReturnType<typeof resourceHubFixture>>
  let slug: string, authorId: string, reviewerId: string
  const run = (input: unknown, claims = CMS_CLAIMS, key = crypto.randomUUID(), now?: string) =>
    executeContentGovernanceCommand(f.database, claims, input, { idempotencyKey: key, ...(now ? { now } : {}) })
  const code = async (promise: Promise<unknown>) => {
    try {
      await promise
    } catch (error) {
      if (error instanceof ContentGovernanceError) return error.code
      throw error
    }
    return 'ok'
  }
  const person = (name: string) => ({
    action: 'save_author',
    expectedVersion: 0,
    displayName: name,
    bio: 'Biografía de prueba introducida por administración.',
    experience: 'Experiencia relevante de prueba introducida por administración.',
    credentials: 'Credencial de prueba introducida por administración'
  })
  const governance = (extra: Record<string, unknown> = {}) => ({
    action: 'save_governance',
    slug,
    expectedVersion: 0,
    ownerName: 'Equipo técnico',
    sensitivity: 'regulation',
    nextReviewAt: day(60),
    authorId,
    reviewerId,
    sources: [source],
    claims: [{ text: 'Afirmación sanitaria con evidencia', category: 'health', sourceIndex: 0 }],
    retirement: null,
    ...extra
  })
  const asset = (extra: Record<string, unknown> = {}) => ({
    action: 'save_asset',
    expectedVersion: 0,
    slug: 'checklist-limpieza',
    kind: 'checklist',
    title: 'Checklist de limpieza',
    summary: 'Lista de comprobación para limpieza profesional.',
    methodology: 'Elaborada por el equipo técnico a partir de procedimientos internos documentados y revisados.',
    dataAsOf: day(-5),
    payload: { items: ['Paso uno', 'Paso dos'] },
    ...extra
  })

  beforeEach(async () => {
    f = await resourceHubFixture()
    f.sqlite.exec(
      await readFile(new URL('../../db/d1/migrations/0149_content_governance.sql', import.meta.url), 'utf8')
    )
    const past = instant(-86_400_000)
    for (const [id, session, email, role] of [
      [SECOND.identityId, SECOND.sessionId, 'second@example.invalid', 'cms_editor'],
      [NOBODY.identityId, NOBODY.sessionId, 'nobody@example.invalid', null]
    ] as const) {
      f.sqlite
        .prepare(
          "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,?,'synthetic-only',?,'active',?,?)"
        )
        .run(id, email, past, past, past)
      if (role)
        f.sqlite
          .prepare('INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,?,?)')
          .run(id, role, past)
      f.sqlite
        .prepare(
          'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)'
        )
        .run(session, id, past, instant(3_600_000))
    }
    slug = (await f.resource({}, true)).slug as string
    authorId = (await run(person('Ana Autora'))).item.id
    reviewerId = (await run(person('Luis Revisor'))).item.id
  })
  afterEach(() => f.sqlite.close())

  describe('authors', () => {
    it('stores admin-entered profile data verbatim with server time', async () => {
      const { entity, item } = await run(person('Marta Prueba'))
      expect(entity).toBe('author')
      expect(item).toMatchObject({ displayName: 'Marta Prueba', version: 1, status: 'active' })
      expect(item.credentials).toBe('Credencial de prueba introducida por administración')
      expect(Date.parse(item.createdAt)).toBeGreaterThan(Date.now() - 60_000)
    })
    it('leaves credentials null when the admin did not enter any', async () => {
      const { credentials: _unused, ...bare } = person('Sin Credencial')
      expect((await run(bare)).item.credentials).toBeNull()
    })
    it('updates with CAS and rejects stale versions', async () => {
      const next = await run({ ...person('Ana Autora 2'), id: authorId, expectedVersion: 1 })
      expect(next.item.version).toBe(2)
      expect(await code(run({ ...person('Otra'), id: authorId, expectedVersion: 1 }))).toBe('version_conflict')
    })
    it('rejects id on create, missing id on update and unknown id', async () => {
      expect(await code(run({ ...person('X Y Z'), id: crypto.randomUUID() }))).toBe('invalid_input')
      expect(await code(run({ ...person('X Y Z'), expectedVersion: 2 }))).toBe('invalid_input')
      expect(await code(run({ ...person('X Y Z'), id: crypto.randomUUID(), expectedVersion: 1 }))).toBe('not_found')
    })
    it('replays identical idempotent commands and refuses a changed payload under the same key', async () => {
      const key = crypto.randomUUID()
      const first = await run(person('Idem Potente'), CMS_CLAIMS, key)
      expect(await run(person('Idem Potente'), CMS_CLAIMS, key)).toEqual(first)
      expect(await code(run(person('Idem Distinto'), CMS_CLAIMS, key))).toBe('idempotency_conflict')
      expect(
        f.sqlite.prepare("SELECT count(*) n FROM content_authors WHERE display_name='Idem Potente'").get()
      ).toEqual({ n: 1 })
    })
    it('refuses unauthenticated, unauthorised and malformed callers', async () => {
      expect(await code(run(person('A B C'), { ...CMS_CLAIMS, sessionId: crypto.randomUUID() }))).toBe(
        'unauthenticated'
      )
      expect(await code(run(person('A B C'), NOBODY))).toBe('forbidden')
      expect(await code(run({ action: 'save_author' }))).toBe('invalid_input')
      expect(await code(run(person('A B C'), CMS_CLAIMS, 'bad key with spaces'))).toBe('invalid_input')
    })
    it('re-checks live authorization after the revocation of a role', async () => {
      f.sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(SECOND.identityId)
      expect(await code(run(person('A B C'), SECOND))).toBe('forbidden')
    })
  })

  describe('governance and review calendar', () => {
    it('creates the plan, owner and next review without a signature', async () => {
      const { item } = await run(governance())
      expect(item).toMatchObject({ slug, ownerName: 'Equipo técnico', version: 1, signedOffAt: null })
      expect(item.trust.issues).toEqual(['not_signed_off'])
    })
    it.each([
      ['unknown page', { slug: 'no-existe' }, 'unknown_page'],
      ['unknown author', { authorId: crypto.randomUUID() }, 'unknown_person'],
      ['review in the past', { nextReviewAt: day(-1) }, 'date_out_of_range'],
      ['review today', { nextReviewAt: day(0) }, 'date_out_of_range'],
      ['regulation review beyond a year', { nextReviewAt: day(400) }, 'date_out_of_range'],
      ['retirement in the past', { retirement: { retireAt: day(-2), redirectTo: null } }, 'date_out_of_range']
    ])('rejects %s', async (_n, extra, expected) => {
      expect(await code(run(governance(extra)))).toBe(expected)
    })
    it('lets general content use a two-year horizon', async () => {
      expect(
        await code(run(governance({ sensitivity: 'general', nextReviewAt: day(600), claims: [], sources: [] })))
      ).toBe('ok')
    })
    it('refuses archived people', async () => {
      await run({ ...person('Ana Autora'), id: authorId, expectedVersion: 1, status: 'archived' })
      expect(await code(run(governance()))).toBe('person_archived')
    })
    it('plans retirement with a redirect that stays internal', async () => {
      const { item } = await run(governance({ retirement: { retireAt: day(30), redirectTo: '/recursos/otra' } }))
      expect(item.retirement).toEqual({ retireAt: day(30), redirectTo: '/recursos/otra' })
    })
    it('uses CAS: duplicate create and stale update both conflict', async () => {
      await run(governance())
      expect(await code(run(governance()))).toBe('version_conflict')
      expect(await code(run(governance({ expectedVersion: 5 })))).toBe('version_conflict')
    })
    it('lets only one of two concurrent writers win', async () => {
      await run(governance())
      const results = await Promise.all(
        [1, 2].map((n) => code(run(governance({ expectedVersion: 1, ownerName: `Equipo ${n}` }))))
      )
      expect(results.filter((r) => r === 'ok')).toHaveLength(1)
      expect(f.sqlite.prepare('SELECT version FROM content_governance').get()).toEqual({ version: 2 })
    })
    it('does not trust a client supplied actor or signature time', async () => {
      expect(await code(run({ ...governance(), signedOffAt: instant(), lastSavedBy: SECOND.identityId }))).toBe(
        'invalid_input'
      )
    })
    it('lists the calendar bucketed against the server clock and flags unmanaged resource pages', async () => {
      await run(governance({ nextReviewAt: day(10) }))
      const other = (await f.resource({}, true)).slug as string
      const overview = await readContentGovernanceOverview(f.database, CMS_CLAIMS)
      expect(overview.governance[0]).toMatchObject({ slug, bucket: 'due_30' })
      expect(overview.unmanagedResources).toContain(other)
      expect(overview.unmanagedResources).not.toContain(slug)
      f.sqlite.prepare('UPDATE content_governance SET next_review_at=? WHERE slug=?').run(day(-1), slug)
      const late = await readContentGovernanceOverview(f.database, CMS_CLAIMS)
      expect(late.governance[0]).toMatchObject({ bucket: 'overdue' })
      expect(late.governance[0]!.trust.state).toBe('overdue')
    })
    it('hides the overview from unauthorised callers', async () => {
      expect(await code(readContentGovernanceOverview(f.database, NOBODY))).toBe('forbidden')
    })
  })

  describe('technical review sign-off', () => {
    beforeEach(async () => {
      await run(governance())
    })
    it('requires a different, authorised person than the last editor', async () => {
      expect(await code(run({ action: 'sign_off', slug, expectedVersion: 1 }))).toBe('same_actor')
      expect(await code(run({ action: 'sign_off', slug, expectedVersion: 1 }, NOBODY))).toBe('forbidden')
    })
    it('signs off with server time and identity, making the trust verified', async () => {
      const at = instant()
      const { item } = await run({ action: 'sign_off', slug, expectedVersion: 1 }, SECOND, crypto.randomUUID(), at)
      expect(item).toMatchObject({ signedOffAt: at, signedOffBy: SECOND.identityId, version: 2 })
      expect(item.trust).toEqual({ state: 'verified', issues: [] })
    })
    it('refuses a stale version', async () => {
      expect(await code(run({ action: 'sign_off', slug, expectedVersion: 7 }, SECOND))).toBe('version_conflict')
    })
    it('refuses unknown plans', async () => {
      expect(await code(run({ action: 'sign_off', slug: 'nada', expectedVersion: 1 }, SECOND))).toBe('not_found')
    })
    it('refuses sign-off while a claim lacks evidence', async () => {
      await run(
        governance({
          expectedVersion: 1,
          claims: [{ text: 'Afirmación química sin fuente', category: 'chemical', sourceIndex: null }]
        })
      )
      expect(await code(run({ action: 'sign_off', slug, expectedVersion: 2 }, SECOND))).toBe('incomplete_trust')
    })
    it('refuses sign-off without author or reviewer', async () => {
      await run(governance({ expectedVersion: 1, reviewerId: null }))
      expect(await code(run({ action: 'sign_off', slug, expectedVersion: 2 }, SECOND))).toBe('incomplete_trust')
    })
    it('invalidates the signature when the plan is edited', async () => {
      await run({ action: 'sign_off', slug, expectedVersion: 1 }, SECOND)
      const { item } = await run(governance({ expectedVersion: 2, ownerName: 'Otro equipo' }), SECOND)
      expect(item.signedOffAt).toBeNull()
      expect(item.trust.issues).toContain('not_signed_off')
    })
    it('keeps an append-only history', async () => {
      await run({ action: 'sign_off', slug, expectedVersion: 1 }, SECOND)
      const count = f.sqlite.prepare("SELECT count(*) n FROM content_governance_events WHERE entity='governance'").get()
      expect(count).toEqual({ n: 2 })
      expect(() => f.sqlite.exec('UPDATE content_governance_events SET version=99')).toThrow(/immutable/)
      expect(() => f.sqlite.exec('DELETE FROM content_governance_events')).toThrow(/immutable/)
    })
  })

  describe('public trust (SEO-031) and JSON-LD', () => {
    const origin = 'https://neteco.invalid'
    const verify = async () => {
      await run(governance())
      await run({ action: 'sign_off', slug, expectedVersion: 1 }, SECOND)
    }
    it('publishes author, reviewer, evidence and JSON-LD only after verification', async () => {
      await run(governance())
      expect(await code(readPublicTrust(f.database, slug, { origin }))).toBe('not_found')
      await run({ action: 'sign_off', slug, expectedVersion: 1 }, SECOND)
      const trust = await readPublicTrust(f.database, slug, { origin })
      expect(trust).toMatchObject({
        status: 'active',
        slug,
        author: { name: 'Ana Autora' },
        reviewer: { name: 'Luis Revisor' }
      })
      if (trust.status !== 'active') throw new Error('unexpected')
      expect(trust.claims[0]).toMatchObject({ category: 'health', evidence: { label: source.label } })
      expect(trust.jsonLd.reviewedBy.name).toBe('Luis Revisor')
      expect(trust.jsonLd.url).toBe(`${origin}/recursos/${slug}`)
      expect(JSON.stringify(trust)).not.toContain('Equipo técnico')
    })
    it('does not leak anything for missing or non-published pages', async () => {
      expect(await code(readPublicTrust(f.database, 'no-existe', { origin }))).toBe('not_found')
      const draftOnly = (await f.resource({}, false)).slug as string
      await run(governance({ slug: draftOnly }))
      await run({ action: 'sign_off', slug: draftOnly, expectedVersion: 1 }, SECOND)
      expect(await code(readPublicTrust(f.database, draftOnly, { origin }))).toBe('not_found')
    })
    it('stops claiming expertise once the review is overdue', async () => {
      await verify()
      const later = new Date(Date.now() + 61 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
      expect(await code(readPublicTrust(f.database, slug, { origin, now: later }))).toBe('not_found')
    })
    it('reports a planned retirement with its redirect once due', async () => {
      await run(governance({ retirement: { retireAt: day(30), redirectTo: '/recursos/otra' } }))
      await run({ action: 'sign_off', slug, expectedVersion: 1 }, SECOND)
      const before = await readPublicTrust(f.database, slug, { origin })
      expect(before.status).toBe('active')
      const later = new Date(Date.now() + 31 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
      expect(await readPublicTrust(f.database, slug, { origin, now: later })).toEqual({
        status: 'retired',
        slug,
        redirectTo: '/recursos/otra'
      })
    })
    it('rejects malformed slugs', async () => {
      expect(await code(readPublicTrust(f.database, '../x', { origin }))).toBe('not_found')
    })
  })

  describe('linkable assets (SEO-030)', () => {
    it('creates a draft that is invisible to the public', async () => {
      const { item } = await run(asset())
      expect(item).toMatchObject({ status: 'draft', version: 1, publishedAt: null })
      expect(await listPublicAssets(f.database)).toEqual({ items: [] })
      expect(await code(readPublicAsset(f.database, 'checklist-limpieza'))).toBe('not_found')
    })
    it('publishes with server time and shows methodology and date', async () => {
      const at = instant()
      await run(asset())
      const { item } = await run(
        { action: 'publish_asset', slug: 'checklist-limpieza', expectedVersion: 1 },
        CMS_CLAIMS,
        crypto.randomUUID(),
        at
      )
      expect(item).toMatchObject({ status: 'published', publishedAt: at, version: 2 })
      const list = await listPublicAssets(f.database)
      expect(list.items[0]).toMatchObject({ slug: 'checklist-limpieza', kind: 'checklist', dataAsOf: asset().dataAsOf })
      const detail = await readPublicAsset(f.database, 'checklist-limpieza')
      expect(detail.methodology).toContain('procedimientos internos')
      expect(detail.payload).toEqual({ items: ['Paso uno', 'Paso dos'] })
    })
    it('refuses future data dates and malformed payloads', async () => {
      expect(await code(run(asset({ dataAsOf: day(3) })))).toBe('date_out_of_range')
      expect(await code(run(asset({ payload: { sections: [] } })))).toBe('invalid_input')
    })
    it('refuses duplicate creation, double publish and unknown targets', async () => {
      await run(asset())
      expect(await code(run(asset()))).toBe('version_conflict')
      await run({ action: 'publish_asset', slug: 'checklist-limpieza', expectedVersion: 1 })
      expect(await code(run({ action: 'publish_asset', slug: 'checklist-limpieza', expectedVersion: 2 }))).toBe(
        'invalid_state'
      )
      expect(await code(run({ action: 'publish_asset', slug: 'nada', expectedVersion: 1 }))).toBe('not_found')
    })
    it('sends an edited published asset back to draft', async () => {
      await run(asset())
      await run({ action: 'publish_asset', slug: 'checklist-limpieza', expectedVersion: 1 })
      const { item } = await run(asset({ expectedVersion: 2, title: 'Checklist actualizada' }))
      expect(item).toMatchObject({ status: 'draft', publishedAt: null, version: 3 })
      expect((await listPublicAssets(f.database)).items).toHaveLength(0)
    })
    it('retires an asset and then refuses edits', async () => {
      await run(asset())
      await run({ action: 'publish_asset', slug: 'checklist-limpieza', expectedVersion: 1 })
      const { item } = await run({ action: 'retire_asset', slug: 'checklist-limpieza', expectedVersion: 2 })
      expect(item.status).toBe('retired')
      expect(await code(run(asset({ expectedVersion: 3 })))).toBe('invalid_state')
      expect(await code(readPublicAsset(f.database, 'checklist-limpieza'))).toBe('not_found')
    })
    it('stores a calculator and a study with their transparent method', async () => {
      await run(
        asset({
          slug: 'dilucion-suelos',
          kind: 'calculator',
          payload: { type: 'dilution', presets: [{ use: 'Suelos', concentrateParts: 1, waterParts: 49 }] }
        })
      )
      await run(
        asset({
          slug: 'estudio-consumo',
          kind: 'study',
          payload: { sampleSize: 40, dataset: [{ label: 'Consumo', value: 12.5, unit: 'L' }] }
        })
      )
      for (const s of ['dilucion-suelos', 'estudio-consumo'])
        await run({ action: 'publish_asset', slug: s, expectedVersion: 1 })
      expect((await listPublicAssets(f.database)).items.map((i) => i.slug)).toEqual([
        'dilucion-suelos',
        'estudio-consumo'
      ])
    })
    it('requires write permission', async () => {
      expect(await code(run(asset(), NOBODY))).toBe('forbidden')
    })
  })
})
