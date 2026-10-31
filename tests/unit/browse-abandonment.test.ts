import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { openMigratedDatabase, d1OverSqlite } from '../support/d1-sqlite'
import { deterministicUuid } from '../fixtures/deterministic'
import {
  readD1BrowsePolicy,
  updateD1BrowsePolicy,
  readD1BrowsePreferences,
  updateD1BrowsePreferences,
  recordD1BrowseEvent,
  evaluateD1BrowseAbandonment,
  attributeD1BrowseConversion,
  getD1BrowseIncrementalityMetrics,
  BrowseAbandonmentError
} from '../../workers/marketing/browse-abandonment'
import {
  handleBrowseAbandonmentHttp,
  ownsBrowseAbandonmentNamespace
} from '../../workers/marketing/browse-abandonment-http'

const NOW = '2026-10-29T12:00:00Z'
const PAST = '2026-10-28T12:00:00Z'
const FUTURE = '2026-11-05T12:00:00Z'

const ADMIN_ID = deterministicUuid('browse-admin')
const CUSTOMER_1 = deterministicUuid('browse-cust-1')
const CUSTOMER_2 = deterministicUuid('browse-cust-2')
const CUSTOMER_SENSITIVE = deterministicUuid('browse-cust-sens')

const PROD_CLEANER = 'prod-cleaner-standard'
const PROD_SENSITIVE = 'prod-biocide-medical'
const CAT_CLEANING = 'cat-cleaning-general'
const CAT_BIOCIDE = 'cat-medical-biocides'

let sqlite: DatabaseSync
let db: D1Database

beforeEach(async () => {
  sqlite = await openMigratedDatabase()
  sqlite.exec('PRAGMA foreign_keys = OFF')
  db = d1OverSqlite(sqlite)

  const migration0142 = await readFile(
    'db/d1/migrations/0142_browse_recovery_welcome_coupon_recommendations.sql',
    'utf8'
  )
  sqlite.exec(migration0142)

  // Seed Admin identity & permissions
  sqlite
    .prepare(
      `INSERT INTO identities(id, email, password_hash, email_verified_at, status, created_at, updated_at)
       VALUES(?, 'admin@neteco.es', 'synthetic', ?, 'active', ?, ?)`
    )
    .run(ADMIN_ID, PAST, PAST, PAST)
  sqlite.exec(`
    INSERT OR IGNORE INTO roles(code, name, description) VALUES('admin', 'Admin', 'Synthetic');
    INSERT OR IGNORE INTO permissions(code, resource, action, description) VALUES('administration.manage', 'administration', 'manage', 'Synthetic');
    INSERT OR IGNORE INTO role_permissions(role_code, permission_code) VALUES('admin', 'administration.manage');
  `)
  sqlite
    .prepare(`INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES(?, 'admin', ?)`)
    .run(ADMIN_ID, PAST)
  sqlite
    .prepare(
      `INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at)
       VALUES('sess-admin', ?, 1, 1, ?, ?)`
    )
    .run(ADMIN_ID, PAST, FUTURE)

  // Seed Customers
  sqlite
    .prepare(
      `INSERT INTO customers(id, name, phone, status, created_at, updated_at) VALUES(?, 'Empresa 1', '+34600111222', 'active', ?, ?)`
    )
    .run(CUSTOMER_1, PAST, PAST)
  sqlite
    .prepare(
      `INSERT INTO identities(id, email, customer_id, password_hash, email_verified_at, status, created_at, updated_at)
       VALUES('ident-cust-1', 'cliente1@empresa.es', ?, 'synthetic', ?, 'active', ?, ?)`
    )
    .run(CUSTOMER_1, PAST, PAST, PAST)

  sqlite
    .prepare(
      `INSERT INTO customers(id, name, phone, status, created_at, updated_at) VALUES(?, 'Empresa 2', '+34600333444', 'active', ?, ?)`
    )
    .run(CUSTOMER_2, PAST, PAST)
  sqlite
    .prepare(
      `INSERT INTO identities(id, email, customer_id, password_hash, email_verified_at, status, created_at, updated_at)
       VALUES('ident-cust-2', 'cliente2@empresa.es', ?, 'synthetic', NULL, 'active', ?, ?)` // Unverified email
    )
    .run(CUSTOMER_2, PAST, PAST)

  sqlite
    .prepare(
      `INSERT INTO customers(id, name, phone, status, created_at, updated_at) VALUES(?, 'Empresa Sensible', '+34600555666', 'active', ?, ?)`
    )
    .run(CUSTOMER_SENSITIVE, PAST, PAST)
  sqlite
    .prepare(
      `INSERT INTO identities(id, email, customer_id, password_hash, email_verified_at, status, created_at, updated_at)
       VALUES('ident-cust-sens', 'sensible@clinica.es', ?, 'synthetic', ?, 'active', ?, ?)`
    )
    .run(CUSTOMER_SENSITIVE, PAST, PAST, PAST)

  // Seed Categories & Products
  sqlite
    .prepare(
      `INSERT INTO categories(id, name, slug, status, created_at, updated_at)
       VALUES(?, 'Limpieza General', 'limpieza-general', 'published', ?, ?)`
    )
    .run(CAT_CLEANING, PAST, PAST)
  sqlite
    .prepare(
      `INSERT INTO categories(id, name, slug, status, created_at, updated_at)
       VALUES(?, 'Desinfectantes Médicos', 'desinfectantes-medicos', 'published', ?, ?)`
    )
    .run(CAT_BIOCIDE, PAST, PAST)

  sqlite
    .prepare(
      `INSERT INTO products(id, category_id, name, slug, status, created_at, updated_at)
       VALUES(?, ?, 'Detergente Industrial Neutro', 'detergente-neutro', 'published', ?, ?)`
    )
    .run(PROD_CLEANER, CAT_CLEANING, PAST, PAST)
  sqlite
    .prepare(
      `INSERT INTO products(id, category_id, name, slug, status, created_at, updated_at)
       VALUES(?, ?, 'Biocida Hospitalario Quirúrgico', 'biocida-hospitalario', 'published', ?, ?)`
    )
    .run(PROD_SENSITIVE, CAT_BIOCIDE, PAST, PAST)
})

