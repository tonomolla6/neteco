import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import {
  calculateCustomerRiskScore,
  getCustomerScoringProfile,
  reviewCustomerRiskScore,
  evaluateScoringModelQuality
} from '../../workers/crm/risk-scoring'

const NOW = '2026-10-29T10:00:00Z'
const CUSTOMER_A = '30000000-0000-4000-8000-000000000001'
const CUSTOMER_B = '30000000-0000-4000-8000-000000000002'
const COMPANY_A = '40000000-0000-4000-8000-000000000001'
const ANALYST_ID = '10000000-0000-4000-8000-000000000099'

describe('CUS-031: Assisted Customer Risk & Value Scoring', () => {
  let sqlite: DatabaseSync
  let database: D1Database

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    sqlite = await openMigratedDatabase()
    sqlite.limits.exprDepth = 100
    sqlite.exec(await readFile('db/d1/migrations/0108_b2b_shared_lists_edi_scoring.sql', 'utf8'))
    database = d1OverSqlite(sqlite)
    seedInventoryFixture(sqlite)

    // Seed customers, company, orders and analyst identity
    sqlite.prepare('INSERT INTO customers(id, created_at, updated_at) VALUES (?, ?, ?)').run(CUSTOMER_A, NOW, NOW)
    sqlite.prepare('INSERT INTO customers(id, created_at, updated_at) VALUES (?, ?, ?)').run(CUSTOMER_B, NOW, NOW)

    sqlite
      .prepare(
        `INSERT INTO companies(id, customer_id, legal_name, tax_id, country_code, status, created_at, updated_at)
         VALUES (?, ?, 'Hostelería Mediterránea S.A.', 'A11223344', 'ES', 'approved', ?, ?)`
      )
      .run(COMPANY_A, CUSTOMER_A, NOW, NOW)

    sqlite
      .prepare(
        `INSERT INTO identities(id, email, password_hash, email_verified_at, status, created_at, updated_at)
         VALUES (?, 'analyst@neteco.invalid', 'synthetic', ?, 'active', ?, ?)`
      )
      .run(ANALYST_ID, NOW, NOW, NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('calcula un scoring asistido explicable con desglose transparente de factores', async () => {
    const profile = await calculateCustomerRiskScore(database, {
      customerId: CUSTOMER_A,
      commercialMetrics: {
        totalSpentCents: 5000000,
        paidInvoicesCount: 12,
        overdueInvoicesCount: 0,
        averageDaysToPay: 18,
        returnedOrdersCount: 0,
        totalOrdersCount: 15,
        creditLimitCents: 1000000,
        outstandingBalanceCents: 200000
      },
      now: NOW
    })

    expect(profile.customerId).toBe(CUSTOMER_A)
    expect(profile.companyId).toBe(COMPANY_A)
    expect(profile.riskTier).toBe('low')
    expect(profile.riskScore).toBeLessThanOrEqual(25)
    expect(profile.valueTier).toBe('tier_a')
    expect(profile.valueScore).toBeGreaterThanOrEqual(75)
    expect(profile.recommendedPaymentTerms).toBe('net_30')
    expect(profile.recommendedCreditLimitCents).toBeGreaterThan(0)
    expect(profile.reviewStatus).toBe('automatic')

    // Factors must be explainable
    expect(profile.factors).toHaveLength(5)
    const punctuality = profile.factors.find((f) => f.category === 'payment_punctuality')
    expect(punctuality).toBeDefined()
    expect(punctuality?.impact).toBe('positive')
    expect(punctuality?.weightBasisPoints).toBe(3000)
    expect(punctuality?.description).toContain('días')
  })

  it('garantiza la no discriminación usando exclusivamente métricas comerciales objetivas', async () => {
    const profile = await calculateCustomerRiskScore(database, {
      customerId: CUSTOMER_B,
      commercialMetrics: {
        totalSpentCents: 100000,
        paidInvoicesCount: 1,
        overdueInvoicesCount: 2,
        averageDaysToPay: 45,
        returnedOrdersCount: 1,
        totalOrdersCount: 3,
        creditLimitCents: 0,
        outstandingBalanceCents: 50000
      },
      now: NOW
    })

    // High risk flags for review rather than automatic discriminatory adverse action
    expect(profile.riskTier).toBe('high')
    expect(profile.reviewStatus).toBe('under_review')
    expect(profile.recommendedPaymentTerms).toBe('prepayment')

    // Assert that no demographic factor exists
    for (const factor of profile.factors) {
      expect(['payment_punctuality', 'order_volume', 'claims_returns', 'company_profile', 'credit_utilization']).toContain(
        factor.category
      )
    }
  })

  it('permite a un analista revisar y anular el scoring con justificación obligatoria', async () => {
    // Initial calculation
    await calculateCustomerRiskScore(database, {
      customerId: CUSTOMER_A,
      commercialMetrics: {
        totalSpentCents: 500000,
        paidInvoicesCount: 4,
        overdueInvoicesCount: 1,
        averageDaysToPay: 35,
        returnedOrdersCount: 0,
        totalOrdersCount: 4,
        creditLimitCents: 200000,
        outstandingBalanceCents: 100000
      },
      now: NOW
    })

    // Short justification must fail
    await expect(
      reviewCustomerRiskScore(database, {
        customerId: CUSTOMER_A,
        analystIdentityId: ANALYST_ID,
        input: {
          action: 'override',
          newRiskTier: 'low',
          newCreditLimitCents: 500000,
          justification: 'ok' // too short (< 10 chars)
        },
        now: NOW
      })
    ).rejects.toThrow(/justification/)

    // Valid human override
    const reviewed = await reviewCustomerRiskScore(database, {
      customerId: CUSTOMER_A,
      analystIdentityId: ANALYST_ID,
      input: {
        action: 'override',
        newRiskTier: 'low',
        newCreditLimitCents: 500000,
        justification: 'Cliente avalado por grupo matriz solvente con aval bancario'
      },
      now: NOW
    })

    expect(reviewed.reviewStatus).toBe('overridden')
    expect(reviewed.riskTier).toBe('low')
    expect(reviewed.recommendedCreditLimitCents).toBe(500000)

    // Check review audit history in database
    const history = sqlite
      .prepare('SELECT * FROM customer_risk_scoring_reviews WHERE customer_id = ?')
      .all(CUSTOMER_A) as Array<{ justification: string; action: string }>
    expect(history).toHaveLength(1)
    expect(history[0].action).toBe('override')
    expect(history[0].justification).toContain('aval bancario')
  })

  it('evalúa la calidad del modelo monitorizando tasa de anulación y calibración', async () => {
    // Generate some profiles
    await calculateCustomerRiskScore(database, {
      customerId: CUSTOMER_A,
      commercialMetrics: {
        totalSpentCents: 3000000,
        paidInvoicesCount: 10,
        overdueInvoicesCount: 0,
        averageDaysToPay: 15,
        returnedOrdersCount: 0,
        totalOrdersCount: 10,
        creditLimitCents: 500000,
        outstandingBalanceCents: 0
      },
      now: NOW
    })

    await calculateCustomerRiskScore(database, {
      customerId: CUSTOMER_B,
      commercialMetrics: {
        totalSpentCents: 200000,
        paidInvoicesCount: 2,
        overdueInvoicesCount: 1,
        averageDaysToPay: 35,
        returnedOrdersCount: 0,
        totalOrdersCount: 2,
        creditLimitCents: 0,
        outstandingBalanceCents: 0
      },
      now: NOW
    })

    const quality = await evaluateScoringModelQuality(database, {
      modelVersion: 'neteco-risk-v1',
      now: NOW
    })

    expect(quality.sampleSize).toBe(2)
    expect(quality.distribution.lowRiskCount).toBeGreaterThanOrEqual(1)
    expect(quality.qualityStatus).toBe('optimal')
  })
})
