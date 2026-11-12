import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  type AdminMarketingModalInput,
  adminMarketingModalIntentHash,
  adminMarketingModalPolicyIntentHash,
  DEFAULT_GLOBAL_MODAL_COOLDOWN_SECONDS,
  isMarketingModalProhibitedRoute,
  isSafeInternalModalCtaPath,
  type MarketingModalDefinition,
  marketingModalDefinitionHash,
  marketingModalDefinitionSchema,
  matchesModalRoutePrefix,
  sanitizeMarketingModalText,
  selectMarketingModalVariant
} from '../../shared/marketing-modals'
import {
  MarketingModalError,
  evaluateD1MarketingModalEligibility,
  executeD1AdminMarketingModal,
  listD1AdminMarketingModals,
  readD1AdminMarketingModal,
  readD1AdminMarketingModalCommand,
  readD1MarketingModalPolicy,
  recordD1MarketingModalInteraction,
  updateD1MarketingModalPolicy
} from '../../workers/marketing/marketing-modals'
import { testUuid } from '../support/deterministic'

const NOW = '2026-10-15T10:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000094'
const ADMIN_SESSION = '20000000-0000-4000-8000-000000000094'
const ADMIN_CLAIMS = { identityId: ADMIN_ID, sessionId: ADMIN_SESSION, sessionVersion: 1 }

const CATALOG_ID = '10000000-0000-4000-8000-000000000095'
const CATALOG_SESSION = '20000000-0000-4000-8000-000000000095'
const CATALOG_CLAIMS = { identityId: CATALOG_ID, sessionId: CATALOG_SESSION, sessionVersion: 1 }

const NO_MFA_ID = '10000000-0000-4000-8000-000000000096'
const NO_MFA_SESSION = '20000000-0000-4000-8000-000000000096'
const NO_MFA_CLAIMS = { identityId: NO_MFA_ID, sessionId: NO_MFA_SESSION, sessionVersion: 1 }

const CUSTOMER_IDENTITY_ID = '10000000-0000-4000-8000-000000000097'
const CUSTOMER_SESSION = '20000000-0000-4000-8000-000000000097'
const CUSTOMER_ID = '30000000-0000-4000-8000-000000000097'
const CUSTOMER_CLAIMS = { identityId: CUSTOMER_IDENTITY_ID, sessionId: CUSTOMER_SESSION, sessionVersion: 1 }

const PRO_IDENTITY_ID = '10000000-0000-4000-8000-000000000098'
const PRO_SESSION = '20000000-0000-4000-8000-000000000098'
const PRO_CUSTOMER_ID = '30000000-0000-4000-8000-000000000098'
const PRO_COMPANY_ID = '40000000-0000-4000-8000-000000000098'
const PRO_CLAIMS = { identityId: PRO_IDENTITY_ID, sessionId: PRO_SESSION, sessionVersion: 1 }

const MODAL_1 = '50000000-0000-4000-8000-000000000001'
const MODAL_2 = '50000000-0000-4000-8000-000000000002'
const MODAL_3 = '50000000-0000-4000-8000-000000000003'
const CMD_1 = '60000000-0000-4000-8000-000000000001'
const CMD_2 = '60000000-0000-4000-8000-000000000002'
const CMD_3 = '60000000-0000-4000-8000-000000000003'
const EVENT_1 = '70000000-0000-4000-8000-000000000001'
const EVENT_2 = '70000000-0000-4000-8000-000000000002'
const EVENT_3 = '70000000-0000-4000-8000-000000000003'
const VISITOR_TOKEN = '80000000-0000-4000-8000-000000000001'
const PEPPER = 'test-marketing-modal-pepper-32-bytes-minimum-key!'