afterEach(() => {
  if (sqlite?.isOpen) sqlite.close()
})

describe('MKT-014: Browse and product abandonment automation', () => {
  it('reads default policy and updates it with CAS and version increment', async () => {
    const policy = await readD1BrowsePolicy(db)
    expect(policy.id).toBe('global')
    expect(policy.version).toBe(1)
    expect(policy.enabled).toBe(true)
    expect(policy.holdoutPercent).toBe(20)

    const updated = await updateD1BrowsePolicy(
      db,
      ADMIN_ID,
      {
        expectedVersion: 1,
        enabled: true,
        abandonmentWindowMinutes: 90,
        cooldownHours: 48,
        holdoutPercent: 25,
        attributionWindowDays: 14
      },
      NOW
    )

    expect(updated.version).toBe(2)
    expect(updated.abandonmentWindowMinutes).toBe(90)
    expect(updated.holdoutPercent).toBe(25)

    // Version conflict
    await expect(
      updateD1BrowsePolicy(
        db,
        ADMIN_ID,
        {
          expectedVersion: 1, // Wrong version
          enabled: true,
          abandonmentWindowMinutes: 90,
          cooldownHours: 48,
          holdoutPercent: 25,
          attributionWindowDays: 14
        },
        NOW
      )
    ).rejects.toThrow(BrowseAbandonmentError)
  })

  it('manages customer browse preferences with consent opt-in and opt-out', async () => {
    const initial = await readD1BrowsePreferences(db, CUSTOMER_1)
    expect(initial.browseRecoveryOptIn).toBe(false)
    expect(initial.version).toBe(1)

    const optedIn = await updateD1BrowsePreferences(
      db,
      CUSTOMER_1,
      {
        expectedVersion: 1,
        browseRecoveryOptIn: true
      },
      NOW
    )
    expect(optedIn.browseRecoveryOptIn).toBe(true)
    expect(optedIn.version).toBe(2)

    const readBack = await readD1BrowsePreferences(db, CUSTOMER_1)
    expect(readBack.browseRecoveryOptIn).toBe(true)
  })

  it('records browse events from storefront', async () => {
    const event = await recordD1BrowseEvent(
      db,
      CUSTOMER_1,
      {
        productId: PROD_CLEANER,
        categoryId: CAT_CLEANING,
        viewDurationSeconds: 45
      },
      NOW
    )

    expect(event.id).toBeDefined()
    expect(event.customerId).toBe(CUSTOMER_1)
    expect(event.productId).toBe(PROD_CLEANER)
  })

  it('evaluates eligible customer and assigns treatment vs control holdout for incrementality', async () => {
    // Opt-in customer 1
    await updateD1BrowsePreferences(
      db,
      CUSTOMER_1,
      {
        expectedVersion: 1,
        browseRecoveryOptIn: true
      },
      PAST
    )

    // Record browse event
    await recordD1BrowseEvent(
      db,
      CUSTOMER_1,
      {
        productId: PROD_CLEANER,
        categoryId: CAT_CLEANING,
        viewDurationSeconds: 60
      },
      PAST
    )

    // Evaluate browse abandonment
    const evaluation = await evaluateD1BrowseAbandonment(db, CUSTOMER_1, PROD_CLEANER, NOW)
    expect(evaluation.eligible).toBe(true)
    expect(['treatment', 'control']).toContain(evaluation.groupType)
    if (evaluation.groupType === 'treatment') {
      expect(evaluation.status).toBe('delivered')
    } else {
      expect(evaluation.status).toBe('control_holdout')
    }
  })

  it('suppresses abandonment when identity email is unverified', async () => {
    // Customer 2 has unverified email
    await updateD1BrowsePreferences(
      db,
      CUSTOMER_2,
      {
        expectedVersion: 1,
        browseRecoveryOptIn: true
      },
      PAST
    )

    await recordD1BrowseEvent(
      db,
      CUSTOMER_2,
      {
        productId: PROD_CLEANER,
        categoryId: CAT_CLEANING,
        viewDurationSeconds: 60
      },
      PAST
    )

    const evaluation = await evaluateD1BrowseAbandonment(db, CUSTOMER_2, PROD_CLEANER, NOW)
    expect(evaluation.eligible).toBe(false)
    expect(evaluation.status).toBe('suppressed_inactive')
  })

  it('suppresses abandonment when customer has opted out of browse recovery', async () => {
    // Customer 1 opts out
    await updateD1BrowsePreferences(
      db,
      CUSTOMER_1,
      {
        expectedVersion: 1,
        browseRecoveryOptIn: false
      },
      PAST
    )

    const evaluation = await evaluateD1BrowseAbandonment(db, CUSTOMER_1, PROD_CLEANER, NOW)
    expect(evaluation.eligible).toBe(false)
    expect(evaluation.status).toBe('suppressed_opt_out')
  })

  it('strictly protects privacy and suppresses sensitive products/categories', async () => {
    // Customer opts in
    await updateD1BrowsePreferences(
      db,
      CUSTOMER_SENSITIVE,
      {
        expectedVersion: 1,
        browseRecoveryOptIn: true
      },
      PAST
    )

    // Views sensitive product (biocide / medical)
    await recordD1BrowseEvent(
      db,
      CUSTOMER_SENSITIVE,
      {
        productId: PROD_SENSITIVE,
        categoryId: CAT_BIOCIDE,
        viewDurationSeconds: 120
      },
      PAST
    )

    const evaluation = await evaluateD1BrowseAbandonment(db, CUSTOMER_SENSITIVE, PROD_SENSITIVE, NOW)
    expect(evaluation.eligible).toBe(false)
    expect(evaluation.status).toBe('suppressed_sensitive')
  })

  it('measures incrementality and attributes orders to treatment and control', async () => {
    // Enable 50% holdout for testing
    await updateD1BrowsePolicy(
      db,
      ADMIN_ID,
      {
        expectedVersion: 1,
        enabled: true,
        abandonmentWindowMinutes: 60,
        cooldownHours: 24,
        holdoutPercent: 50,
        attributionWindowDays: 7
      },
      PAST
    )

    await updateD1BrowsePreferences(
      db,
      CUSTOMER_1,
      {
        expectedVersion: 1,
        browseRecoveryOptIn: true
      },
      PAST
    )

    // Evaluate
    const _dispatch = await evaluateD1BrowseAbandonment(db, CUSTOMER_1, PROD_CLEANER, PAST)

    // Fake order placed within attribution window
    const orderId = deterministicUuid('test-order-1')
    sqlite
      .prepare(
        `INSERT INTO orders(id, cart_id, quote_id, shipping_quote_id, attempt_id, token_hash,
                            reservation_id, reservation_expires_at, total_net_cents, total_tax_cents,
                            total_gross_cents, shipping_net_cents, shipping_tax_cents, shipping_gross_cents,
                            shipping_method_code, shipping_rate_version, shipping_eta_min_days,
                            shipping_eta_max_days, contact_email, contact_email_hash, consent_tos,
                            consent_privacy, correlation_id, customer_id, created_at, updated_at)
         VALUES(?, 'cart-1', 'quote-1', 'ship-1', 'att-1', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
                'res-1', ?, 8000, 1680, 9680, 0, 0, 0, 'pickup', 1, 1, 2, 'c1@test.invalid',
                '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1, 1, 'corr-1', ?, ?, ?)`
      )
      .run(orderId, FUTURE, CUSTOMER_1, NOW, NOW)

    // Attribute conversion
    const attributed = await attributeD1BrowseConversion(db, orderId, CUSTOMER_1, 9680, NOW)
    expect(attributed).toBe(true)

    // Metrics computation
    const metrics = await getD1BrowseIncrementalityMetrics(db, NOW)
    expect(metrics.source).toBe('cloudflare')
    expect(metrics.treatment).toBeDefined()
    expect(metrics.control).toBeDefined()
    expect(metrics.lift).toBeDefined()
  })

  it('suppresses abandonment when cooldown is active', async () => {
    await updateD1BrowsePreferences(
      db,
      CUSTOMER_1,
      {
        expectedVersion: 1,
        browseRecoveryOptIn: true
      },
      PAST
    )

    // First dispatch succeeds
    const firstEval = await evaluateD1BrowseAbandonment(db, CUSTOMER_1, PROD_CLEANER, PAST)
    expect(firstEval.eligible).toBe(true)

    // Second evaluation within cooldown period (48h) is suppressed
    const soonAfter = '2026-10-28T16:00:00Z'
    const secondEval = await evaluateD1BrowseAbandonment(db, CUSTOMER_1, PROD_CLEANER, soonAfter)
    expect(secondEval.eligible).toBe(false)
    expect(secondEval.status).toBe('suppressed_cooldown')
  })

  it('suppresses abandonment when policy is disabled', async () => {
    await updateD1BrowsePolicy(
      db,
      ADMIN_ID,
      {
        expectedVersion: 1,
        enabled: false,
        abandonmentWindowMinutes: 60,
        cooldownHours: 24,
        holdoutPercent: 20,
        attributionWindowDays: 7
      },
      PAST
    )

    await updateD1BrowsePreferences(
      db,
      CUSTOMER_1,
      {
        expectedVersion: 1,
        browseRecoveryOptIn: true
      },
      PAST
    )

    const evaluation = await evaluateD1BrowseAbandonment(db, CUSTOMER_1, PROD_CLEANER, NOW)
    expect(evaluation.eligible).toBe(false)
    expect(evaluation.status).toBe('suppressed_inactive')
  })

  it('HTTP API handles endpoints, auth, and namespace routing', async () => {
    expect(ownsBrowseAbandonmentNamespace('/api/account/browse-preferences')).toBe(true)
    expect(ownsBrowseAbandonmentNamespace('/api/admin/browse-recovery/policy')).toBe(true)
    expect(ownsBrowseAbandonmentNamespace('/api/admin/browse-recovery/metrics')).toBe(true)
    expect(ownsBrowseAbandonmentNamespace('/api/marketing/browse-abandonment/events')).toBe(true)
    expect(ownsBrowseAbandonmentNamespace('/api/other')).toBe(false)

    // Unauthenticated admin request fails
    const req = new Request('https://test.invalid/api/admin/browse-recovery/policy', {
      method: 'GET'
    })
    const res = await handleBrowseAbandonmentHttp(req, {
      database: db,
      sessionCookieConfiguration: { secretKey: 'x'.repeat(32), cookieName: 'sess' }
    })
    expect(res).toBeDefined()
    expect(res?.status).toBe(401)

    // Event submission endpoint
    const eventReq = new Request('https://test.invalid/api/marketing/browse-abandonment/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        customerId: CUSTOMER_1,
        productId: PROD_CLEANER,
        categoryId: CAT_CLEANING,
        viewDurationSeconds: 45
      })
    })
    const eventRes = await handleBrowseAbandonmentHttp(eventReq, {
      database: db,
      sessionCookieConfiguration: { secretKey: 'x'.repeat(32), cookieName: 'sess' }
    })
    expect(eventRes?.status).toBe(201)
  })
})
