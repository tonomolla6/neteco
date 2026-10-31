import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openMigratedDatabase } from '../support/d1-sqlite'
import {
  setupIsolationFixture,
  type IsolationWorld,
  queryAccountProfileConcurrent,
  queryAccountOrdersConcurrent,
  resolvePricingConcurrent,
  verifyCommercialConditionsConcurrent,
  assertSingleSiteAndNoHierarchyScope
} from '../../workers/security/account-isolation'

describe('TST-042: Isolation between individuals and companies under concurrency', () => {
  let sqlite: DatabaseSync
  let world: IsolationWorld

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    world = await setupIsolationFixture(sqlite)
  })

  afterEach(() => {
    if (sqlite?.isOpen) {
      sqlite.close()
    }
  })

  it('1. Datos: Profile, identity and fiscal details never leak across accounts under concurrent requests', async () => {
    const sessions = [world.particularA, world.particularB, world.companyX, world.companyY]

    // Run 20 concurrent parallel reads intermixing all sessions
    const concurrentRequests = Array.from({ length: 20 }, (_, i) => {
      const session = sessions[i % sessions.length]!
      return queryAccountProfileConcurrent(world.database, session)
    })

    const results = await Promise.all(concurrentRequests)

    results.forEach((profile, i) => {
      const expectedSession = sessions[i % sessions.length]!
      expect(profile.customerId).toBe(expectedSession.customerId)
      expect(profile.email).toBe(expectedSession.email)
      expect(profile.accountType).toBe(expectedSession.accountType)

      if (expectedSession.accountType === 'empresa') {
        expect(profile.companyId).toBe(expectedSession.companyId)
        expect(profile.cif).toBeDefined()
        expect(profile.legalName).toBeDefined()
      } else {
        expect(profile.companyId).toBeNull()
        expect(profile.cif).toBeNull()
      }
    })
  })

  it('1b. Datos IDOR: Cross-account data access attempts are strictly rejected under concurrency', async () => {
    const idorAttempts = [
      // Particular A tries to read Particular B's profile
      queryAccountProfileConcurrent(world.database, world.particularA, {
        targetCustomerId: world.particularB.customerId
      }),
      // Particular A tries to read Company X's data
      queryAccountProfileConcurrent(world.database, world.particularA, { targetCustomerId: world.companyX.customerId }),
      // Company X tries to read Company Y's data
      queryAccountProfileConcurrent(world.database, world.companyX, { targetCustomerId: world.companyY.customerId }),
      // Company Y tries to read Particular A's data
      queryAccountProfileConcurrent(world.database, world.companyY, { targetCustomerId: world.particularA.customerId })
    ]

    const outcomes = await Promise.all(idorAttempts.map((p) => p.catch((err) => ({ error: err.code || err.message }))))

    outcomes.forEach((res) => {
      expect(res).toMatchObject({ error: expect.stringMatching(/forbidden|not_found/) })
    })
  })

  it('2. Pedidos: Order history and order inspection strictly isolate under concurrent access', async () => {
    const ordersA = await queryAccountOrdersConcurrent(world.database, world.particularA)
    const ordersX = await queryAccountOrdersConcurrent(world.database, world.companyX)

    expect(ordersA.every((o) => o.customerId === world.particularA.customerId)).toBe(true)
    expect(ordersX.every((o) => o.customerId === world.companyX.customerId)).toBe(true)
    expect(ordersA.some((o) => o.customerId === world.companyX.customerId)).toBe(false)
    expect(ordersX.some((o) => o.customerId === world.particularA.customerId)).toBe(false)

    // Parallel cross-access attempts
    const orderXId = ordersX[0]!.id
    const crossOrderAccess = queryAccountOrdersConcurrent(world.database, world.particularA, { orderId: orderXId })
    await expect(crossOrderAccess).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('3. Tarifas: B2C public retail prices vs B2B negotiated price lists do not cross under high concurrency', async () => {
    const sessions = [world.particularA, world.particularB, world.companyX, world.companyY]
    const variantId = 'v-1-1' // target chemical cleaning variant

    // Fire 40 concurrent price queries simultaneously
    const priceQueries = Array.from({ length: 40 }, (_, idx) => {
      const session = sessions[idx % sessions.length]!
      return resolvePricingConcurrent(world.database, session, variantId)
    })

    const results = await Promise.all(priceQueries)

    results.forEach((priceResult, idx) => {
      const session = sessions[idx % sessions.length]!
      if (session.accountType === 'particular') {
        // Particulars MUST get the public retail price (e.g. 1000 cents gross)
        expect(priceResult.unitGrossCents).toBe(1000)
        expect(priceResult.priceTier).toBe('public')
      } else if (session.companyId === world.companyX.companyId) {
        // Company X has negotiated 700 cents gross
        expect(priceResult.unitGrossCents).toBe(700)
        expect(priceResult.priceTier).toBe('b2b_negotiated')
      } else if (session.companyId === world.companyY.companyId) {
        // Company Y has negotiated 600 cents gross
        expect(priceResult.unitGrossCents).toBe(600)
        expect(priceResult.priceTier).toBe('b2b_negotiated')
      }
    })
  })

  it('4. Condiciones comerciales: B2B deferred payment terms and credit accounts cannot be accessed by B2C', async () => {
    // Particular A attempts to checkout with commercial credit terms
    const b2cCreditAttempt = verifyCommercialConditionsConcurrent(world.database, world.particularA, {
      paymentMethod: 'b2b_credit_invoice',
      amountCents: 5000
    })
    await expect(b2cCreditAttempt).rejects.toMatchObject({ code: 'payment_method_not_allowed' })

    // Company X uses allowed B2B credit terms
    const b2bCreditValid = await verifyCommercialConditionsConcurrent(world.database, world.companyX, {
      paymentMethod: 'b2b_credit_invoice',
      amountCents: 5000
    })
    expect(b2bCreditValid.allowed).toBe(true)
    expect(b2bCreditValid.deferredPaymentDays).toBe(30)
    expect(b2bCreditValid.remainingCreditCents).toBe(45000) // 50000 limit - 5000

    // Company Y credit balance is independent of Company X
    const companyYConditions = await verifyCommercialConditionsConcurrent(world.database, world.companyY, {
      paymentMethod: 'b2b_credit_invoice',
      amountCents: 10000
    })
    expect(companyYConditions.allowed).toBe(true)
    expect(companyYConditions.deferredPaymentDays).toBe(60)
    expect(companyYConditions.remainingCreditCents).toBe(90000) // 100000 limit - 10000
  })

  it('5. Alcance estricto: Rejects multisede, buyer hierarchies and departmental approvals', () => {
    expect(() =>
      assertSingleSiteAndNoHierarchyScope({
        isMultiSite: true,
        buyerRole: 'department_manager',
        requiresDepartmentalApproval: true
      })
    ).toThrow('scope_out_of_bounds')

    // Valid single-site, non-hierarchical scope passes cleanly
    const valid = assertSingleSiteAndNoHierarchyScope({
      isMultiSite: false,
      buyerRole: null,
      requiresDepartmentalApproval: false
    })
    expect(valid.singleSiteConfirmed).toBe(true)
  })

  it('6. Spoofing de sesión: Particular que falsifica accountType=empresa y companyId ajeno no obtiene tarifa ni crédito B2B', async () => {
    const spoofedParticular = {
      ...world.particularA,
      accountType: 'empresa' as const,
      companyId: world.companyX.companyId
    }

    const priceResult = await resolvePricingConcurrent(world.database, spoofedParticular, 'v-1-1')
    expect(priceResult.unitGrossCents).toBe(1000)
    expect(priceResult.priceTier).toBe('public')

    await expect(
      verifyCommercialConditionsConcurrent(world.database, spoofedParticular, {
        paymentMethod: 'b2b_credit_invoice',
        amountCents: 5000
      })
    ).rejects.toMatchObject({ code: 'payment_method_not_allowed' })
  })
})
