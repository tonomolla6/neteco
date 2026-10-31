import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { openMigratedDatabase, d1OverSqlite } from '../support/d1-sqlite'
import { deterministicUuid } from '../fixtures/deterministic'
import {
  readD1WelcomeCouponPolicy,
  updateD1WelcomeCouponPolicy,
  issueD1WelcomeCoupon,
  evaluateD1WelcomeCoupon,
  redeemD1WelcomeCoupon,
  WelcomeCouponError
} from '../../workers/marketing/welcome-coupon'
import { handleWelcomeCouponHttp, ownsWelcomeCouponNamespace } from '../../workers/marketing/welcome-coupon-http'

const NOW = '2026-10-29T12:00:00Z'
const PAST = '2026-10-20T12:00:00Z'
const FUTURE = '2026-11-12T12:00:00Z'
const _EXPIRED = '2026-10-25T12:00:00Z'

const ADMIN_ID = deterministicUuid('wc-admin')
const CUSTOMER_NEW_1 = deterministicUuid('wc-cust-new-1')
const CUSTOMER_NEW_2 = deterministicUuid('wc-cust-new-2')
const CUSTOMER_EXISTING = deterministicUuid('wc-cust-existing')

const PROD_REGULAR = 'prod-detergente-suelos'
const PROD_EXCLUDED = 'prod-pallet-granel'
const CAT_STANDARD = 'cat-quimicos-suelo'
const CAT_EXCLUDED = 'cat-maquinaria-pesada'

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

  // Seed Admin
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

  // Seed Customers
  sqlite
    .prepare(
      `INSERT INTO customers(id, name, phone, status, created_at, updated_at) VALUES(?, 'Nuevo 1', '+34600111222', 'active', ?, ?)`
    )
    .run(CUSTOMER_NEW_1, PAST, PAST)
  sqlite
    .prepare(
      `INSERT INTO identities(id, email, customer_id, password_hash, email_verified_at, status, created_at, updated_at)
       VALUES('ident-new-1', 'juan.perez+promo@gmail.com', ?, 'synthetic', ?, 'active', ?, ?)`
    )
    .run(CUSTOMER_NEW_1, PAST, PAST, PAST)

  sqlite
    .prepare(
      `INSERT INTO customers(id, name, phone, status, created_at, updated_at) VALUES(?, 'Nuevo 2', '+34600333444', 'active', ?, ?)`
    )
    .run(CUSTOMER_NEW_2, PAST, PAST)
  sqlite
    .prepare(
      `INSERT INTO identities(id, email, customer_id, password_hash, email_verified_at, status, created_at, updated_at)
       VALUES('ident-new-2', 'juanperez@gmail.com', ?, 'synthetic', ?, 'active', ?, ?)`
    )
    .run(CUSTOMER_NEW_2, PAST, PAST, PAST)

  sqlite
    .prepare(
      `INSERT INTO customers(id, name, phone, status, created_at, updated_at) VALUES(?, 'Cliente Antiguo', '+34600999888', 'active', ?, ?)`
    )
    .run(CUSTOMER_EXISTING, PAST, PAST)
  sqlite
    .prepare(
      `INSERT INTO identities(id, email, customer_id, password_hash, email_verified_at, status, created_at, updated_at)
       VALUES('ident-existing', 'veterano@hosteleria.es', ?, 'synthetic', ?, 'active', ?, ?)`
    )
    .run(CUSTOMER_EXISTING, PAST, PAST, PAST)

  // Give existing customer a prior completed order
  sqlite
    .prepare(
      `INSERT INTO orders(id, cart_id, quote_id, shipping_quote_id, attempt_id, token_hash,
                          reservation_id, reservation_expires_at, total_net_cents, total_tax_cents,
                          total_gross_cents, shipping_net_cents, shipping_tax_cents, shipping_gross_cents,
                          shipping_method_code, shipping_rate_version, shipping_eta_min_days,
                          shipping_eta_max_days, contact_email, contact_email_hash, consent_tos,
                          consent_privacy, correlation_id, customer_id, created_at, updated_at)
       VALUES('ord-past-1', 'cart-past-1', 'quote-p-1', 'ship-p-1', 'att-p-1',
              '1111111111111111111111111111111111111111111111111111111111111111',
              'res-p-1', ?, 5000, 1050, 6050, 0, 0, 0, 'pickup', 1, 1, 2, 'veterano@hosteleria.es',
              '1111111111111111111111111111111111111111111111111111111111111111', 1, 1, 'corr-p-1', ?, ?, ?)`
    )
    .run(FUTURE, CUSTOMER_EXISTING, PAST, PAST)

  // Categories & Products
  sqlite
    .prepare(
      `INSERT INTO categories(id, name, slug, status, created_at, updated_at) VALUES(?, 'Limpieza Suelo', 'suelos', 'published', ?, ?)`
    )
    .run(CAT_STANDARD, PAST, PAST)
  sqlite
    .prepare(
      `INSERT INTO categories(id, name, slug, status, created_at, updated_at) VALUES(?, 'Maquinaria Pesada', 'maquinaria', 'published', ?, ?)`
    )
    .run(CAT_EXCLUDED, PAST, PAST)

  sqlite
    .prepare(
      `INSERT INTO products(id, category_id, name, slug, status, created_at, updated_at) VALUES(?, ?, 'Detergente Suelos 5L', 'det-suelos', 'published', ?, ?)`
    )
    .run(PROD_REGULAR, CAT_STANDARD, PAST, PAST)
  sqlite
    .prepare(
      `INSERT INTO products(id, category_id, name, slug, status, created_at, updated_at) VALUES(?, ?, 'Fregadora Industrial Pro', 'fregadora-pro', 'published', ?, ?)`
    )
    .run(PROD_EXCLUDED, CAT_EXCLUDED, PAST, PAST)
})