/** Opens the migrated database with the marketing migration and the shared identity fixtures. */
async function openMarketingDatabase(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  sqlite.exec(await readFile(new URL('../../db/d1/migrations/0094_marketing_modals.sql', import.meta.url), 'utf8'))

  sqlite
    .prepare(
      `INSERT INTO customers (id, name, status, created_at, updated_at)
         VALUES (?, 'Cliente Particular', 'active', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
                (?, 'Hostelería Levante SL', 'active', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`
    )
    .run(CUSTOMER_ID, PRO_CUSTOMER_ID)

  sqlite
    .prepare(
      `INSERT INTO companies (id, customer_id, legal_name, tax_id, country_code, status, created_at, updated_at)
         VALUES (?, ?, 'Hostelería Levante SL', 'B12345678', 'ES', 'approved', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`
    )
    .run(PRO_COMPANY_ID, PRO_CUSTOMER_ID)

  sqlite.exec(`
      INSERT OR IGNORE INTO roles (code, name, description) VALUES
        ('admin', 'Administración', 'Fixture de marketing'),
        ('catalog_editor', 'Editor de catálogo', 'Fixture de marketing');
      INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
        ('administration.manage', 'administration', 'manage', 'Fixture de marketing'),
        ('catalog.write', 'catalog', 'write', 'Fixture de marketing');
      INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
        ('admin', 'administration.manage'),
        ('catalog_editor', 'catalog.write');
    `)

  for (const [id, session, email, role, mfa, customerId] of [
    [ADMIN_ID, ADMIN_SESSION, 'admin@neteco.test', 'admin', 1, null],
    [CATALOG_ID, CATALOG_SESSION, 'editor@neteco.test', 'catalog_editor', 1, null],
    [NO_MFA_ID, NO_MFA_SESSION, 'nomfa@neteco.test', 'admin', 0, null],
    [CUSTOMER_IDENTITY_ID, CUSTOMER_SESSION, 'cliente@neteco.test', null, 0, CUSTOMER_ID],
    [PRO_IDENTITY_ID, PRO_SESSION, 'compras@hostelerialevante.test', null, 0, PRO_CUSTOMER_ID]
  ] as const) {
    sqlite
      .prepare(
        `INSERT INTO identities (id, email, password_hash, status, session_version, email_verified_at, customer_id, created_at, updated_at)
           VALUES (?, ?, 'synthetic-marketing-fixture-hash', 'active', 1, '2026-08-01T00:00:00Z', ?, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`
      )
      .run(id, email, customerId)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, last_seen_at, expires_at)
           VALUES (?, ?, 1, ?, '2026-08-01T00:00:00Z', '2026-10-15T09:00:00Z', '2026-12-31T00:00:00Z')`
      )
      .run(session, id, mfa)
    if (role) {
      sqlite
        .prepare(
          `INSERT INTO identity_roles (identity_id, role_code, granted_by, granted_at)
             VALUES (?, ?, ?, '2026-08-01T00:00:00Z')`
        )
        .run(id, role, ADMIN_ID)
    }
  }
  return sqlite
}

function sampleDefinition(overrides: Partial<MarketingModalDefinition> = {}): MarketingModalDefinition {
  return {
    id: MODAL_1,
    version: 1,
    code: 'captacion-newsletter-higiene',
    status: 'published',
    title: 'Guía técnica de higiene industrial',
    body: 'Recibe fichas técnicas y protocolos de desinfección profesional en tu correo.',
    ctaLabel: 'Suscribirme al boletín',
    ctaPath: '/cuenta/newsletter',
    objective: 'newsletter_subscription',
    abVariant: null,
    trigger: { kind: 'time_on_page', minSeconds: 10 },
    audience: {
      segments: ['anonymous', 'customer', 'professional'],
      marketingConsent: 'any'
    },
    targeting: {
      includePrefixes: ['/catalogo', '/categoria', '/producto'],
      excludePrefixes: ['/producto/especial-restringido']
    },
    priority: 100,
    priorityTier: 'normal',
    frequency: {
      maxImpressionsPerVisitor: 2,
      windowSeconds: 86400
    },
    startsAt: '2026-10-01T00:00:00Z',
    endsAt: '2026-12-31T23:59:59Z',
    ...overrides
  }
}

describe('D1 marketing modals engine and anti-annoyance rules (MKT-009 + MKT-010)', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await openMarketingDatabase()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('sanitizes modal text and validates internal CTA paths and prohibited routes', () => {
    expect(sanitizeMarketingModalText('  <b>Oferta</b> en <script>alert(1)</script>químicos   industriales ')).toBe(
      'Oferta en químicos industriales'
    )
    expect(isSafeInternalModalCtaPath('/catalogo')).toBe(true)
    expect(isSafeInternalModalCtaPath('/recursos/guia-desinfeccion')).toBe(true)
    expect(isSafeInternalModalCtaPath('https://evil.example/phish')).toBe(false)
    expect(isSafeInternalModalCtaPath('//evil.example/phish')).toBe(false)
    expect(isSafeInternalModalCtaPath('/admin/modales')).toBe(false)
    expect(isSafeInternalModalCtaPath('/checkout')).toBe(false)

    for (const prohibited of [
      '/carrito',
      '/carrito/compartir',
      '/carrito-compartido',
      '/checkout',
      '/checkout/confirmacion',
      '/pago',
      '/pago/retorno',
      '/pagos',
      '/cuenta/seguridad',
      '/privacidad',
      '/cookies',
      '/terminos',
      '/condiciones',
      '/aviso-legal',
      '/accesibilidad',
      '/devoluciones',
      '/formas-de-pago',
      '/envios',
      '/contenido/aviso-legal',
      '/contenido/privacidad',
      '/admin/modales',
      '/api/marketing/modals/eligibility',
      '/login',
      '/registro',
      '/%63heckout'
    ]) {
      expect(isMarketingModalProhibitedRoute(prohibited)).toBe(true)
    }

    for (const allowed of [
      '/',
      '/catalogo',
      '/categoria/productos-quimicos',
      '/producto/desengrasante-concentrado',
      '/buscar',
      '/recursos',
      '/recursos/higiene-cocinas',
      '/ayuda',
      '/contacto',
      '/cuenta',
      '/cuenta/pedidos'
    ]) {
      expect(isMarketingModalProhibitedRoute(allowed)).toBe(false)
    }
  })

  it('creates, updates, publishes and retires versioned modals with CAS, idempotency and append-only audit', async () => {
    const createInput: AdminMarketingModalInput = {
      expectedVersion: 0,
      definition: sampleDefinition({
        status: 'draft',
        body: '  <p>Protocolos <strong>profesionales</strong> de limpieza e higiene.</p> '
      }),
      reason: 'Creación inicial en borrador para revisión editorial'
    }

    const created = await executeD1AdminMarketingModal(db, ADMIN_CLAIMS, createInput, {
      now: NOW,
      idempotencyKey: CMD_1
    })
    expect(created.version).toBe(1)
    expect(created.status).toBe('draft')
    expect(created.item.definition.body).toBe('Protocolos profesionales de limpieza e higiene.')

    // Exact replay returns the same receipt without advancing version
    const replayed = await executeD1AdminMarketingModal(db, ADMIN_CLAIMS, createInput, {
      now: NOW,
      idempotencyKey: CMD_1
    })
    expect(replayed).toEqual(created)

    // Reusing the same idempotency key with different payload fails with 409 idempotency_conflict
    await expect(
      executeD1AdminMarketingModal(
        db,
        ADMIN_CLAIMS,
        { ...createInput, reason: 'Otra razón distinta para forzar conflicto' },
        { now: NOW, idempotencyKey: CMD_1 }
      )
    ).rejects.toMatchObject<Partial<MarketingModalError>>({ code: 'idempotency_conflict' })

    // Command receipt lookup
    const commandHash = await adminMarketingModalIntentHash(createInput)
    const receiptLookup = await readD1AdminMarketingModalCommand(db, ADMIN_CLAIMS, CMD_1, commandHash, { now: NOW })
    expect(receiptLookup.outcome).toBe('applied')
    expect(receiptLookup.receipt.commandId).toBe(CMD_1)

    // CAS conflict when expectedVersion is stale
    await expect(
      executeD1AdminMarketingModal(
        db,
        ADMIN_CLAIMS,
        {
          expectedVersion: 0,
          definition: sampleDefinition({ version: 1, status: 'published' }),
          reason: 'Intento con versión esperada obsoleta'
        },
        { now: NOW, idempotencyKey: CMD_2 }
      )
    ).rejects.toMatchObject<Partial<MarketingModalError>>({ code: 'version_conflict' })

    // Publish version 2
    const published = await executeD1AdminMarketingModal(
      db,
      ADMIN_CLAIMS,
      {
        expectedVersion: 1,
        definition: sampleDefinition({ version: 2, status: 'published' }),
        reason: 'Publicación aprobada por marketing'
      },
      { now: '2026-10-15T10:05:00Z', idempotencyKey: CMD_2 }
    )
    expect(published.version).toBe(2)
    expect(published.status).toBe('published')

    // Retire version 3
    const retired = await executeD1AdminMarketingModal(
      db,
      ADMIN_CLAIMS,
      {
        expectedVersion: 2,
        definition: sampleDefinition({ version: 3, status: 'retired' }),
        reason: 'Retirada definitiva al cierre de campaña'
      },
      { now: '2026-10-15T10:10:00Z', idempotencyKey: CMD_3 }
    )
    expect(retired.version).toBe(3)
    expect(retired.status).toBe('retired')

    // Retired modal cannot be modified again
    await expect(
      executeD1AdminMarketingModal(
        db,
        ADMIN_CLAIMS,
        {
          expectedVersion: 3,
          definition: sampleDefinition({ version: 4, status: 'published' }),
          reason: 'Intento de reactivar modal retirado'
        },
        { now: '2026-10-15T10:15:00Z', idempotencyKey: testUuid() }
      )
    ).rejects.toMatchObject<Partial<MarketingModalError>>({ code: 'modal_retired' })

    // Detail includes full append-only history (3 versions)
    const detail = await readD1AdminMarketingModal(db, ADMIN_CLAIMS, MODAL_1, { historyPage: 1 }, { now: NOW })
    expect(detail.item.definition.version).toBe(3)
    expect(detail.historyTotal).toBe(3)
    expect(detail.history.map((h) => h.definition.version)).toEqual([3, 2, 1])

    // Verify SQLite append-only triggers reject direct UPDATE/DELETE
    expect(() => sqlite.prepare('DELETE FROM marketing_modal_versions WHERE modal_id = ?').run(MODAL_1)).toThrow()
    expect(() => sqlite.prepare('DELETE FROM marketing_modal_commands WHERE command_id = ?').run(CMD_1)).toThrow()
    expect(() => sqlite.prepare('DELETE FROM marketing_modal_audit WHERE command_id = ?').run(CMD_1)).toThrow()
  })

  it('enforces live administration.manage permission, verified email and MFA on all admin operations', async () => {
    const input: AdminMarketingModalInput = {
      expectedVersion: 0,
      definition: sampleDefinition(),
      reason: 'Intento de alta para prueba de permisos'
    }

    await expect(
      executeD1AdminMarketingModal(db, CATALOG_CLAIMS, input, { now: NOW, idempotencyKey: CMD_1 })
    ).rejects.toMatchObject<Partial<MarketingModalError>>({ code: 'forbidden' })

    await expect(
      executeD1AdminMarketingModal(db, NO_MFA_CLAIMS, input, { now: NOW, idempotencyKey: CMD_1 })
    ).rejects.toMatchObject<Partial<MarketingModalError>>({ code: 'mfa_required' })

    await expect(
      listD1AdminMarketingModals(db, CATALOG_CLAIMS, { q: '', status: 'all', page: 1, perPage: 25 }, { now: NOW })
    ).rejects.toMatchObject<Partial<MarketingModalError>>({ code: 'forbidden' })
  })

  it('manages global anti-annoyance cooldown policy with CAS and idempotency', async () => {
    const initial = await readD1MarketingModalPolicy(db, { now: NOW })
    expect(initial.version).toBe(0)
    expect(initial.globalCooldownSeconds).toBe(DEFAULT_GLOBAL_MODAL_COOLDOWN_SECONDS)

    const policyInput = {
      expectedVersion: 0,
      globalCooldownSeconds: 7200,
      reason: 'Ampliación de cooldown global a dos horas'
    }
    const updated = await updateD1MarketingModalPolicy(db, ADMIN_CLAIMS, policyInput, {
      now: NOW,
      idempotencyKey: CMD_1
    })
    expect(updated.policy.version).toBe(1)
    expect(updated.policy.globalCooldownSeconds).toBe(7200)

    const replay = await updateD1MarketingModalPolicy(db, ADMIN_CLAIMS, policyInput, {
      now: NOW,
      idempotencyKey: CMD_1
    })
    expect(replay).toEqual(updated)

    const hash = await adminMarketingModalPolicyIntentHash(policyInput)
    const commandRead = await readD1AdminMarketingModalCommand(db, ADMIN_CLAIMS, CMD_1, hash, { now: NOW })
    expect(commandRead.outcome).toBe('applied')
  })

  it('enforces anti-annoyance rules: prohibited routes, 5s initial load guard, simultaneous and session caps', async () => {
    await executeD1AdminMarketingModal(
      db,
      ADMIN_CLAIMS,
      {
        expectedVersion: 0,
        definition: sampleDefinition({ trigger: { kind: 'time_on_page', minSeconds: 5 } }),
        reason: 'Publicación de modal con trigger a los 5 segundos'
      },
      { now: NOW, idempotencyKey: CMD_1 }
    )

    // 1. Prohibited routes (cart, checkout, payment, account security, legal pages)
    for (const path of ['/carrito', '/checkout', '/pago/retorno', '/cuenta/seguridad', '/privacidad', '/cookies']) {
      const res = await evaluateD1MarketingModalEligibility(
        db,
        { path, viewport: 'desktop', timeOnPageSeconds: 20 },
        { now: NOW }
      )
      expect(res.eligible).toBe(false)
      expect(res.reason).toBe('prohibited_route')
      expect(res.modal).toBeNull()
    }

    // 2. First 5s & initial load guard (outside: 0s, 4.9s, isInitialLoad=true; border: 5s; inside: 10s)
    const onLoad = await evaluateD1MarketingModalEligibility(
      db,
      { path: '/catalogo', viewport: 'desktop', timeOnPageSeconds: 10, isInitialLoad: true },
      { now: NOW }
    )
    expect(onLoad.eligible).toBe(false)
    expect(onLoad.reason).toBe('initial_load_guard')

    const before5s = await evaluateD1MarketingModalEligibility(
      db,
      { path: '/catalogo', viewport: 'desktop', timeOnPageSeconds: 4.9 },
      { now: NOW }
    )
    expect(before5s.eligible).toBe(false)
    expect(before5s.reason).toBe('initial_load_guard')

    const exact5s = await evaluateD1MarketingModalEligibility(
      db,
      { path: '/catalogo', viewport: 'desktop', timeOnPageSeconds: 5 },
      { now: NOW }
    )
    expect(exact5s.eligible).toBe(true)
    expect(exact5s.modal?.id).toBe(MODAL_1)

    // 3. Simultaneous modal guard & max 1 per pageview
    const activeOpen = await evaluateD1MarketingModalEligibility(
      db,
      { path: '/catalogo', viewport: 'desktop', timeOnPageSeconds: 10, activeModalOpen: true },
      { now: NOW }
    )
    expect(activeOpen.eligible).toBe(false)
    expect(activeOpen.reason).toBe('active_modal_open')

    const pageViewCap = await evaluateD1MarketingModalEligibility(
      db,
      { path: '/catalogo', viewport: 'desktop', timeOnPageSeconds: 10, pageViewModalsShown: 1 },
      { now: NOW }
    )
    expect(pageViewCap.eligible).toBe(false)
    expect(pageViewCap.reason).toBe('page_view_limit_reached')

    // 4. Max 1 per session unless critical priority
    const sessionCapNormal = await evaluateD1MarketingModalEligibility(
      db,
      { path: '/catalogo', viewport: 'desktop', timeOnPageSeconds: 10, sessionModalsShown: 1 },
      { now: NOW }
    )
    expect(sessionCapNormal.eligible).toBe(false)
    expect(sessionCapNormal.reason).toBe('session_limit_reached')

    // Create a critical priority modal and verify it bypasses sessionModalsShown=1 (while still respecting pageViewModalsShown=0)
    await executeD1AdminMarketingModal(
      db,
      ADMIN_CLAIMS,
      {
        expectedVersion: 0,
        definition: sampleDefinition({
          id: MODAL_2,
          code: 'aviso-critico-operativo',
          priority: 950,
          priorityTier: 'critical',
          trigger: { kind: 'time_on_page', minSeconds: 5 }
        }),
        reason: 'Modal crítico operativo para pruebas de sesión'
      },
      { now: NOW, idempotencyKey: CMD_2 }
    )

    const sessionCritical = await evaluateD1MarketingModalEligibility(
      db,
      { path: '/catalogo', viewport: 'desktop', timeOnPageSeconds: 10, sessionModalsShown: 1, pageViewModalsShown: 0 },
      { now: NOW }
    )
    expect(sessionCritical.eligible).toBe(true)
    expect(sessionCritical.modal?.id).toBe(MODAL_2)
    expect(sessionCritical.modal?.priorityTier).toBe('critical')
  })

  it('evaluates all trigger types (time_on_page, scroll_depth, exit_intent desktop-only, page_views) and mobile presentation', async () => {
    // Scroll depth trigger (minPercent: 60)
    await executeD1AdminMarketingModal(
      db,
      ADMIN_CLAIMS,
      {
        expectedVersion: 0,
        definition: sampleDefinition({
          id: MODAL_1,
          code: 'modal-scroll-60',
          trigger: { kind: 'scroll_depth', minPercent: 60 }
        }),
        reason: 'Modal por porcentaje de scroll'
      },
      { now: NOW, idempotencyKey: CMD_1 }
    )

    const scrollBelow = await evaluateD1MarketingModalEligibility(
      db,
      { path: '/catalogo', viewport: 'mobile', timeOnPageSeconds: 10, scrollPercent: 59, prefersReducedMotion: true },
      { now: NOW }
    )
    expect(scrollBelow.eligible).toBe(false)
    expect(scrollBelow.reason).toBe('trigger_not_met')

    const scrollBorder = await evaluateD1MarketingModalEligibility(
      db,
      { path: '/catalogo', viewport: 'mobile', timeOnPageSeconds: 10, scrollPercent: 60, prefersReducedMotion: true },
      { now: NOW }
    )
    expect(scrollBorder.eligible).toBe(true)
    expect(scrollBorder.modal?.presentation).toEqual({
      layout: 'bottom_sheet',
      maxViewportHeightPercent: 50,
      reducedMotion: true,
      closePersistent: true
    })

    // Exit intent trigger: forbidden on mobile, allowed on desktop when exitIntent=true
    await executeD1AdminMarketingModal(
      db,
      ADMIN_CLAIMS,
      {
        expectedVersion: 1,
        definition: sampleDefinition({
          id: MODAL_1,
          version: 2,
          code: 'modal-scroll-60',
          trigger: { kind: 'exit_intent', minSeconds: 8 }
        }),
        reason: 'Cambio a trigger de intención de salida'
      },
      { now: NOW, idempotencyKey: CMD_2 }
    )

    const exitMobile = await evaluateD1MarketingModalEligibility(
      db,
      { path: '/catalogo', viewport: 'mobile', timeOnPageSeconds: 15, exitIntent: true },
      { now: NOW }
    )
    expect(exitMobile.eligible).toBe(false)
    expect(exitMobile.reason).toBe('exit_intent_mobile_forbidden')

    const exitDesktopFalse = await evaluateD1MarketingModalEligibility(
      db,
      { path: '/catalogo', viewport: 'desktop', timeOnPageSeconds: 15, exitIntent: false },
      { now: NOW }
    )
    expect(exitDesktopFalse.eligible).toBe(false)
    expect(exitDesktopFalse.reason).toBe('trigger_not_met')

    const exitDesktopTrue = await evaluateD1MarketingModalEligibility(
      db,
      { path: '/catalogo', viewport: 'desktop', timeOnPageSeconds: 8, exitIntent: true },
      { now: NOW }
    )
    expect(exitDesktopTrue.eligible).toBe(true)
    expect(exitDesktopTrue.modal?.presentation.layout).toBe('centered_dialog')

    // Page views trigger (minPageViews: 3)
    await executeD1AdminMarketingModal(
      db,
      ADMIN_CLAIMS,
      {
        expectedVersion: 2,
        definition: sampleDefinition({
          id: MODAL_1,
          version: 3,
          code: 'modal-scroll-60',
          trigger: { kind: 'page_views', minPageViews: 3 }
        }),
        reason: 'Cambio a trigger por páginas vistas'
      },
      { now: NOW, idempotencyKey: CMD_3 }
    )

    const viewsBelow = await evaluateD1MarketingModalEligibility(
      db,
      { path: '/catalogo', viewport: 'desktop', timeOnPageSeconds: 6, pageViewsInSession: 2 },
      { now: NOW }
    )
    expect(viewsBelow.eligible).toBe(false)

    const viewsBorder = await evaluateD1MarketingModalEligibility(
      db,
      { path: '/catalogo', viewport: 'desktop', timeOnPageSeconds: 6, pageViewsInSession: 3 },
      { now: NOW }
    )
    expect(viewsBorder.eligible).toBe(true)
  })

  it('resolves audience segments (anonymous, customer, professional), marketing consent, priority and A/B variants', async () => {
    // Modal 1: only professional audience with marketing consent, priority 200, with A/B variant
    await executeD1AdminMarketingModal(
      db,
      ADMIN_CLAIMS,
      {
        expectedVersion: 0,
        definition: sampleDefinition({
          id: MODAL_1,
          code: 'modal-pro-ab',
          priority: 200,
          audience: { segments: ['professional'], marketingConsent: 'with_consent' },
          abVariant: {
            title: 'Variante B para empresas',
            body: 'Solicita presupuesto por volumen para hostelería y colectividades.',
            ctaLabel: 'Pedir presupuesto B',
            ctaPath: '/cuenta/presupuestos',
            splitPercent: 50
          }
        }),
        reason: 'Modal exclusivo para clientes profesionales con variante B'
      },
      { now: NOW, idempotencyKey: CMD_1 }
    )

    // Modal 2: anonymous and customer audience without marketing consent, priority 100
    await executeD1AdminMarketingModal(
      db,
      ADMIN_CLAIMS,
      {
        expectedVersion: 0,
        definition: sampleDefinition({
          id: MODAL_2,
          code: 'modal-anon-sin-consentimiento',
          priority: 100,
          audience: { segments: ['anonymous', 'customer'], marketingConsent: 'without_consent' }
        }),
        reason: 'Modal para visitantes sin consentimiento comercial'
      },
      { now: NOW, idempotencyKey: CMD_2 }
    )

    // Anonymous visitor without marketing consent gets MODAL_2 (never sees MODAL_1)
    const anonResult = await evaluateD1MarketingModalEligibility(
      db,
      { path: '/catalogo', viewport: 'desktop', timeOnPageSeconds: 12, marketingConsent: false },
      { now: NOW, claims: null }
    )
    expect(anonResult.eligible).toBe(true)
    expect(anonResult.modal?.id).toBe(MODAL_2)

    // Authenticated customer (non-company) with marketing consent matches neither (MODAL_1 needs professional, MODAL_2 needs without_consent)
    const customerWithConsent = await evaluateD1MarketingModalEligibility(
      db,
      { path: '/catalogo', viewport: 'desktop', timeOnPageSeconds: 12, marketingConsent: true },
      { now: NOW, claims: CUSTOMER_CLAIMS }
    )
    expect(customerWithConsent.eligible).toBe(false)
    expect(customerWithConsent.reason).toBe('consent_mismatch')

    // Authenticated professional (approved company) with marketing consent gets MODAL_1 and deterministic A/B variants
    const variantsSeen = new Set<string>()
    for (let i = 0; i < 12; i++) {
      const proResult = await evaluateD1MarketingModalEligibility(
        db,
        {
          path: '/catalogo',
          viewport: 'desktop',
          timeOnPageSeconds: 12,
          marketingConsent: true,
          variantSeed: `seed-${i}`
        },
        { now: NOW, claims: PRO_CLAIMS }
      )
      expect(proResult.eligible).toBe(true)
      expect(proResult.modal?.id).toBe(MODAL_1)
      variantsSeen.add(proResult.modal!.variant)
    }
    expect(variantsSeen.has('A')).toBe(true)
    expect(variantsSeen.has('B')).toBe(true)
  })

  it('enforces frequency caps, global cooldown, permanent dismissal/conversion exclusions and analytical consent privacy', async () => {
    await executeD1AdminMarketingModal(
      db,
      ADMIN_CLAIMS,
      {
        expectedVersion: 0,
        definition: sampleDefinition({
          id: MODAL_1,
          code: 'modal-frecuencia-2',
          frequency: { maxImpressionsPerVisitor: 2, windowSeconds: 3600 }
        }),
        reason: 'Modal con máximo 2 impresiones por hora'
      },
      { now: NOW, idempotencyKey: CMD_1 }
    )

    // 1. Without analytical consent: server records 0 rows in D1 and returns browser_only
    const unconsentedRecord = await recordD1MarketingModalInteraction(
      db,
      {
        eventId: EVENT_1,
        modalId: MODAL_1,
        modalVersion: 1,
        variant: 'A',
        eventType: 'impression',
        objective: 'newsletter_subscription',
        analyticsConsent: false
      },
      { now: NOW, visitorToken: VISITOR_TOKEN, hmacPepper: PEPPER }
    )
    expect(unconsentedRecord.recorded).toBe(false)
    expect(unconsentedRecord.persisted).toBe('browser_only')
    const countWithoutConsent = sqlite.prepare('SELECT count(*) AS n FROM marketing_modal_interactions').get() as {
      n: number
    }
    expect(countWithoutConsent.n).toBe(0)

    // Browser-stored frequency cap still enforced by server eligibility evaluation when passed in context
    const browserCapped = await evaluateD1MarketingModalEligibility(
      db,
      {
        path: '/catalogo',
        viewport: 'desktop',
        timeOnPageSeconds: 15,
        analyticsConsent: false,
        impressionsByModal: {
          [MODAL_1]: ['2026-10-15T09:30:00Z', '2026-10-15T09:45:00Z']
        }
      },
      { now: NOW }
    )
    expect(browserCapped.eligible).toBe(false)
    expect(browserCapped.reason).toBe('frequency_cap_reached')

    // 2. With analytical consent: server persists hashed visitor interaction idempotently
    const imp1 = await recordD1MarketingModalInteraction(
      db,
      {
        eventId: EVENT_1,
        modalId: MODAL_1,
        modalVersion: 1,
        variant: 'A',
        eventType: 'impression',
        objective: 'newsletter_subscription',
        analyticsConsent: true
      },
      { now: '2026-10-15T09:20:00Z', visitorToken: VISITOR_TOKEN, hmacPepper: PEPPER }
    )
    expect(imp1.recorded).toBe(true)
    expect(imp1.persisted).toBe('server_d1')
    expect(imp1.replayed).toBe(false)

    // Exact replay does not duplicate
    const imp1Replay = await recordD1MarketingModalInteraction(
      db,
      {
        eventId: EVENT_1,
        modalId: MODAL_1,
        modalVersion: 1,
        variant: 'A',
        eventType: 'impression',
        objective: 'newsletter_subscription',
        analyticsConsent: true
      },
      { now: '2026-10-15T09:20:00Z', visitorToken: VISITOR_TOKEN, hmacPepper: PEPPER }
    )
    expect(imp1Replay.replayed).toBe(true)

    // Second impression reaches cap of 2 within 3600s window
    await recordD1MarketingModalInteraction(
      db,
      {
        eventId: EVENT_2,
        modalId: MODAL_1,
        modalVersion: 1,
        variant: 'A',
        eventType: 'impression',
        objective: 'newsletter_subscription',
        analyticsConsent: true
      },
      { now: '2026-10-15T09:40:00Z', visitorToken: VISITOR_TOKEN, hmacPepper: PEPPER }
    )

    const serverCapped = await evaluateD1MarketingModalEligibility(
      db,
      { path: '/catalogo', viewport: 'desktop', timeOnPageSeconds: 15, analyticsConsent: true },
      { now: NOW, visitorToken: VISITOR_TOKEN, hmacPepper: PEPPER }
    )
    expect(serverCapped.eligible).toBe(false)
    expect(serverCapped.reason).toBe('frequency_cap_reached')

    // After the 3600s window passes (at 10:40:01Z), frequency cap resets
    const afterWindow = await evaluateD1MarketingModalEligibility(
      db,
      { path: '/catalogo', viewport: 'desktop', timeOnPageSeconds: 15, analyticsConsent: true },
      { now: '2026-10-15T10:40:01Z', visitorToken: VISITOR_TOKEN, hmacPepper: PEPPER }
    )
    expect(afterWindow.eligible).toBe(true)

    // 3. Dismissal triggers global cooldown for all modals AND permanent exclusion for the dismissed modal
    await executeD1AdminMarketingModal(
      db,
      ADMIN_CLAIMS,
      {
        expectedVersion: 0,
        definition: sampleDefinition({
          id: MODAL_2,
          code: 'modal-secundario-catalogo',
          objective: 'catalog_discovery'
        }),
        reason: 'Segundo modal con objetivo distinto'
      },
      { now: NOW, idempotencyKey: CMD_2 }
    )

    await recordD1MarketingModalInteraction(
      db,
      {
        eventId: EVENT_3,
        modalId: MODAL_1,
        modalVersion: 1,
        variant: 'A',
        eventType: 'dismiss',
        objective: 'newsletter_subscription',
        analyticsConsent: true
      },
      { now: '2026-10-15T11:00:00Z', visitorToken: VISITOR_TOKEN, hmacPepper: PEPPER }
    )

    // 3599s after dismissal: global cooldown (3600s) is still active
    const duringCooldown = await evaluateD1MarketingModalEligibility(
      db,
      { path: '/catalogo', viewport: 'desktop', timeOnPageSeconds: 15, analyticsConsent: true },
      { now: '2026-10-15T11:59:59Z', visitorToken: VISITOR_TOKEN, hmacPepper: PEPPER }
    )
    expect(duringCooldown.eligible).toBe(false)
    expect(duringCooldown.reason).toBe('global_cooldown_active')

    // Exactly at 3600s (12:00:00Z): global cooldown expires; MODAL_1 stays permanently dismissed, so MODAL_2 wins!
    const afterCooldown = await evaluateD1MarketingModalEligibility(
      db,
      { path: '/catalogo', viewport: 'desktop', timeOnPageSeconds: 15, analyticsConsent: true },
      { now: '2026-10-15T12:00:00Z', visitorToken: VISITOR_TOKEN, hmacPepper: PEPPER }
    )
    expect(afterCooldown.eligible).toBe(true)
    expect(afterCooldown.modal?.id).toBe(MODAL_2)

    // 4. Conversion permanently excludes the modal and any modal sharing that objective
    await recordD1MarketingModalInteraction(
      db,
      {
        eventId: testUuid(),
        modalId: MODAL_2,
        modalVersion: 1,
        variant: 'A',
        eventType: 'convert',
        objective: 'catalog_discovery',
        analyticsConsent: true
      },
      { now: '2026-10-15T12:05:00Z', visitorToken: VISITOR_TOKEN, hmacPepper: PEPPER }
    )

    const afterConvert = await evaluateD1MarketingModalEligibility(
      db,
      { path: '/catalogo', viewport: 'desktop', timeOnPageSeconds: 15, analyticsConsent: true },
      { now: '2026-10-15T14:00:00Z', visitorToken: VISITOR_TOKEN, hmacPepper: PEPPER }
    )
    expect(afterConvert.eligible).toBe(false)
    expect(afterConvert.reason).toBe('converted_permanently')
  })

  it('Validates definition hash determinism', async () => {
    const def = sampleDefinition()
    const hash1 = await marketingModalDefinitionHash(def)
    const hash2 = await marketingModalDefinitionHash({ ...def })
    expect(hash1).toBe(hash2)
    expect(hash1).toMatch(/^[0-9a-f]{64}$/)
  })
})

const VISITOR_OTHER = '80000000-0000-4000-8000-000000000002'

describe('shared anti-annoyance primitives (MKT-010)', () => {
  it.each([
    '/carrito',
    '/carrito/',
    '/CARRITO',
    '/carrito?x=1',
    '/checkout',
    '/checkout/confirmacion',
    '/pago',
    '/pago/3ds',
    '/pagos',
    '/pago%2Fretorno',
    '/cuenta/seguridad',
    '/cuenta/seguridad/mfa',
    '/cookies',
    '/politica-de-cookies',
    '/aviso-legal',
    '/terminos',
    '/privacidad?x=1',
    '/admin',
    '/admin/modales',
    '/api/admin/marketing-modals',
    '/login',
    '/pedido/123',
    '/newsletter/baja',
    '/newsletter/confirmar?t=x',
    '//checkout',
    '/checkout/../catalogo',
    '/%63heckout',
    '/carrito%20x'
  ])('prohibits %s', (path) => {
    expect(isMarketingModalProhibitedRoute(path)).toBe(true)
  })

  it.each([
    '/',
    '/catalogo',
    '/catalogo?page=2',
    '/categoria/productos-quimicos',
    '/producto/desengrasante-concentrado',
    '/buscar?q=lejia',
    '/recursos/guia',
    '/ayuda',
    '/contacto',
    '/cuenta',
    '/cuenta/pedidos',
    '/cuenta/newsletter'
  ])('allows %s', (path) => {
    expect(isMarketingModalProhibitedRoute(path)).toBe(false)
  })

  it.each([
    ['/catalogo', '/catalogo', true],
    ['/catalogo/', '/catalogo', true],
    ['/catalogo/x/y', '/catalogo', true],
    ['/catalogo?page=2', '/catalogo', true],
    ['/catalogo-outlet', '/catalogo', false],
    ['/productos', '/producto', false],
    ['/producto/especial-restringido', '/producto', true],
    ['/cualquiera', '/', true],
    ['/', '/', true],
    ['/categoria', '/catalogo', false]
  ])('matches route %s against prefix %s -> %s', (path, prefix, expected) => {
    expect(matchesModalRoutePrefix(path, prefix)).toBe(expected)
  })

  it.each([
    ['/catalogo', true],
    ['/recursos/guia', true],
    ['/contacto', true],
    ['https://evil.example/phish', false],
    ['//evil.example', false],
    ['javascript:alert(1)', false],
    ['/a/../b', false],
    ['/a/./b', false],
    ['/a\\b', false],
    ['/admin/modales', false],
    ['/api/x', false],
    ['/carrito', false],
    ['/checkout/x', false],
    ['/pago/x', false],
    ['/login', false],
    ['', false],
    [' /catalogo', false]
  ])('CTA path %s is safe -> %s', (href, expected) => {
    expect(isSafeInternalModalCtaPath(href)).toBe(expected)
  })

  it.each([
    ['<script>alert(1)</script>Hola', 'Hola'],
    ['<style>p{}</style>Texto', 'Texto'],
    ['<!-- oculto -->Texto', 'Texto'],
    ['<img src=x onerror=alert(1)>Texto', 'Texto'],
    ['a<b', 'ab'],
    ['Café\u0007 y\u0085 té', 'Café y té'],
    ['Línea 1\r\nLínea 2', 'Línea 1\nLínea 2'],
    ['é', 'é']
  ])('sanitizes %j', (raw, expected) => {
    expect(sanitizeMarketingModalText(raw)).toBe(expected)
  })

  it('selects variants deterministically with split bounds and an even-enough distribution', () => {
    expect(selectMarketingModalVariant(MODAL_1, 0, 'x')).toBe('A')
    expect(selectMarketingModalVariant(MODAL_1, 100, 'x')).toBe('B')
    expect(selectMarketingModalVariant(MODAL_1, Number.NaN, 'x')).toBe('A')
    expect(selectMarketingModalVariant(MODAL_1, 50, 'seed-a')).toBe(selectMarketingModalVariant(MODAL_1, 50, 'seed-a'))
    let bees = 0
    for (let i = 0; i < 1000; i++) if (selectMarketingModalVariant(MODAL_1, 50, `s${i}`) === 'B') bees++
    expect(bees).toBeGreaterThan(400)
    expect(bees).toBeLessThan(600)
  })
})

function abVariant(splitPercent: number): MarketingModalDefinition['abVariant'] {
  return {
    title: 'Variante de prueba',
    body: 'Texto de variante suficiente para la prueba.',
    ctaLabel: 'Ver',
    ctaPath: '/catalogo',
    splitPercent
  }
}

describe('marketing modal definition validation boundaries (MKT-009)', () => {
  it.each<[string, Partial<MarketingModalDefinition>, boolean]>([
    ['endsAt equal to startsAt', { startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-10-01T00:00:00Z' }, false],
    ['endsAt before startsAt', { startsAt: '2026-10-02T00:00:00Z', endsAt: '2026-10-01T00:00:00Z' }, false],
    ['open-ended validity', { endsAt: null }, true],
    ['include prefix on checkout', { targeting: { includePrefixes: ['/checkout'], excludePrefixes: [] } }, false],
    ['include prefix on root', { targeting: { includePrefixes: ['/'], excludePrefixes: [] } }, true],
    ['exclude prefix traversal', { targeting: { includePrefixes: ['/catalogo'], excludePrefixes: ['/../x'] } }, false],
    [
      'duplicate include prefix',
      { targeting: { includePrefixes: ['/catalogo', '/catalogo'], excludePrefixes: [] } },
      false
    ],
    ['empty audience', { audience: { segments: [], marketingConsent: 'any' } }, false],
    ['duplicate segment', { audience: { segments: ['customer', 'customer'], marketingConsent: 'any' } }, false],
    ['time trigger 4 s', { trigger: { kind: 'time_on_page', minSeconds: 4 } }, false],
    ['time trigger 5 s', { trigger: { kind: 'time_on_page', minSeconds: 5 } }, true],
    ['time trigger 3600 s', { trigger: { kind: 'time_on_page', minSeconds: 3600 } }, true],
    ['time trigger 3601 s', { trigger: { kind: 'time_on_page', minSeconds: 3601 } }, false],
    ['scroll trigger 9 %', { trigger: { kind: 'scroll_depth', minPercent: 9 } }, false],
    ['scroll trigger 10 %', { trigger: { kind: 'scroll_depth', minPercent: 10 } }, true],
    ['scroll trigger 101 %', { trigger: { kind: 'scroll_depth', minPercent: 101 } }, false],
    ['page views 0', { trigger: { kind: 'page_views', minPageViews: 0 } }, false],
    ['page views 1', { trigger: { kind: 'page_views', minPageViews: 1 } }, true],
    ['frequency window 59 s', { frequency: { maxImpressionsPerVisitor: 2, windowSeconds: 59 } }, false],
    ['frequency window 60 s', { frequency: { maxImpressionsPerVisitor: 2, windowSeconds: 60 } }, true],
    ['frequency cap 0', { frequency: { maxImpressionsPerVisitor: 0, windowSeconds: 3600 } }, false],
    ['frequency cap 51', { frequency: { maxImpressionsPerVisitor: 51, windowSeconds: 3600 } }, false],
    ['priority 1001', { priority: 1001 }, false],
    ['priority 1000', { priority: 1000 }, true],
    ['title too short', { title: 'ab' }, false],
    ['CTA path protocol-relative', { ctaPath: '//evil.example' }, false],
    ['A/B split 0', { abVariant: abVariant(0) }, false],
    ['A/B split 50', { abVariant: abVariant(50) }, true],
    ['A/B split 100', { abVariant: abVariant(100) }, false]
  ])('definition boundary: %s', (_name, overrides, valid) => {
    const merged = { ...sampleDefinition({ abVariant: null }), ...overrides } as MarketingModalDefinition
    expect(marketingModalDefinitionSchema.safeParse(merged).success).toBe(valid)
  })

  it('stores sanitized body text instead of rejecting markup, so no free HTML reaches the page', () => {
    const parsed = marketingModalDefinitionSchema.parse(
      sampleDefinition({ body: 'Oferta <b>real</b> <img src=x onerror=alert(1)> para hostelería' })
    )
    expect(parsed.body).toBe('Oferta real para hostelería')
  })
})

describe('marketing modal engine: anti-annoyance matrix (MKT-010)', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await openMarketingDatabase()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  async function publish(definition: MarketingModalDefinition, now = NOW) {
    return executeD1AdminMarketingModal(
      db,
      ADMIN_CLAIMS,
      {
        expectedVersion: definition.version - 1,
        definition,
        reason: 'Publicación para prueba de reglas anti-molestia'
      },
      { now, idempotencyKey: testUuid() }
    )
  }

  function ask(input: Record<string, unknown>, options: Record<string, unknown> = {}) {
    return evaluateD1MarketingModalEligibility(
      db,
      { path: '/catalogo', viewport: 'desktop', timeOnPageSeconds: 10, ...input },
      { now: NOW, ...options }
    )
  }

  it.each([
    [0, 'initial_load_guard'],
    [4.99, 'initial_load_guard'],
    [5, 'eligible'],
    [5.01, 'eligible'],
    [60, 'eligible']
  ])('first-5-seconds guard at %s s -> %s', async (seconds, expected) => {
    await publish(sampleDefinition({ trigger: { kind: 'time_on_page', minSeconds: 5 } }))
    const result = await ask({ timeOnPageSeconds: seconds })
    expect(result.reason).toBe(expected)
    expect(result.eligible).toBe(expected === 'eligible')
  })

  it('never shows content on initial page load even after 60 seconds', async () => {
    await publish(sampleDefinition({ trigger: { kind: 'time_on_page', minSeconds: 5 } }))
    const result = await ask({ timeOnPageSeconds: 60, isInitialLoad: true })
    expect(result.reason).toBe('initial_load_guard')
  })

  it.each([
    ['/carrito', 'prohibited_route'],
    ['/checkout/confirmacion', 'prohibited_route'],
    ['/pago/retorno', 'prohibited_route'],
    ['/cuenta/seguridad', 'prohibited_route'],
    ['/privacidad', 'prohibited_route'],
    ['/admin/modales', 'prohibited_route'],
    ['/login', 'prohibited_route']
  ])('prohibited route %s wins even when the modal targets the whole site', async (path, expected) => {
    await publish(sampleDefinition({ targeting: { includePrefixes: ['/'], excludePrefixes: [] } }))
    const result = await ask({ path })
    expect(result.reason).toBe(expected)
    expect(result.modal).toBeNull()
  })

  it.each([
    ['/catalogo', true],
    ['/catalogo/x', true],
    ['/catalogo-outlet', false],
    ['/producto/especial-restringido', false],
    ['/producto/especial-restringido/detalle', false],
    ['/categoria/x', true],
    ['/blog', false]
  ])('route %s eligible=%s', async (path, eligible) => {
    await publish(sampleDefinition())
    const result = await ask({ path })
    expect(result.eligible).toBe(eligible)
    if (!eligible) expect(result.reason).toBe('no_matching_modal')
  })

  it.each([
    ['anonymous', null, false],
    ['customer', CUSTOMER_CLAIMS, false],
    ['professional', PRO_CLAIMS, true]
  ])('professional-only modal for %s visitor -> eligible=%s (silent mismatch)', async (_who, claims, eligible) => {
    await publish(sampleDefinition({ audience: { segments: ['professional'], marketingConsent: 'any' } }))
    const result = await ask({}, { claims })
    expect(result.eligible).toBe(eligible)
    if (!eligible) expect(result.reason).toBe('no_matching_modal')
  })

  it.each([
    ['with_consent', true, true],
    ['with_consent', false, false],
    ['without_consent', true, false],
    ['without_consent', false, true],
    ['any', true, true],
    ['any', false, true]
  ] as const)('marketing consent %s with flag %s -> eligible=%s', async (requirement, flag, eligible) => {
    await publish(sampleDefinition({ audience: { segments: ['anonymous'], marketingConsent: requirement } }))
    const result = await ask({ marketingConsent: flag }, { claims: null })
    expect(result.eligible).toBe(eligible)
  })

  it.each([
    [['2026-10-15T09:00:00Z', '2026-10-15T09:30:00Z'], 'frequency_cap_reached'],
    [['2026-10-15T08:59:59Z', '2026-10-15T09:30:00Z'], 'eligible'],
    [['2026-10-15T09:30:00Z'], 'eligible'],
    [['2026-10-15T09:30:00Z', '2026-10-15T09:31:00Z', '2026-10-15T09:32:00Z'], 'frequency_cap_reached']
  ])('browser impressions %j within a one-hour window -> %s', async (impressions, expected) => {
    await publish(sampleDefinition({ frequency: { maxImpressionsPerVisitor: 2, windowSeconds: 3600 } }))
    const result = await ask({ impressionsByModal: { [MODAL_1]: impressions } })
    expect(result.eligible ? 'eligible' : result.reason).toBe(expected)
  })

  it.each([
    ['2026-10-15T11:00:00Z', 3599, 'global_cooldown_active'],
    ['2026-10-15T11:00:00Z', 3600, 'eligible']
  ])('global cooldown after dismissal at %s: %s s later -> %s', async (lastDismissedAt, _elapsed, expected) => {
    await publish(sampleDefinition({ trigger: { kind: 'time_on_page', minSeconds: 5 } }))
    const now = new Date(Date.parse(lastDismissedAt) + _elapsed * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const result = await ask({ lastDismissedAt }, { now })
    expect(result.reason).toBe(expected)
  })

  it('applies a changed global cooldown policy to the next evaluation', async () => {
    await publish(sampleDefinition())
    await updateD1MarketingModalPolicy(
      db,
      ADMIN_CLAIMS,
      { expectedVersion: 0, globalCooldownSeconds: 7200, reason: 'Pausa global ampliada a dos horas' },
      { now: NOW, idempotencyKey: testUuid() }
    )
    const result = await ask({ lastDismissedAt: '2026-10-15T08:00:01Z' }, { now: '2026-10-15T10:00:00Z' })
    expect(result.reason).toBe('global_cooldown_active')
    expect(result.globalCooldownSeconds).toBe(7200)
  })

  it.each([
    [{ startsAt: '2026-10-16T00:00:00Z', endsAt: null }, 'outside_validity_window'],
    [{ startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-10-15T10:00:00Z' }, 'outside_validity_window'],
    [{ startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-10-15T10:00:01Z' }, 'eligible'],
    [{ startsAt: '2026-10-15T10:00:00Z', endsAt: null }, 'eligible']
  ])('validity window %j -> %s', async (window, expected) => {
    await publish(sampleDefinition(window))
    const result = await ask({})
    expect(result.reason).toBe(expected)
  })

  it('serves the highest tier first, then priority, then code, and never two modals in one session', async () => {
    await publish(sampleDefinition({ id: MODAL_1, code: 'normal-900', priority: 900, priorityTier: 'normal' }))
    await publish(sampleDefinition({ id: MODAL_2, code: 'alta-100', priority: 100, priorityTier: 'high' }))
    await publish(sampleDefinition({ id: MODAL_3, code: 'critica-1', priority: 1, priorityTier: 'critical' }))
    expect((await ask({})).modal?.id).toBe(MODAL_3)
    expect((await ask({ dismissedModalIds: [MODAL_3] })).modal?.id).toBe(MODAL_2)
    expect((await ask({ dismissedModalIds: [MODAL_3, MODAL_2] })).modal?.id).toBe(MODAL_1)
  })

  it('breaks priority ties by code ascending within the same tier', async () => {
    await publish(sampleDefinition({ id: MODAL_1, code: 'zeta-300', priority: 300 }))
    await publish(sampleDefinition({ id: MODAL_2, code: 'alfa-300', priority: 300 }))
    expect((await ask({})).modal?.id).toBe(MODAL_2)
  })

  it.each([
    ['normal', 'session_limit_reached'],
    ['high', 'session_limit_reached'],
    ['critical', 'eligible']
  ] as const)('one modal per session for %s tier -> %s', async (tier, expected) => {
    await publish(sampleDefinition({ priorityTier: tier }))
    const result = await ask({ sessionModalsShown: 1 })
    expect(result.eligible ? 'eligible' : result.reason).toBe(expected)
  })

  it('keeps one modal per page view even for critical modals', async () => {
    await publish(sampleDefinition({ priorityTier: 'critical', priority: 1000 }))
    const result = await ask({ pageViewModalsShown: 1 })
    expect(result.reason).toBe('page_view_limit_reached')
  })

  it.each([
    [59, 'trigger_not_met'],
    [60, 'eligible'],
    [100, 'eligible']
  ])('scroll trigger at %s %% -> %s', async (scrollPercent, expected) => {
    await publish(sampleDefinition({ trigger: { kind: 'scroll_depth', minPercent: 60 } }))
    const result = await ask({ scrollPercent, viewport: 'mobile' })
    expect(result.eligible ? 'eligible' : result.reason).toBe(expected)
  })

  it.each([
    [{ viewport: 'desktop', exitIntent: true, timeOnPageSeconds: 8 }, 'eligible'],
    [{ viewport: 'desktop', exitIntent: true, timeOnPageSeconds: 7.9 }, 'trigger_not_met'],
    [{ viewport: 'desktop', exitIntent: false, timeOnPageSeconds: 20 }, 'trigger_not_met'],
    [{ viewport: 'mobile', exitIntent: true, timeOnPageSeconds: 20 }, 'exit_intent_mobile_forbidden']
  ])('exit intent %j -> %s', async (input, expected) => {
    await publish(sampleDefinition({ trigger: { kind: 'exit_intent', minSeconds: 8 } }))
    const result = await ask(input)
    expect(result.eligible ? 'eligible' : result.reason).toBe(expected)
  })

  it.each([
    [2, 'trigger_not_met'],
    [3, 'eligible']
  ])('page views trigger with %s page views -> %s', async (pageViewsInSession, expected) => {
    await publish(sampleDefinition({ trigger: { kind: 'page_views', minPageViews: 3 } }))
    const result = await ask({ pageViewsInSession })
    expect(result.eligible ? 'eligible' : result.reason).toBe(expected)
  })

  it('a dismissal excludes only that modal; another modal remains eligible once the cooldown is clear', async () => {
    await publish(sampleDefinition({ id: MODAL_1, code: 'modal-uno', priority: 500 }))
    await publish(sampleDefinition({ id: MODAL_2, code: 'modal-dos', priority: 100 }))
    const result = await ask({ dismissedModalIds: [MODAL_1] })
    expect(result.modal?.id).toBe(MODAL_2)
  })

  it('converted objectives exclude every modal that shares the objective, not others', async () => {
    await publish(sampleDefinition({ id: MODAL_1, code: 'modal-lead', objective: 'professional_lead', priority: 500 }))
    await publish(
      sampleDefinition({ id: MODAL_2, code: 'modal-soporte', objective: 'support_guidance', priority: 100 })
    )
    const result = await ask({ convertedObjectives: ['professional_lead'] })
    expect(result.modal?.id).toBe(MODAL_2)
  })

  it('an already subscribed newsletter visitor is never shown the newsletter objective again', async () => {
    await publish(sampleDefinition())
    const result = await ask({ newsletterSubscribed: true })
    expect(result.reason).toBe('converted_permanently')
  })

  it('draft, retired and unpublished-head modals are never served', async () => {
    await publish(sampleDefinition({ status: 'draft' }))
    expect((await ask({})).reason).toBe('no_matching_modal')
    await publish(sampleDefinition({ version: 2, status: 'published' }), '2026-10-15T10:01:00Z')
    expect((await ask({})).eligible).toBe(true)
    await publish(sampleDefinition({ version: 3, status: 'retired' }), '2026-10-15T10:02:00Z')
    expect((await ask({})).reason).toBe('no_matching_modal')
  })

  it.each([
    [{ id: MODAL_1, code: 'otro-codigo' }, 'version_conflict'],
    [{ id: MODAL_2, code: 'captacion-newsletter-higiene' }, 'code_conflict']
  ])('create conflicts for %j -> %s', async (override, expected) => {
    await publish(sampleDefinition())
    await expect(
      executeD1AdminMarketingModal(
        db,
        ADMIN_CLAIMS,
        {
          expectedVersion: 0,
          definition: sampleDefinition({ id: override.id, version: 1, code: override.code }),
          reason: 'Creación con conflicto de identidad'
        },
        { now: NOW, idempotencyKey: testUuid() }
      )
    ).rejects.toMatchObject({ code: expected })
  })

  it('updating an unknown modal id is not_found, and changing its code is code_immutable', async () => {
    await expect(
      executeD1AdminMarketingModal(
        db,
        ADMIN_CLAIMS,
        {
          expectedVersion: 1,
          definition: sampleDefinition({ version: 2 }),
          reason: 'Actualización de modal inexistente'
        },
        { now: NOW, idempotencyKey: testUuid() }
      )
    ).rejects.toMatchObject({ code: 'not_found' })

    await publish(sampleDefinition())
    await expect(
      executeD1AdminMarketingModal(
        db,
        ADMIN_CLAIMS,
        {
          expectedVersion: 1,
          definition: sampleDefinition({ version: 2, code: 'codigo-cambiado' }),
          reason: 'Intento de cambiar el código'
        },
        { now: NOW, idempotencyKey: testUuid() }
      )
    ).rejects.toMatchObject({ code: 'code_immutable' })
  })

  it('stale expectedVersion never overwrites a newer head, and a mismatched version is invalid input', async () => {
    await publish(sampleDefinition())
    await publish(sampleDefinition({ version: 2 }), '2026-10-15T10:01:00Z')
    await expect(
      executeD1AdminMarketingModal(
        db,
        ADMIN_CLAIMS,
        {
          expectedVersion: 1,
          definition: sampleDefinition({ version: 2, title: 'Edición obsoleta del título' }),
          reason: 'Edición con versión obsoleta'
        },
        { now: NOW, idempotencyKey: testUuid() }
      )
    ).rejects.toMatchObject({ code: 'version_conflict' })
    await expect(
      executeD1AdminMarketingModal(
        db,
        ADMIN_CLAIMS,
        {
          expectedVersion: 2,
          definition: sampleDefinition({ version: 5 }),
          reason: 'Versión que no es expectedVersion más uno'
        },
        { now: NOW, idempotencyKey: testUuid() }
      )
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it.each([
    ['session not found', '20000000-0000-4000-8000-0000000000ff', ADMIN_ID],
    ['identity mismatch', ADMIN_SESSION, CATALOG_ID]
  ])('authorization rejects %s', async (_name, sessionId, identityId) => {
    await expect(
      listD1AdminMarketingModals(
        db,
        { identityId, sessionId, sessionVersion: 1 },
        { q: '', status: 'all', page: 1, perPage: 25 },
        { now: NOW }
      )
    ).rejects.toBeInstanceOf(MarketingModalError)
  })

  it('a revoked session or removed role loses administration on the next operation', async () => {
    sqlite.prepare(`UPDATE auth_sessions SET revoked_at = '2026-10-15T09:59:00Z' WHERE id = ?`).run(ADMIN_SESSION)
    await expect(
      listD1AdminMarketingModals(db, ADMIN_CLAIMS, { q: '', status: 'all', page: 1, perPage: 25 }, { now: NOW })
    ).rejects.toBeInstanceOf(MarketingModalError)
  })

  it.each([
    [0, 'invalid_input'],
    [59, 'invalid_input'],
    [60, 'ok'],
    [604800, 'ok'],
    [604801, 'invalid_input']
  ])('global cooldown %s seconds -> %s', async (seconds, expected) => {
    const attempt = updateD1MarketingModalPolicy(
      db,
      ADMIN_CLAIMS,
      { expectedVersion: 0, globalCooldownSeconds: seconds, reason: 'Ajuste de pausa global para prueba' },
      { now: NOW, idempotencyKey: testUuid() }
    )
    if (expected === 'ok') {
      await expect(attempt).resolves.toMatchObject({ policy: { globalCooldownSeconds: seconds } })
    } else {
      await expect(attempt).rejects.toMatchObject({ code: expected })
    }
  })

  it('policy CAS: stale expectedVersion is a version conflict and the same key with another payload is idempotency_conflict', async () => {
    await updateD1MarketingModalPolicy(
      db,
      ADMIN_CLAIMS,
      { expectedVersion: 0, globalCooldownSeconds: 1800, reason: 'Primera versión de la pausa global' },
      { now: NOW, idempotencyKey: CMD_1 }
    )
    await expect(
      updateD1MarketingModalPolicy(
        db,
        ADMIN_CLAIMS,
        { expectedVersion: 0, globalCooldownSeconds: 900, reason: 'Edición con versión obsoleta' },
        { now: NOW, idempotencyKey: CMD_2 }
      )
    ).rejects.toMatchObject({ code: 'version_conflict' })
    await expect(
      updateD1MarketingModalPolicy(
        db,
        ADMIN_CLAIMS,
        { expectedVersion: 1, globalCooldownSeconds: 900, reason: 'Otro contenido con la misma clave' },
        { now: NOW, idempotencyKey: CMD_1 }
      )
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it('an impression recorded for one visitor does not cap another visitor', async () => {
    await publish(sampleDefinition({ frequency: { maxImpressionsPerVisitor: 1, windowSeconds: 3600 } }))
    await recordD1MarketingModalInteraction(
      db,
      {
        eventId: EVENT_1,
        modalId: MODAL_1,
        modalVersion: 1,
        variant: 'A',
        eventType: 'impression',
        objective: 'newsletter_subscription',
        analyticsConsent: true
      },
      { now: NOW, visitorToken: VISITOR_TOKEN, hmacPepper: PEPPER }
    )
    const same = await ask({ analyticsConsent: true }, { now: NOW, visitorToken: VISITOR_TOKEN, hmacPepper: PEPPER })
    const other = await ask({ analyticsConsent: true }, { now: NOW, visitorToken: VISITOR_OTHER, hmacPepper: PEPPER })
    expect(same.reason).toBe('frequency_cap_reached')
    expect(other.eligible).toBe(true)
  })

  it('stores only a keyed hash of the visitor token and counts impressions in the admin statistics', async () => {
    await publish(sampleDefinition())
    await recordD1MarketingModalInteraction(
      db,
      {
        eventId: EVENT_1,
        modalId: MODAL_1,
        modalVersion: 1,
        variant: 'A',
        eventType: 'impression',
        objective: 'newsletter_subscription',
        analyticsConsent: true
      },
      { now: NOW, visitorToken: VISITOR_TOKEN, hmacPepper: PEPPER }
    )
    const stored = sqlite.prepare('SELECT visitor_hash FROM marketing_modal_interactions').get() as {
      visitor_hash: string
    }
    expect(stored.visitor_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(stored.visitor_hash).not.toContain(VISITOR_TOKEN)
    const detail = await readD1AdminMarketingModal(db, ADMIN_CLAIMS, MODAL_1, {}, { now: NOW })
    expect(detail.item.stats.impressions).toBe(1)
  })

  it.each([
    ['client timestamp', { occurredAt: '2026-10-15T09:00:00Z' }],
    ['unknown field', { visitorId: VISITOR_TOKEN }],
    ['invalid variant', { variant: 'C' }]
  ])('interaction rejects %s', async (_name, extra) => {
    await publish(sampleDefinition())
    await expect(
      recordD1MarketingModalInteraction(
        db,
        {
          eventId: EVENT_1,
          modalId: MODAL_1,
          modalVersion: 1,
          variant: 'A',
          eventType: 'impression',
          objective: 'newsletter_subscription',
          analyticsConsent: true,
          ...extra
        },
        { now: NOW, visitorToken: VISITOR_TOKEN, hmacPepper: PEPPER }
      )
    ).rejects.toBeInstanceOf(MarketingModalError)
  })

  it('a replayed event is idempotent, and the same event id with another type is idempotency_conflict', async () => {
    await publish(sampleDefinition())
    const first = {
      eventId: EVENT_1,
      modalId: MODAL_1,
      modalVersion: 1,
      variant: 'A',
      eventType: 'impression',
      objective: 'newsletter_subscription',
      analyticsConsent: true
    } as const
    await recordD1MarketingModalInteraction(db, first, { now: NOW, visitorToken: VISITOR_TOKEN, hmacPepper: PEPPER })
    const replay = await recordD1MarketingModalInteraction(db, first, {
      now: NOW,
      visitorToken: VISITOR_TOKEN,
      hmacPepper: PEPPER
    })
    expect(replay.replayed).toBe(true)
    expect((sqlite.prepare('SELECT count(*) AS n FROM marketing_modal_interactions').get() as { n: number }).n).toBe(1)
    await expect(
      recordD1MarketingModalInteraction(
        db,
        { ...first, eventType: 'dismiss' },
        { now: NOW, visitorToken: VISITOR_TOKEN, hmacPepper: PEPPER }
      )
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it('a server-side consent cookie that denies analytics overrides the client flag', async () => {
    await publish(sampleDefinition())
    const receipt = await recordD1MarketingModalInteraction(
      db,
      {
        eventId: EVENT_1,
        modalId: MODAL_1,
        modalVersion: 1,
        variant: 'A',
        eventType: 'impression',
        objective: 'newsletter_subscription',
        analyticsConsent: true
      },
      { now: NOW, visitorToken: VISITOR_TOKEN, hmacPepper: PEPPER, analyticsConsentCookie: false }
    )
    expect(receipt).toMatchObject({ recorded: false, persisted: 'browser_only' })
    expect((sqlite.prepare('SELECT count(*) AS n FROM marketing_modal_interactions').get() as { n: number }).n).toBe(0)
  })

  it('an unknown modal version cannot be recorded', async () => {
    await publish(sampleDefinition())
    await expect(
      recordD1MarketingModalInteraction(
        db,
        {
          eventId: EVENT_1,
          modalId: MODAL_1,
          modalVersion: 9,
          variant: 'A',
          eventType: 'impression',
          objective: 'newsletter_subscription',
          analyticsConsent: true
        },
        { now: NOW, visitorToken: VISITOR_TOKEN, hmacPepper: PEPPER }
      )
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it.each([
    ['UPDATE marketing_modals SET code = ? WHERE id = ?', 'changed-code', MODAL_1],
    ['DELETE FROM marketing_modals WHERE id = ?', MODAL_1],
    ['UPDATE marketing_modal_audit SET reason = ? WHERE command_id = ?', 'alterada', CMD_1],
    ['DELETE FROM marketing_modal_policies WHERE id = ?', 'default'],
    ['UPDATE marketing_modal_interactions SET event_type = ? WHERE event_id = ?', 'convert', EVENT_1]
  ])('append-only guard rejects %s', async (sql, ...params) => {
    await executeD1AdminMarketingModal(
      db,
      ADMIN_CLAIMS,
      { expectedVersion: 0, definition: sampleDefinition(), reason: 'Modal previa para comprobar inmutabilidad' },
      { now: NOW, idempotencyKey: CMD_1 }
    )
    await recordD1MarketingModalInteraction(
      db,
      {
        eventId: EVENT_1,
        modalId: MODAL_1,
        modalVersion: 1,
        variant: 'A',
        eventType: 'impression',
        objective: 'newsletter_subscription',
        analyticsConsent: true
      },
      { now: NOW, visitorToken: VISITOR_TOKEN, hmacPepper: PEPPER }
    )
    await updateD1MarketingModalPolicy(
      db,
      ADMIN_CLAIMS,
      { expectedVersion: 0, globalCooldownSeconds: 1800, reason: 'Política previa para comprobar inmutabilidad' },
      { now: NOW, idempotencyKey: CMD_3 }
    )
    expect(() => sqlite.prepare(sql).run(...(params as never[]))).toThrow()
  })
})
