import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resourceHubFixture } from './resource-hub-fixture'
import { CMS_CLAIMS } from './d1-cms-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleContentGovernanceAdminHttp,
  handleContentGovernancePublicHttp,
  ownsContentGovernanceAdminNamespace,
  ownsContentGovernancePublicNamespace
} from '../../workers/content/content-governance-http'
import { testUuid, testNow } from '../support/deterministic'

const day = (offset: number) => new Date(testNow() + offset * 86_400_000).toISOString().slice(0, 10)
const origin = 'https://governance.neteco.invalid'
const password = 'synthetic-only-cookie-password-32-characters'
const SECOND = {
  identityId: '10000000-0000-4000-8000-000000000161',
  sessionId: '20000000-0000-4000-8000-000000000161',
  sessionVersion: 1
}

describe('content governance HTTP contract', () => {
  let f: Awaited<ReturnType<typeof resourceHubFixture>>
  let cookie: string, secondCookie: string, slug: string
  const env = () => ({ DB: f.database, AUTH_ENABLED: 'true', AUTH_ORIGIN: origin, NUXT_SESSION_PASSWORD: password })
  const admin = (path = '', method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    handleContentGovernanceAdminHttp(
      new Request(`${origin}/api/admin/content-governance${path}`, {
        method,
        headers: {
          cookie,
          origin,
          'content-type': 'application/json',
          'idempotency-key': testUuid(),
          ...headers
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      }),
      env()
    ) as Promise<Response>
  const pub = (path: string, method = 'GET') =>
    handleContentGovernancePublicHttp(new Request(`${origin}${path}`, { method }), {
      database: f.database,
      origin
    }) as Promise<Response>
  const person = (name: string) => ({
    action: 'save_author',
    expectedVersion: 0,
    displayName: name,
    bio: 'Biografía de prueba introducida por administración.',
    experience: 'Experiencia relevante de prueba introducida por administración.'
  })

  beforeEach(async () => {
    f = await resourceHubFixture()
    f.sqlite.exec(
      await readFile(new URL('../../db/d1/migrations/0149_content_governance.sql', import.meta.url), 'utf8')
    )
    const past = new Date(testNow() - 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    f.sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'second-http@example.invalid','synthetic-only',?,'active',?,?)"
      )
      .run(SECOND.identityId, past, past, past)
    f.sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'cms_editor',?)")
      .run(SECOND.identityId, past)
    f.sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)'
      )
      .run(
        SECOND.sessionId,
        SECOND.identityId,
        past,
        new Date(testNow() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
      )
    cookie = (await issueD1SessionCookie(f.database, CMS_CLAIMS, { password, maxAgeSeconds: 3600 }))!.split(';')[0]!
    secondCookie = (await issueD1SessionCookie(f.database, SECOND, { password, maxAgeSeconds: 3600 }))!.split(';')[0]!
    slug = (await f.resource({}, true)).slug as string
  })
  afterEach(() => f.sqlite.close())

  it('owns its namespaces including encoded variants and nothing else', () => {
    expect(ownsContentGovernanceAdminNamespace('/api/admin/content-governance')).toBe(true)
    expect(ownsContentGovernanceAdminNamespace('/api/admin/content%2Dgovernance/x')).toBe(true)
    expect(ownsContentGovernanceAdminNamespace('/api/admin/content/pages')).toBe(false)
    expect(ownsContentGovernancePublicNamespace('/api/content-trust/a')).toBe(true)
    expect(ownsContentGovernancePublicNamespace('/api/content-assets')).toBe(true)
    expect(ownsContentGovernancePublicNamespace('/api/content-assets%2Fx')).toBe(true)
    expect(ownsContentGovernancePublicNamespace('/api/resources')).toBe(false)
  })
  it('ignores foreign paths', async () => {
    expect(await handleContentGovernanceAdminHttp(new Request(`${origin}/api/other`), env())).toBeNull()
    expect(
      await handleContentGovernancePublicHttp(new Request(`${origin}/api/other`), { database: f.database, origin })
    ).toBeNull()
  })

  describe('admin', () => {
    it('requires a valid session (awaiting verification) and rejects forged cookies', async () => {
      const none = await admin('', 'GET', undefined, { cookie: '' })
      expect(none.status).toBe(401)
      const forged = await admin('', 'GET', undefined, { cookie: 'neteco_session=forged' })
      expect(forged.status).toBe(401)
    })
    it('reports unavailable when authentication is disabled', async () => {
      const response = await handleContentGovernanceAdminHttp(
        new Request(`${origin}/api/admin/content-governance`, { headers: { cookie } }),
        { ...env(), AUTH_ENABLED: 'false' }
      )
      expect(response!.status).toBe(503)
    })
    it('serves the private overview with no-store headers', async () => {
      const response = await admin()
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(response.headers.get('x-robots-tag')).toContain('noindex')
      expect(await response.json()).toMatchObject({ source: 'cloudflare', authors: [], governance: [], assets: [] })
    })
    it.each([
      ['foreign Origin', { origin: 'https://evil.invalid' }],
      ['missing Origin', { origin: '' }],
      ['cross-site fetch', { 'sec-fetch-site': 'cross-site' }]
    ])('rejects %s on mutations', async (_n, headers) => {
      const response = await admin('', 'POST', person('Ana Prueba'), headers)
      expect(response.status).toBe(403)
      expect((await response.json()).error.code).toBe('csrf_rejected')
      expect(f.sqlite.prepare('SELECT count(*) n FROM content_authors').get()).toEqual({ n: 0 })
    })
    it('requires an Idempotency-Key, JSON content type and a bounded body', async () => {
      expect((await admin('', 'POST', person('Ana Prueba'), { 'idempotency-key': '' })).status).toBe(400)
      expect((await admin('', 'POST', person('Ana Prueba'), { 'content-type': 'text/plain' })).status).toBe(415)
      const big = await admin('', 'POST', { ...person('Ana Prueba'), bio: 'x'.repeat(40_000) })
      expect(big.status).toBe(413)
    })
    it('rejects malformed JSON, unknown fields and client-supplied identity', async () => {
      const bad = await handleContentGovernanceAdminHttp(
        new Request(`${origin}/api/admin/content-governance`, {
          method: 'POST',
          headers: { cookie, origin, 'content-type': 'application/json', 'idempotency-key': 'k1' },
          body: '{nope'
        }),
        env()
      )
      expect(bad!.status).toBe(400)
      expect((await admin('', 'POST', { ...person('Ana Prueba'), actorId: SECOND.identityId })).status).toBe(422)
    })
    it('runs the whole flow: author, reviewer, plan, sign-off by another person, public trust', async () => {
      const a = (await (await admin('', 'POST', person('Ana Autora'))).json()).item
      const r = (await (await admin('', 'POST', person('Luis Revisor'))).json()).item
      const plan = {
        action: 'save_governance',
        slug,
        expectedVersion: 0,
        ownerName: 'Equipo técnico',
        sensitivity: 'product',
        nextReviewAt: day(45),
        authorId: a.id,
        reviewerId: r.id,
        sources: [
          { label: 'Ficha de datos de seguridad', url: 'https://example.invalid/fds.pdf', kind: 'safety_data_sheet' }
        ],
        claims: [{ text: 'Apto para superficies en contacto con alimentos', category: 'chemical', sourceIndex: 0 }],
        retirement: null
      }
      const saved = await admin('', 'POST', plan)
      expect(saved.status).toBe(200)
      expect((await pub(`/api/content-trust/${slug}`)).status).toBe(404)
      const own = await admin('', 'POST', { action: 'sign_off', slug, expectedVersion: 1 })
      expect(own.status).toBe(409)
      expect((await own.json()).error.code).toBe('same_actor')
      const signed = await admin('', 'POST', { action: 'sign_off', slug, expectedVersion: 1 }, { cookie: secondCookie })
      expect(signed.status).toBe(200)
      const trust = await pub(`/api/content-trust/${slug}`)
      expect(trust.status).toBe(200)
      expect(trust.headers.get('cache-control')).toBe('private, no-store')
      const body = await trust.json()
      expect(body.author.name).toBe('Ana Autora')
      expect(body.jsonLd['@type']).toBe('Article')
      expect(JSON.stringify(body)).not.toContain('ownerName')
    })
    it('replays idempotent commands and maps domain errors to stable statuses', async () => {
      const key = 'same-key-1'
      const one = await admin('', 'POST', person('Ana Autora'), { 'idempotency-key': key })
      const two = await admin('', 'POST', person('Ana Autora'), { 'idempotency-key': key })
      expect(await two.json()).toEqual(await one.json())
      expect((await admin('', 'POST', person('Otra Persona'), { 'idempotency-key': key })).status).toBe(409)
      const missing = await admin(
        '',
        'POST',
        { action: 'sign_off', slug: 'nada', expectedVersion: 1 },
        { cookie: secondCookie }
      )
      expect(missing.status).toBe(404)
    })
    it('rate limits command bursts', async () => {
      let last = 0
      for (let n = 0; n < 62; n++)
        last = (await admin('', 'POST', { action: 'sign_off', slug: 'nada', expectedVersion: 1 })).status
      expect(last).toBe(429)
    })
    it('answers 405 for unsupported methods and 400 for unknown query or sub-paths', async () => {
      const del = await admin('', 'DELETE')
      expect(del.status).toBe(405)
      expect(del.headers.get('allow')).toBe('GET, POST')
      expect((await admin('?x=1')).status).toBe(400)
      expect((await admin('/otra-cosa')).status).toBe(400)
    })
  })

  describe('public', () => {
    const publishAsset = async () => {
      await admin('', 'POST', {
        action: 'save_asset',
        expectedVersion: 0,
        slug: 'checklist-limpieza',
        kind: 'checklist',
        title: 'Checklist de limpieza',
        summary: 'Lista de comprobación para limpieza profesional.',
        methodology: 'Elaborada por el equipo técnico a partir de procedimientos internos documentados.',
        dataAsOf: day(-2),
        payload: { items: ['Paso uno'] }
      })
      await admin('', 'POST', { action: 'publish_asset', slug: 'checklist-limpieza', expectedVersion: 1 })
    }
    it('lists and reads only published assets', async () => {
      expect(await (await pub('/api/content-assets')).json()).toEqual({ items: [] })
      await publishAsset()
      const list = await (await pub('/api/content-assets')).json()
      expect(list.items[0]).toMatchObject({ slug: 'checklist-limpieza', dataAsOf: day(-2) })
      const detail = await pub('/api/content-assets/checklist-limpieza')
      expect(detail.status).toBe(200)
      expect((await detail.json()).methodology).toContain('procedimientos internos')
      expect((await pub('/api/content-assets/otra')).status).toBe(404)
    })
    it('is read only, strict about query strings and slugs', async () => {
      expect((await pub('/api/content-assets', 'POST')).status).toBe(405)
      expect((await pub('/api/content-assets?x=1')).status).toBe(400)
      expect((await pub('/api/content-trust/NO_VALIDO')).status).toBe(404)
      expect((await pub('/api/content-trust')).status).toBe(404)
      expect((await pub('/api/content-assets/a/b')).status).toBe(404)
    })
    it('answers 410 with the planned redirect for a retired resource', async () => {
      const a = (await (await admin('', 'POST', person('Ana Autora'))).json()).item
      f.sqlite
        .prepare(
          `INSERT INTO content_governance(slug,owner_name,sensitivity,next_review_at,author_id,sources,claims,retire_at,redirect_to,last_saved_by,version,created_at,updated_at)
           VALUES(?,'Equipo','general',?,?,'[]','[]',?,'/recursos/nueva',?,1,?,?)`
        )
        .run(slug, day(100), a.id, day(-1), SECOND.identityId, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      const response = await pub(`/api/content-trust/${slug}`)
      expect(response.status).toBe(410)
      expect(await response.json()).toMatchObject({ error: { code: 'retired' }, redirectTo: '/recursos/nueva' })
    })
  })
})
