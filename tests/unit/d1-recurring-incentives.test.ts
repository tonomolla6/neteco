import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  approveFiscalSettlementAdmin,
  createIncentiveAgreementAdmin,
  evaluatePeriodSettlementAdmin,
  getCustomerIncentiveOverview,
  RecurringIncentiveError
} from '../../workers/b2b/recurring-incentives'
import {
  ADMIN_IDENTITY,
  COMPANY_ID_1,
  CUSTOMER_IDENTITY_1,
  CUSTOMER_IDENTITY_2,
  NOW,
  OTHER_IDENTITY,
  createLearningCampaignsWorld,
  type LearningCampaignsWorld
} from './learning-campaigns-fixture'

let world: LearningCampaignsWorld
beforeEach(async () => {
  world = await createLearningCampaignsWorld()
})
afterEach(() => world.close())

const code = (e: unknown) => (e instanceof RecurringIncentiveError ? e.code : `unknown:${String(e)}`)
const fails = (p: Promise<unknown>) => p.then(() => 'resolved', code)

describe('MKT-036: D1 Recurring B2B Incentives', () => {
  const sampleAgreementInput = {
    companyId: COMPANY_ID_1,
    contractRef: 'CTR-B2B-TURIA-2026-01',
    contractTermsVersion: '2026.1',
    contractSignedAt: '2026-01-10T10:00:00Z',
    periodFrequency: 'quarterly' as const,
    volumeTiers: [
      { minVolumeCents: 300000, rebatePercentBasisPoints: 200 }, // €3,000 -> 2%
      { minVolumeCents: 1000000, rebatePercentBasisPoints: 400 }, // €10,000 -> 4%
      { minVolumeCents: 2000000, rebatePercentBasisPoints: 500 } // €20,000 -> 5%
    ],
    minGrossMarginBasisPoints: 2000,
    slaPunctualPaymentRequired: true,
    slaMinAvgOrderNetCents: 50000,
    slaEinvoiceRequired: true,
    fiscalNotes:
      'Rappel por compras conforme a Art. 80.Uno.1ª Ley 37/1992 del IVA. Emisión de factura rectificativa con rectificación de base imponible y cuota.',
    fiscalVatTreatment: 'credit_note_art80_liva' as const
  }

  it('allows live admin to create an agreement and forbids non-admin', async () => {
    // Non-admin fails
    expect(
      await fails(
        createIncentiveAgreementAdmin(world.db, {
          actorId: OTHER_IDENTITY,
          input: sampleAgreementInput,
          now: NOW
        })
      )
    ).toBe('forbidden')

    // Live admin succeeds
    const agreement = await createIncentiveAgreementAdmin(world.db, {
      actorId: ADMIN_IDENTITY,
      input: sampleAgreementInput,
      now: NOW
    })
    expect(agreement.id).toBeDefined()
    expect(agreement.contractRef).toBe(sampleAgreementInput.contractRef)
    expect(agreement.status).toBe('active')

    // Duplicate agreement for same company and frequency rejected
    expect(
      await fails(
        createIncentiveAgreementAdmin(world.db, {
          actorId: ADMIN_IDENTITY,
          input: sampleAgreementInput,
          now: NOW
        })
      )
    ).toBe('agreement_conflict')
  })

  it('evaluates period settlement based on real qualifying turnover, margins and SLA compliance', async () => {
    const agreement = await createIncentiveAgreementAdmin(world.db, {
      actorId: ADMIN_IDENTITY,
      input: sampleAgreementInput,
      now: NOW
    })

    // In our test fixture, Customer 1 has 2 orders totaling €21,000 net cents (12,500 + 8,500)
    const settlement = await evaluatePeriodSettlementAdmin(world.db, {
      actorId: ADMIN_IDENTITY,
      agreementId: agreement.id,
      settlementPeriod: '2026-Q3',
      periodStart: '2026-07-01T00:00:00Z',
      periodEnd: '2026-09-30T23:59:59Z',
      marginAchievedBasisPoints: 2400, // 24% > 20%
      slaPaymentMet: true,
      slaOrderSizeMet: true,
      slaEinvoiceMet: true,
      now: NOW
    })

    expect(settlement.qualifyingTurnoverNetCents).toBe(2100000) // €21,000.00
    expect(settlement.marginThresholdMet).toBe(true)
    expect(settlement.slaConditionsAllMet).toBe(true)
    expect(settlement.appliedRebateBasisPoints).toBe(500) // Reached tier >= €20,000 -> 500 bps (5%)
    expect(settlement.rebateNetCents).toBe(105000) // €21,000 * 5% = €1,050.00
    expect(settlement.vatTaxCents).toBe(22050) // 21% of 1050 = €220.50
    expect(settlement.totalCreditGrossCents).toBe(127050) // €1,270.50
    expect(settlement.settlementStatus).toBe('calculated')

    // Duplicate period settlement rejected
    expect(
      await fails(
        evaluatePeriodSettlementAdmin(world.db, {
          actorId: ADMIN_IDENTITY,
          agreementId: agreement.id,
          settlementPeriod: '2026-Q3',
          periodStart: '2026-07-01T00:00:00Z',
          periodEnd: '2026-09-30T23:59:59Z',
          marginAchievedBasisPoints: 2400,
          slaPaymentMet: true,
          slaOrderSizeMet: true,
          slaEinvoiceMet: true,
          now: NOW
        })
      )
    ).toBe('settlement_already_exists')
  })

  it('allows live admin to review and approve fiscal credit note settlement with CAS concurrency protection', async () => {
    const agreement = await createIncentiveAgreementAdmin(world.db, {
      actorId: ADMIN_IDENTITY,
      input: sampleAgreementInput,
      now: NOW
    })

    const settlement = await evaluatePeriodSettlementAdmin(world.db, {
      actorId: ADMIN_IDENTITY,
      agreementId: agreement.id,
      settlementPeriod: '2026-Q3',
      periodStart: '2026-07-01T00:00:00Z',
      periodEnd: '2026-09-30T23:59:59Z',
      marginAchievedBasisPoints: 2500,
      slaPaymentMet: true,
      slaOrderSizeMet: true,
      slaEinvoiceMet: true,
      now: NOW
    })

    // Concurrency conflict test (wrong version)
    expect(
      await fails(
        approveFiscalSettlementAdmin(world.db, {
          actorId: ADMIN_IDENTITY,
          settlementId: settlement.id,
          creditNoteRef: 'ABONO-2026-TURIA-Q3',
          notes: 'Liquidación revisada y aprobada por Dpto. Fiscal.',
          version: 999, // Mismatched version
          now: NOW
        })
      )
    ).toBe('version_conflict')

    // Approving with correct version
    const approved = await approveFiscalSettlementAdmin(world.db, {
      actorId: ADMIN_IDENTITY,
      settlementId: settlement.id,
      creditNoteRef: 'ABONO-2026-TURIA-Q3',
      notes: 'Liquidación revisada y aprobada por Dpto. Fiscal.',
      version: settlement.version,
      now: NOW
    })
    expect(approved.settlementStatus).toBe('approved')
    expect(approved.creditNoteRef).toBe('ABONO-2026-TURIA-Q3')
    expect(approved.fiscalApprovalIdentityId).toBe(ADMIN_IDENTITY)
    expect(approved.version).toBe(2)
  })

  it('provides customer B2B overview with transparent tier progress and fiscal settlements', async () => {
    const agreement = await createIncentiveAgreementAdmin(world.db, {
      actorId: ADMIN_IDENTITY,
      input: sampleAgreementInput,
      now: NOW
    })

    await evaluatePeriodSettlementAdmin(world.db, {
      actorId: ADMIN_IDENTITY,
      agreementId: agreement.id,
      settlementPeriod: '2026-Q3',
      periodStart: '2026-07-01T00:00:00Z',
      periodEnd: '2026-09-30T23:59:59Z',
      marginAchievedBasisPoints: 2500,
      slaPaymentMet: true,
      slaOrderSizeMet: true,
      slaEinvoiceMet: true,
      now: NOW
    })

    // Customer 1 views overview
    const overview = await getCustomerIncentiveOverview(world.db, {
      customerId: CUSTOMER_IDENTITY_1
    })

    expect(overview).not.toBeNull()
    expect(overview?.agreement.contractRef).toBe(sampleAgreementInput.contractRef)
    expect(overview?.currentPeriodTurnoverNetCents).toBe(2100000)
    expect(overview?.settlements.length).toBe(1)
    expect(overview?.settlements[0].settlementPeriod).toBe('2026-Q3')

    // Customer 2 has no agreement configured yet
    const overview2 = await getCustomerIncentiveOverview(world.db, {
      customerId: CUSTOMER_IDENTITY_2
    })
    expect(overview2).toBeNull()
  })
})