afterEach(() => {
  if (sqlite?.isOpen) sqlite.close()
})

describe('MKT-016: Administrable welcome coupon with anti-fraud and single-use rules', () => {
  it('reads policy and allows admin to configure rules with CAS', async () => {
    const policy = await readD1WelcomeCouponPolicy(db)
    expect(policy.codePrefix).toBe('BIENVENIDA')
    expect(policy.discountPercent).toBe(10)
    expect(policy.validityDays).toBe(14)

    const updated = await updateD1WelcomeCouponPolicy(
      db,
      ADMIN_ID,
      {
        expectedVersion: 1,
        status: 'active',
        codePrefix: 'HOLA15',
        discountPercent: 15,
        maxDiscountCents: 2000,
        minOrderCents: 6000,
        validityDays: 30,
        excludedCategoryIds: [CAT_EXCLUDED],
        excludedProductIds: [PROD_EXCLUDED],
        excludeAlreadyDiscounted: true,
        marginFloorBasisPoints: 2000
      },
      NOW
    )

    expect(updated.version).toBe(2)
    expect(updated.codePrefix).toBe('HOLA15')
    expect(updated.discountPercent).toBe(15)
  })

  it('issues welcome coupon grant to eligible new customer', async () => {
    const grant = await issueD1WelcomeCoupon(
      db,
      {
        customerId: CUSTOMER_NEW_1,
        identityId: 'ident-new-1',
        email: 'juan.perez+promo@gmail.com',
        phone: '+34 600 11 22 33',
        taxId: 'B-12345678'
      },
      NOW
    )

    expect(grant.couponCode).toMatch(/^BIENVENIDA-/)
    expect(grant.status).toBe('active')
    expect(grant.discountPercent).toBe(10)
    expect(grant.customerId).toBe(CUSTOMER_NEW_1)

    // Cannot issue second coupon to same customer
    await expect(
      issueD1WelcomeCoupon(
        db,
        {
          customerId: CUSTOMER_NEW_1,
          identityId: 'ident-new-1',
          email: 'juan.perez+promo@gmail.com'
        },
        NOW
      )
    ).rejects.toThrow(WelcomeCouponError)
  })

  it('rejects coupon issuance to existing customer with past orders', async () => {
    await expect(
      issueD1WelcomeCoupon(
        db,
        {
          customerId: CUSTOMER_EXISTING,
          identityId: 'ident-existing',
          email: 'veterano@hosteleria.es'
        },
        NOW
      )
    ).rejects.toMatchObject({ code: 'ineligible_existing_customer' })
  })

  it('evaluates line discounts, exclusions, and reference price correctly', async () => {
    // Configure policy with exclusions
    await updateD1WelcomeCouponPolicy(
      db,
      ADMIN_ID,
      {
        expectedVersion: 1,
        status: 'active',
        codePrefix: 'BIENVENIDA',
        discountPercent: 10,
        maxDiscountCents: 1500,
        minOrderCents: 5000,
        validityDays: 14,
        excludedCategoryIds: [CAT_EXCLUDED],
        excludedProductIds: [PROD_EXCLUDED],
        excludeAlreadyDiscounted: true,
        marginFloorBasisPoints: 2000
      },
      PAST
    )

    const grant = await issueD1WelcomeCoupon(
      db,
      {
        customerId: CUSTOMER_NEW_1,
        identityId: 'ident-new-1',
        email: 'juan.perez+promo@gmail.com'
      },
      PAST
    )

    // Evaluate with 1 eligible line (60.00€) and 1 excluded line (150.00€)
    const evaluation = await evaluateD1WelcomeCoupon(db, {
      couponCode: grant.couponCode,
      customerId: CUSTOMER_NEW_1,
      identityId: 'ident-new-1',
      email: 'juan.perez+promo@gmail.com',
      lines: [
        {
          lineIndex: 0,
          productId: PROD_REGULAR,
          categoryId: CAT_STANDARD,
          quantity: 2,
          unitGrossCents: 3000, // 60.00€ total
          referencePriceUnitGrossCents: 3000,
          hasVolumeDiscount: false
        },
        {
          lineIndex: 1,
          productId: PROD_EXCLUDED,
          categoryId: CAT_EXCLUDED,
          quantity: 1,
          unitGrossCents: 15000, // 150.00€ total (excluded!)
          referencePriceUnitGrossCents: 15000,
          hasVolumeDiscount: false
        }
      ],
      now: NOW
    })

    expect(evaluation.eligible).toBe(true)
    expect(evaluation.totalDiscountCents).toBe(600) // 10% of 6000 cents = 600 cents
    expect(evaluation.lineAllocations[0].eligible).toBe(true)
    expect(evaluation.lineAllocations[0].discountGrossCents).toBe(600)
    expect(evaluation.lineAllocations[1].eligible).toBe(false)
    expect(evaluation.lineAllocations[1].discountGrossCents).toBe(0)
  })

  it('rejects evaluation when order does not meet minimum order requirement', async () => {
    const grant = await issueD1WelcomeCoupon(
      db,
      {
        customerId: CUSTOMER_NEW_1,
        identityId: 'ident-new-1',
        email: 'juan.perez+promo@gmail.com'
      },
      PAST
    )

    const evaluation = await evaluateD1WelcomeCoupon(db, {
      couponCode: grant.couponCode,
      customerId: CUSTOMER_NEW_1,
      identityId: 'ident-new-1',
      email: 'juan.perez+promo@gmail.com',
      lines: [
        {
          lineIndex: 0,
          productId: PROD_REGULAR,
          categoryId: CAT_STANDARD,
          quantity: 1,
          unitGrossCents: 2000, // 20.00€ < 50.00€ minimum!
          referencePriceUnitGrossCents: 2000,
          hasVolumeDiscount: false
        }
      ],
      now: NOW
    })

    expect(evaluation.eligible).toBe(false)
    expect(evaluation.reason).toBe('min_order_unmet')
  })

  it('rejects redemption if coupon has expired (Caducidad)', async () => {
    const grant = await issueD1WelcomeCoupon(
      db,
      {
        customerId: CUSTOMER_NEW_1,
        identityId: 'ident-new-1',
        email: 'juan.perez+promo@gmail.com'
      },
      PAST
    )

    // Evaluate in future after 14 days
    const farFuture = '2026-12-01T12:00:00Z'
    const evaluation = await evaluateD1WelcomeCoupon(db, {
      couponCode: grant.couponCode,
      customerId: CUSTOMER_NEW_1,
      identityId: 'ident-new-1',
      email: 'juan.perez+promo@gmail.com',
      lines: [
        {
          lineIndex: 0,
          productId: PROD_REGULAR,
          categoryId: CAT_STANDARD,
          quantity: 2,
          unitGrossCents: 3000,
          referencePriceUnitGrossCents: 3000,
          hasVolumeDiscount: false
        }
      ],
      now: farFuture
    })

    expect(evaluation.eligible).toBe(false)
    expect(evaluation.reason).toBe('coupon_expired')
  })

  it('enforces single use per customer (No descuento perpetuo)', async () => {
    const grant = await issueD1WelcomeCoupon(
      db,
      {
        customerId: CUSTOMER_NEW_1,
        identityId: 'ident-new-1',
        email: 'juan.perez+promo@gmail.com'
      },
      PAST
    )

    const orderId = deterministicUuid('test-order-wc-1')
    sqlite
      .prepare(
        `INSERT INTO orders(id, cart_id, quote_id, shipping_quote_id, attempt_id, token_hash,
                            reservation_id, reservation_expires_at, total_net_cents, total_tax_cents,
                            total_gross_cents, shipping_net_cents, shipping_tax_cents, shipping_gross_cents,
                            shipping_method_code, shipping_rate_version, shipping_eta_min_days,
                            shipping_eta_max_days, contact_email, contact_email_hash, consent_tos,
                            consent_privacy, correlation_id, customer_id, created_at, updated_at)
         VALUES(?, 'cart-wc-1', 'quote-wc-1', 'ship-wc-1', 'att-wc-1',
                '2222222222222222222222222222222222222222222222222222222222222222',
                'res-wc-1', ?, 5000, 1050, 6050, 0, 0, 0, 'pickup', 1, 1, 2, 'juan.perez@gmail.com',
                '2222222222222222222222222222222222222222222222222222222222222222', 1, 1, 'corr-wc-1', ?, ?, ?)`
      )
      .run(orderId, FUTURE, CUSTOMER_NEW_1, NOW, NOW)

    // First redemption succeeds
    const redemption = await redeemD1WelcomeCoupon(
      db,
      {
        grantId: grant.id,
        couponCode: grant.couponCode,
        customerId: CUSTOMER_NEW_1,
        orderId,
        identityId: 'ident-new-1',
        email: 'juan.perez+promo@gmail.com',
        discountAppliedCents: 600,
        grossOrderCents: 6050,
        referencePriceGrossCents: 6050
      },
      NOW
    )

    expect(redemption.id).toBeDefined()
    expect(redemption.discountAppliedCents).toBe(600)

    // Second redemption attempt on same coupon throws already_redeemed
    const orderId2 = deterministicUuid('test-order-wc-2')
    await expect(
      redeemD1WelcomeCoupon(
        db,
        {
          grantId: grant.id,
          couponCode: grant.couponCode,
          customerId: CUSTOMER_NEW_1,
          orderId: orderId2,
          identityId: 'ident-new-1',
          email: 'juan.perez+promo@gmail.com',
          discountAppliedCents: 600,
          grossOrderCents: 6050,
          referencePriceGrossCents: 6050
        },
        NOW
      )
    ).rejects.toThrow(WelcomeCouponError)
  })

  it('catches anti-fraud abuse across alias emails (juanperez@gmail.com vs juan.perez+promo@gmail.com)', async () => {
    // Customer 1 redeemed with juan.perez+promo@gmail.com
    const grant1 = await issueD1WelcomeCoupon(
      db,
      {
        customerId: CUSTOMER_NEW_1,
        identityId: 'ident-new-1',
        email: 'juan.perez+promo@gmail.com'
      },
      PAST
    )

    const orderId = deterministicUuid('order-af-1')
    sqlite
      .prepare(
        `INSERT INTO orders(id, cart_id, quote_id, shipping_quote_id, attempt_id, token_hash,
                            reservation_id, reservation_expires_at, total_net_cents, total_tax_cents,
                            total_gross_cents, shipping_net_cents, shipping_tax_cents, shipping_gross_cents,
                            shipping_method_code, shipping_rate_version, shipping_eta_min_days,
                            shipping_eta_max_days, contact_email, contact_email_hash, consent_tos,
                            consent_privacy, correlation_id, customer_id, created_at, updated_at)
         VALUES(?, 'cart-af-1', 'quote-af-1', 'ship-af-1', 'att-af-1',
                '3333333333333333333333333333333333333333333333333333333333333333',
                'res-af-1', ?, 5000, 1050, 6050, 0, 0, 0, 'pickup', 1, 1, 2, 'c@test.invalid',
                '3333333333333333333333333333333333333333333333333333333333333333', 1, 1, 'corr-af-1', ?, ?, ?)`
      )
      .run(orderId, FUTURE, CUSTOMER_NEW_1, NOW, NOW)

    await redeemD1WelcomeCoupon(
      db,
      {
        grantId: grant1.id,
        couponCode: grant1.couponCode,
        customerId: CUSTOMER_NEW_1,
        orderId,
        identityId: 'ident-new-1',
        email: 'juan.perez+promo@gmail.com',
        discountAppliedCents: 600,
        grossOrderCents: 6050,
        referencePriceGrossCents: 6050
      },
      NOW
    )

    // Customer 2 tries to issue/redeem coupon with alias juanperez@gmail.com
    await expect(
      issueD1WelcomeCoupon(
        db,
        {
          customerId: CUSTOMER_NEW_2,
          identityId: 'ident-new-2',
          email: 'juanperez@gmail.com'
        },
        NOW
      )
    ).rejects.toMatchObject({ code: 'anti_fraud_duplicate_email' })
  })

  it('catches anti-fraud abuse across duplicate phone and taxId', async () => {
    await issueD1WelcomeCoupon(
      db,
      {
        customerId: CUSTOMER_NEW_1,
        identityId: 'ident-new-1',
        email: 'persona1@gmail.com',
        phone: '+34 611 22 33 44',
        taxId: 'A-99887766'
      },
      PAST
    )

    // Customer 2 tries to issue coupon using same phone
    await expect(
      issueD1WelcomeCoupon(
        db,
        {
          customerId: CUSTOMER_NEW_2,
          identityId: 'ident-new-2',
          email: 'persona2@gmail.com',
          phone: '611223344' // Same phone formatted without prefix
        },
        NOW
      )
    ).rejects.toMatchObject({ code: 'anti_fraud_duplicate_phone' })

    // Customer 2 tries using same taxId
    await expect(
      issueD1WelcomeCoupon(
        db,
        {
          customerId: CUSTOMER_NEW_2,
          identityId: 'ident-new-2',
          email: 'persona3@gmail.com',
          taxId: 'A99887766' // Same tax ID formatted without hyphen
        },
        NOW
      )
    ).rejects.toMatchObject({ code: 'anti_fraud_duplicate_tax_id' })
  })

  it('caps discount to maxDiscountCents when discount exceeds maximum limit', async () => {
    // Policy maxDiscountCents is 1500 (15.00€)
    const grant = await issueD1WelcomeCoupon(
      db,
      {
        customerId: CUSTOMER_NEW_1,
        identityId: 'ident-new-1',
        email: 'persona_cap@gmail.com'
      },
      PAST
    )

    // Order of 300.00€ (30000 cents) -> 10% would be 3000 cents (30.00€)
    const evaluation = await evaluateD1WelcomeCoupon(db, {
      couponCode: grant.couponCode,
      customerId: CUSTOMER_NEW_1,
      identityId: 'ident-new-1',
      email: 'persona_cap@gmail.com',
      lines: [
        {
          lineIndex: 0,
          productId: PROD_REGULAR,
          categoryId: CAT_STANDARD,
          quantity: 10,
          unitGrossCents: 3000,
          referencePriceUnitGrossCents: 3000,
          hasVolumeDiscount: false
        }
      ],
      now: NOW
    })

    expect(evaluation.eligible).toBe(true)
    expect(evaluation.totalDiscountCents).toBe(1500) // Capped at maxDiscountCents!
  })

  it('HTTP API routes and validates requests correctly', async () => {
    expect(ownsWelcomeCouponNamespace('/api/marketing/welcome-coupon/evaluate')).toBe(true)
    expect(ownsWelcomeCouponNamespace('/api/marketing/welcome-coupon/issue')).toBe(true)
    expect(ownsWelcomeCouponNamespace('/api/marketing/welcome-coupon/redeem')).toBe(true)
    expect(ownsWelcomeCouponNamespace('/api/admin/welcome-coupon/policy')).toBe(true)
    expect(ownsWelcomeCouponNamespace('/api/other')).toBe(false)

    const req = new Request('https://test.invalid/api/admin/welcome-coupon/policy', { method: 'GET' })
    const res = await handleWelcomeCouponHttp(req, {
      database: db,
      sessionCookieConfiguration: { secretKey: 'y'.repeat(32), cookieName: 'sess' }
    })
    expect(res?.status).toBe(401)
  })
})
