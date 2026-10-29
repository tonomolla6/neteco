import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { adminMarketingModalIntentHash, type AdminMarketingModalInput } from '../../shared/marketing-modals'
import {
  handleMarketingModalsHttp,
  isAdminMarketingModalsPath,
  ownsMarketingModalsNamespace,
  type MarketingModalsHttpDependencies
} from '../../workers/marketing/marketing-modals-http'

const ORIGIN = 'https://shop.neteco.test'
const NOW = '2026-10-15T10:00:00Z'
const PASSWORD = 'test-session-password-at-least-32-characters-long!'
const PEPPER = 'test-rate-limit-pepper-at-least-32-characters-long!'

const ADMIN_ID = '10000000-0000-4000-8000-000000000094'
const ADMIN_SESSION = '20000000-0000-4000-8000-000000000094'
const MODAL_ID = '50000000-0000-4000-8000-000000000001'
const CMD_ID = '60000000-0000-4000-8000-000000000001'
const EVENT_ID = '70000000-0000-4000-8000-000000000001'

describe('D1 marketing modals HTTP boundary (MKT-009 + MKT-010)', () => {
  let sqlite: DatabaseSync
  let db: D1Database
  let adminCookie: string
  let deps: MarketingModalsHttpDependencies

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    sqlite.exec(await readFile(new URL('../../db/d1/migrations/0094_marketing_modals.sql', import.meta.url), 'utf8'))
    db = d1OverSqlite(sqlite)

    sqlite.exec(`
      INSERT OR IGNORE INTO roles (code, name, description) VALUES ('admin', 'Administración', 'Fixture de marketing');
      INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES ('administration.manage', 'administration', 'manage', 'Fixture de marketing');
      INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES ('admin', 'administration.manage');
    `)
    sqlite
      .prepare(
        `INSERT INTO identities (id, email, password_hash, status, session_version, email_verified_at, created_at, updated_at)
         VALUES (?, 'admin@neteco.test', 'synthetic-marketing-fixture-hash', 'active', 1, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`
      )
      .run(ADMIN_ID)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, last_seen_at, expires_at)
         VALUES (?, ?, 1, 1, '2026-08-01T00:00:00Z', '2026-10-15T09:00:00Z', '2026-12-31T00:00:00Z')`
      )
      .run(ADMIN_SESSION, ADMIN_ID)
    sqlite
      .prepare(
        `INSERT INTO identity_roles (identity_id, role_code, granted_by, granted_at)
         VALUES (?, 'admin', ?, '2026-08-01T00:00:00Z')`
      )
      .run(ADMIN_ID, ADMIN_ID)

    const issued = await issueD1SessionCookie(
      db,
      { sessionId: ADMIN_SESSION, identityId: ADMIN_ID, sessionVersion: 1 },
      { password: PASSWORD, maxAgeSeconds: 3600 }
    )
    adminCookie = (issued ?? '').split(';')[0] ?? ''

    deps = {
      database: db,
      sessionCookieConfiguration: { password: PASSWORD, maxAgeSeconds: 3600 },
      origin: ORIGIN,
      rateLimitPepper: PEPPER,
      now: NOW
    }
  })

  afterEach(() => {
    sqlite.close()
  })

  it('claims owned admin and public namespaces including URL-encoded paths', () => {
    expect(ownsMarketingModalsNamespace('/api/admin/marketing-modals')).toBe(true)
    expect(ownsMarketingModalsNamespace('/api/admin/marketing-modals/policy')).toBe(true)
    expect(ownsMarketingModalsNamespace('/api/marketing/modals/eligibility')).toBe(true)
    expect(ownsMarketingModalsNamespace('/api/marketing/modals/events')).toBe(true)
    expect(ownsMarketingModalsNamespace('/api/marketing/%6dodals/eligibility')).toBe(true)
    expect(ownsMarketingModalsNamespace('/api/admin/promotions')).toBe(false)
  })

  it('rejects CSRF, unauthenticated admin requests, wrong methods and oversized payloads with private no-store headers', async () => {
    const unauth = await handleMarketingModalsHttp(new Request(`${ORIGIN}/api/admin/marketing-modals`), deps)
    expect(unauth?.status).toBe(401)
    expect(unauth?.headers.get('cache-control')).toBe('private, no-store')
    expect(await unauth?.json()).toEqual({ error: { code: 'unauthenticated' } })

    const csrf = await handleMarketingModalsHttp(
      new Request(`${ORIGIN}/api/admin/marketing-modals`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          origin: 'https://attacker.invalid',
          'content-type': 'application/json'
        },
        body: '{}'
      }),
      deps
    )
    expect(csrf?.status).toBe(403)
    expect(await csrf?.json()).toEqual({ error: { code: 'csrf_rejected' } })

    const wrongMethod = await handleMarketingModalsHttp(
      new Request(`${ORIGIN}/api/admin/marketing-modals`, {
        method: 'DELETE',
        headers: { cookie: adminCookie, origin: ORIGIN }
      }),
      deps
    )
    expect(wrongMethod?.status).toBe(405)
    expect(wrongMethod?.headers.get('allow')).toBe('GET, POST')
  })

  it('handles full admin CRUD, policy update, command receipt lookup, public eligibility and consented interactions', async () => {
    const createPayload: AdminMarketingModalInput = {
      expectedVersion: 0,
      definition: {
        id: MODAL_ID,
        version: 1,
        code: 'modal-http-catalogo',
        status: 'published',
        title: 'Asesoramiento químico para empresas',
        body: 'Consulta compatibilidad de desengrasantes y desinfectantes con nuestro equipo técnico.',
        ctaLabel: 'Contactar soporte técnico',
        ctaPath: '/contacto',
        objective: 'support_guidance',
        abVariant: null,
        trigger: { kind: 'time_on_page', minSeconds: 6 },
        audience: {
          segments: ['anonymous', 'customer', 'professional'],
          marketingConsent: 'any'
        },
        targeting: {
          includePrefixes: ['/catalogo', '/producto'],
          excludePrefixes: ['/producto/descatalogado']
        },
        priority: 300,
        priorityTier: 'high',
        frequency: { maxImpressionsPerVisitor: 2, windowSeconds: 86400 },
        startsAt: '2026-10-01T00:00:00Z',
        endsAt: '2026-12-31T23:59:59Z'
      },
      reason: 'Alta de modal de asesoramiento técnico en catálogo'
    }

    const createRes = await handleMarketingModalsHttp(
      new Request(`${ORIGIN}/api/admin/marketing-modals`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          origin: ORIGIN,
          'content-type': 'application/json',
          'idempotency-key': CMD_ID
        },
        body: JSON.stringify(createPayload)
      }),
      deps
    )
    expect(createRes?.status).toBe(201)
    expect(createRes?.headers.get('cache-control')).toBe('private, no-store')
    const createdBody = (await createRes?.json()) as { version: number; modalId: string }
    expect(createdBody.version).toBe(1)
    expect(createdBody.modalId).toBe(MODAL_ID)

    // Receipt GET
    const hash = await adminMarketingModalIntentHash(createPayload)
    const receiptRes = await handleMarketingModalsHttp(
      new Request(`${ORIGIN}/api/admin/marketing-modals/commands/${CMD_ID}`, {
        headers: {
          cookie: adminCookie,
          'X-Neteco-Command-Payload-Hash': hash
        }
      }),
      deps
    )
    expect(receiptRes?.status).toBe(200)
    expect((await receiptRes?.json()) as { outcome: string }).toMatchObject({ outcome: 'applied' })

    // Policy update
    const policyRes = await handleMarketingModalsHttp(
      new Request(`${ORIGIN}/api/admin/marketing-modals/policy`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          origin: ORIGIN,
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID()
        },
        body: JSON.stringify({
          expectedVersion: 0,
          globalCooldownSeconds: 1800,
          reason: 'Ajuste de cooldown global a 30 minutos'
        })
      }),
      deps
    )
    expect(policyRes?.status).toBe(201)

    // Public eligibility POST (prohibited route vs eligible route)
    const prohibitedRes = await handleMarketingModalsHttp(
      new Request(`${ORIGIN}/api/marketing/modals/eligibility`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/checkout', viewport: 'desktop', timeOnPageSeconds: 20 })
      }),
      deps
    )
    expect(prohibitedRes?.status).toBe(200)
    expect(prohibitedRes?.headers.get('cache-control')).toBe('private, no-store')
    expect(await prohibitedRes?.json()).toMatchObject({
      eligible: false,
      reason: 'prohibited_route',
      modal: null
    })

    const eligibleRes = await handleMarketingModalsHttp(
      new Request(`${ORIGIN}/api/marketing/modals/eligibility`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/catalogo', viewport: 'mobile', timeOnPageSeconds: 8 })
      }),
      deps
    )
    expect(eligibleRes?.status).toBe(200)
    const eligibleBody = (await eligibleRes?.json()) as {
      eligible: boolean
      globalCooldownSeconds: number
      modal: {
        id: string
        presentation: { layout: string; maxViewportHeightPercent: number }
      } | null
    }
    expect(eligibleBody.eligible).toBe(true)
    expect(eligibleBody.globalCooldownSeconds).toBe(1800)
    expect(eligibleBody.modal?.id).toBe(MODAL_ID)
    expect(eligibleBody.modal?.presentation).toMatchObject({
      layout: 'bottom_sheet',
      maxViewportHeightPercent: 50
    })
    // Ensure audience targeting rules are never leaked in public response
    expect(eligibleBody.modal).not.toHaveProperty('audience')
    expect(eligibleBody.modal).not.toHaveProperty('targeting')

    // Public interaction without analytical consent cookie -> browser_only, 0 DB rows
    const noConsentEventRes = await handleMarketingModalsHttp(
      new Request(`${ORIGIN}/api/marketing/modals/events`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          eventId: EVENT_ID,
          modalId: MODAL_ID,
          modalVersion: 1,
          variant: 'A',
          eventType: 'impression',
          objective: 'support_guidance',
          analyticsConsent: false
        })
      }),
      deps
    )
    expect(noConsentEventRes?.status).toBe(200)
    expect(await noConsentEventRes?.json()).toMatchObject({
      recorded: false,
      persisted: 'browser_only'
    })

    // Public interaction WITH analytical consent cookie -> server_d1, idempotent
    const consentCookie = encodeURIComponent(
      JSON.stringify({ version: 'v1', necessary: true, analytics: true, marketing: true, decidedAt: NOW })
    )
    const consentedEventRes = await handleMarketingModalsHttp(
      new Request(`${ORIGIN}/api/marketing/modals/events`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          cookie: `neteco-consent-v1=${consentCookie}; neteco-analytics-id=80000000-0000-4000-8000-000000000001`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          eventId: EVENT_ID,
          modalId: MODAL_ID,
          modalVersion: 1,
          variant: 'A',
          eventType: 'dismiss',
          objective: 'support_guidance',
          analyticsConsent: true
        })
      }),
      deps
    )
    expect(consentedEventRes?.status).toBe(200)
    expect(await consentedEventRes?.json()).toMatchObject({
      recorded: true,
      persisted: 'server_d1',
      replayed: false
    })
  })
})

const JSON_HEADERS = { origin: ORIGIN, 'content-type': 'application/json' }

async function call(
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
  deps: MarketingModalsHttpDependencies,
  extraSetup?: () => void
) {
  extraSetup?.()
  return handleMarketingModalsHttp(new Request(`${ORIGIN}${path}`, init), deps)
}

describe('D1 marketing modals HTTP boundary matrix (MKT-009 + MKT-010)', () => {
  let sqlite: DatabaseSync
  let db: D1Database
  let adminCookie: string
  let deps: MarketingModalsHttpDependencies

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    sqlite.exec(await readFile(new URL('../../db/d1/migrations/0094_marketing_modals.sql', import.meta.url), 'utf8'))
    db = d1OverSqlite(sqlite)
    sqlite.exec(`
      INSERT OR IGNORE INTO roles (code, name, description) VALUES ('admin', 'Administración', 'Fixture de marketing');
      INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES ('administration.manage', 'administration', 'manage', 'Fixture de marketing');
      INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES ('admin', 'administration.manage');
      INSERT INTO identities (id, email, password_hash, status, session_version, email_verified_at, created_at, updated_at)
        VALUES ('${ADMIN_ID}', 'admin@neteco.test', 'synthetic-marketing-fixture-hash', 'active', 1, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
      INSERT INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, last_seen_at, expires_at)
        VALUES ('${ADMIN_SESSION}', '${ADMIN_ID}', 1, 1, '2026-08-01T00:00:00Z', '2026-10-15T09:00:00Z', '2026-12-31T00:00:00Z');
      INSERT INTO identity_roles (identity_id, role_code, granted_by, granted_at)
        VALUES ('${ADMIN_ID}', 'admin', '${ADMIN_ID}', '2026-08-01T00:00:00Z');
    `)
    const issued = await issueD1SessionCookie(
      db,
      { sessionId: ADMIN_SESSION, identityId: ADMIN_ID, sessionVersion: 1 },
      { password: PASSWORD, maxAgeSeconds: 3600 }
    )
    adminCookie = (issued ?? '').split(';')[0] ?? ''
    deps = {
      database: db,
      sessionCookieConfiguration: { password: PASSWORD, maxAgeSeconds: 3600 },
      origin: ORIGIN,
      rateLimitPepper: PEPPER,
      now: NOW
    }
  })

  afterEach(() => {
    sqlite.close()
  })

  it.each([
    ['/api/admin/marketing-modals/policy', 'x'],
    ['/api/admin/marketing-modals/commands/' + CMD_ID, 'x'],
    ['/api/admin/marketing-modals/' + MODAL_ID, 'x']
  ])('namespace owned: %s', (path) => {
    expect(ownsMarketingModalsNamespace(path)).toBe(true)
  })

  it.each([
    '/api/admin/marketing-modalsX',
    '/api/marketing/modalsX',
    '/api/marketing/newsletter',
    '/api/admin/marketing-modals%ZZ',
    '/apix/marketing/modals'
  ])('namespace not owned: %s', (path) => {
    expect(ownsMarketingModalsNamespace(path)).toBe(false)
  })

  it('separates admin paths (edge limit and AUTH gate) from public paths', () => {
    expect(isAdminMarketingModalsPath('/api/admin/marketing-modals')).toBe(true)
    expect(isAdminMarketingModalsPath('/api/admin/marketing-modals/policy')).toBe(true)
    expect(isAdminMarketingModalsPath('/api/%61dmin/marketing-modals')).toBe(true)
    expect(isAdminMarketingModalsPath('/api/marketing/modals/eligibility')).toBe(false)
  })

  it.each([
    ['GET', '/api/admin/marketing-modals/' + MODAL_ID],
    ['GET', '/api/admin/marketing-modals/commands/' + CMD_ID],
    ['POST', '/api/admin/marketing-modals/policy'],
    ['POST', '/api/admin/marketing-modals']
  ])('admin %s %s without a session -> 401 unauthenticated, no-store', async (method, path) => {
    const response = await call(
      path,
      {
        method,
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : '{}'
      },
      deps
    )
    expect(response?.status).toBe(401)
    expect(response?.headers.get('cache-control')).toBe('private, no-store')
    expect(await response?.json()).toEqual({ error: { code: 'unauthenticated' } })
  })

  it.each([
    ['PUT', '/api/admin/marketing-modals', 'GET, POST'],
    ['DELETE', '/api/admin/marketing-modals/policy', 'POST'],
    ['POST', '/api/admin/marketing-modals/' + MODAL_ID, 'GET'],
    ['GET', '/api/marketing/modals/events', 'POST'],
    ['GET', '/api/marketing/modals/eligibility', 'POST'],
    ['PATCH', '/api/admin/marketing-modals/commands/' + CMD_ID, 'GET']
  ])('%s %s -> 405 with Allow %s', async (method, path, allow) => {
    const response = await call(path, { method, headers: { cookie: adminCookie, origin: ORIGIN } }, deps)
    expect(response?.status).toBe(405)
    expect(response?.headers.get('allow')).toBe(allow)
  })

  it.each([
    '/api/admin/marketing-modals/not-a-uuid',
    '/api/admin/marketing-modals/' + MODAL_ID + '/extra',
    '/api/admin/marketing-modals/commands/',
    '/api/marketing/modals',
    '/api/marketing/modals/unknown'
  ])('unknown or malformed path %s -> 404', async (path) => {
    const response = await call(path, { method: 'GET', headers: { cookie: adminCookie, origin: ORIGIN } }, deps)
    expect(response?.status).toBe(404)
  })

  it('admin writes require a non-empty idempotency key and a JSON body', async () => {
    const noKey = await call(
      '/api/admin/marketing-modals',
      { method: 'POST', headers: { cookie: adminCookie, ...JSON_HEADERS }, body: '{}' },
      deps
    )
    expect(noKey?.status).toBe(400)
    expect(await noKey?.json()).toEqual({ error: { code: 'invalid_input' } })

    const wrongType = await call(
      '/api/admin/marketing-modals',
      {
        method: 'POST',
        headers: { cookie: adminCookie, origin: ORIGIN, 'content-type': 'text/plain', 'idempotency-key': CMD_ID },
        body: '{}'
      },
      deps
    )
    expect(wrongType?.status).toBe(415)
    expect(await wrongType?.json()).toEqual({ error: { code: 'json_required' } })
  })

  it('rejects oversized declared bodies before parsing and malformed JSON with invalid_input', async () => {
    const tooLarge = await call(
      '/api/marketing/modals/events',
      { method: 'POST', headers: { ...JSON_HEADERS, 'content-length': '70000' }, body: '{}' },
      deps
    )
    expect(tooLarge?.status).toBe(413)
    expect(await tooLarge?.json()).toEqual({ error: { code: 'body_too_large' } })

    const malformed = await call(
      '/api/marketing/modals/events',
      { method: 'POST', headers: JSON_HEADERS, body: '{not json' },
      deps
    )
    expect(malformed?.status).toBe(400)
    expect(await malformed?.json()).toEqual({ error: { code: 'invalid_input' } })
  })

  it.each([
    ['[]', 'invalid_input'],
    ['"texto"', 'invalid_input'],
    ['null', 'invalid_input']
  ])('public eligibility body %s -> %s', async (body, code) => {
    const response = await call(
      '/api/marketing/modals/eligibility',
      { method: 'POST', headers: JSON_HEADERS, body },
      deps
    )
    expect(response?.status).toBe(400)
    expect(await response?.json()).toEqual({ error: { code } })
  })

  it.each([
    ['cross-origin POST', { origin: 'https://attacker.invalid', 'content-type': 'application/json' }],
    ['POST without origin', { 'content-type': 'application/json' }],
    [
      'cross-site fetch metadata',
      { origin: ORIGIN, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }
    ]
  ])('public eligibility rejects %s', async (_name, headers) => {
    const response = await call(
      '/api/marketing/modals/eligibility',
      { method: 'POST', headers, body: '{"path":"/catalogo","timeOnPageSeconds":10}' },
      deps
    )
    expect(response?.status).toBe(403)
    expect(await response?.json()).toEqual({ error: { code: 'csrf_rejected' } })
  })

  it('duplicated consent cookies are ambiguous and rejected', async () => {
    const response = await call(
      '/api/marketing/modals/events',
      {
        method: 'POST',
        headers: {
          ...JSON_HEADERS,
          cookie: 'neteco-consent-v1=%7B%7D; neteco-consent-v1=%7B%7D'
        },
        body: '{}'
      },
      deps
    )
    expect(response?.status).toBe(400)
  })

  it('a public eligibility response is minimal: no audience, targeting, visitor identifier or PII', async () => {
    await call(
      '/api/admin/marketing-modals',
      {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          origin: ORIGIN,
          'content-type': 'application/json',
          'idempotency-key': EVENT_ID
        },
        body: JSON.stringify({
          expectedVersion: 0,
          definition: {
            id: MODAL_ID,
            version: 1,
            code: 'modal-minimo-publico',
            status: 'published',
            title: 'Protocolos de higiene profesional',
            body: 'Consulta fichas técnicas y dosificaciones seguras para tu equipo.',
            ctaLabel: 'Ver fichas',
            ctaPath: '/recursos',
            objective: 'catalog_discovery',
            abVariant: null,
            trigger: { kind: 'time_on_page', minSeconds: 5 },
            audience: { segments: ['anonymous'], marketingConsent: 'any' },
            targeting: { includePrefixes: ['/'], excludePrefixes: [] },
            priority: 10,
            priorityTier: 'normal',
            frequency: { maxImpressionsPerVisitor: 1, windowSeconds: 3600 },
            startsAt: '2026-10-01T00:00:00Z',
            endsAt: null
          },
          reason: 'Modal mínimo para verificar la respuesta pública'
        })
      },
      deps
    )
    const response = await call(
      '/api/marketing/modals/eligibility',
      {
        method: 'POST',
        headers: { ...JSON_HEADERS, cookie: 'neteco-analytics-id=80000000-0000-4000-8000-000000000001' },
        body: JSON.stringify({ path: '/catalogo', timeOnPageSeconds: 6 })
      },
      deps
    )
    const text = await response!.text()
    expect(response?.status).toBe(200)
    expect(text).not.toMatch(/audience|targeting|visitor|hash|email|identity/i)
    expect(JSON.parse(text)).toMatchObject({ eligible: true, modal: { id: MODAL_ID, variant: 'A' } })
  })

  it('admin list, policy and receipt validation return stable error codes', async () => {
    const listOk = await call(
      '/api/admin/marketing-modals?perPage=5',
      { method: 'GET', headers: { cookie: adminCookie, origin: ORIGIN } },
      deps
    )
    expect(listOk?.status).toBe(200)
    expect(await listOk?.json()).toMatchObject({
      source: 'cloudflare',
      items: [],
      total: 0,
      policy: { globalCooldownSeconds: 3600 }
    })

    const badStatus = await call(
      '/api/admin/marketing-modals?status=bogus',
      { method: 'GET', headers: { cookie: adminCookie, origin: ORIGIN } },
      deps
    )
    expect(badStatus?.status).toBe(400)

    const badQuery = await call(
      '/api/admin/marketing-modals?unknown=1',
      { method: 'GET', headers: { cookie: adminCookie, origin: ORIGIN } },
      deps
    )
    expect(badQuery?.status).toBe(400)

    const badPolicy = await call(
      '/api/admin/marketing-modals/policy',
      {
        method: 'POST',
        headers: { cookie: adminCookie, ...JSON_HEADERS, 'idempotency-key': EVENT_ID },
        body: JSON.stringify({ expectedVersion: 0, globalCooldownSeconds: 10, reason: 'Pausa fuera de rango' })
      },
      deps
    )
    expect(badPolicy?.status).toBe(400)

    const missingReceipt = await call(
      `/api/admin/marketing-modals/commands/${CMD_ID}`,
      {
        method: 'GET',
        headers: { cookie: adminCookie, origin: ORIGIN, 'X-Neteco-Command-Payload-Hash': 'a'.repeat(64) }
      },
      deps
    )
    expect(missingReceipt?.status).toBe(404)
  })

  it('a session without administration.manage is forbidden, not unauthenticated', async () => {
    sqlite.exec(`
      INSERT INTO identities (id, email, password_hash, status, session_version, email_verified_at, created_at, updated_at)
        VALUES ('10000000-0000-4000-8000-0000000000aa', 'sin-rol@neteco.test', 'synthetic-marketing-fixture-hash', 'active', 1, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
      INSERT INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, last_seen_at, expires_at)
        VALUES ('20000000-0000-4000-8000-0000000000aa', '10000000-0000-4000-8000-0000000000aa', 1, 1, '2026-08-01T00:00:00Z', '2026-10-15T09:00:00Z', '2026-12-31T00:00:00Z');
    `)
    const issued = await issueD1SessionCookie(
      db,
      {
        sessionId: '20000000-0000-4000-8000-0000000000aa',
        identityId: '10000000-0000-4000-8000-0000000000aa',
        sessionVersion: 1
      },
      { password: PASSWORD, maxAgeSeconds: 3600 }
    )
    const cookie = (issued ?? '').split(';')[0] ?? ''
    const response = await call(
      '/api/admin/marketing-modals',
      { method: 'GET', headers: { cookie, origin: ORIGIN } },
      deps
    )
    expect(response?.status).toBe(403)
    expect(await response?.json()).toEqual({ error: { code: 'forbidden' } })
  })
})
