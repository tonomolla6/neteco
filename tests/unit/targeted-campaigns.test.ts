import { describe, expect, it } from 'vitest'
import {
  computeCampaignMetrics,
  createTargetedCampaignSchema,
  validateStrictNoSedeNoHierarchy,
  type CampaignDispatchItem
} from '../../shared/targeted-campaigns'

describe('MKT-035: Targeted B2B Marketing Campaigns (Domain Logic)', () => {
  const validCampaign = {
    code: 'camp-lavanderias-otono-2026',
    name: 'Campaña Sector Lavandería Industrial Q4 2026',
    description: 'Tarifa especial en peróxidos y detergentes alcalinos para lavanderías industriales.',
    targetType: 'sector' as const,
    targetId: 'lavanderia_industrial',
    tariffType: 'percentage_discount' as const,
    discountPercent: 15,
    minOrderNetCents: 50000,
    marginFloorBasisPoints: 1800,
    startAt: '2026-10-01T00:00:00Z',
    endAt: '2026-12-31T23:59:59Z'
  }

  it('validates legitimate customer, company and sector targeting', () => {
    // Sector targeting
    expect(createTargetedCampaignSchema.safeParse(validCampaign).success).toBe(true)

    // Customer targeting
    expect(
      createTargetedCampaignSchema.safeParse({
        ...validCampaign,
        code: 'camp-cliente-vip',
        targetType: 'customer',
        targetId: 'cust-12345'
      }).success
    ).toBe(true)

    // Company targeting
    expect(
      createTargetedCampaignSchema.safeParse({
        ...validCampaign,
        code: 'camp-empresa-turia',
        targetType: 'company',
        targetId: 'comp-turia-lavanderia'
      }).success
    ).toBe(true)
  })

  it('strictly rejects prohibited targeting by branch/sede/location or buyer hierarchy', () => {
    // Attempting branch or sede targeting
    const withSede = {
      ...validCampaign,
      sedeId: 'sede-valencia-norte',
      branch: 'sucursal-4'
    }
    expect(validateStrictNoSedeNoHierarchy(withSede).valid).toBe(false)
    expect(validateStrictNoSedeNoHierarchy(withSede).reason).toContain('sede o jerarquía')

    // Attempting buyer hierarchy targeting
    const withHierarchy = {
      ...validCampaign,
      buyerHierarchy: 'regional_procurement_lead',
      delegatedBuyerId: 'buyer-99'
    }
    expect(validateStrictNoSedeNoHierarchy(withHierarchy).valid).toBe(false)
    expect(validateStrictNoSedeNoHierarchy(withHierarchy).reason).toContain('sede o jerarquía')

    // Schema level rejection when invalid targetType is used
    expect(
      createTargetedCampaignSchema.safeParse({
        ...validCampaign,
        targetType: 'branch'
      }).success
    ).toBe(false)
  })

  it('validates tariff configurations and safeguards against sub-margin discounts', () => {
    // Invalid discount (> 50%)
    expect(
      createTargetedCampaignSchema.safeParse({
        ...validCampaign,
        discountPercent: 65
      }).success
    ).toBe(false)

    // Invalid margin floor (< 500 basis points / 5%)
    expect(
      createTargetedCampaignSchema.safeParse({
        ...validCampaign,
        marginFloorBasisPoints: 200
      }).success
    ).toBe(false)

    // End date before start date
    expect(
      createTargetedCampaignSchema.safeParse({
        ...validCampaign,
        startAt: '2026-11-01T00:00:00Z',
        endAt: '2026-10-01T00:00:00Z'
      }).success
    ).toBe(false)
  })

  it('computes reporting metrics correctly (opens, clicks, conversions, revenue, conversion rate)', () => {
    const dispatches: CampaignDispatchItem[] = [
      {
        id: 'd1',
        campaignId: 'c1',
        customerId: 'cust-1',
        status: 'converted',
        openedAt: '2026-10-10T10:00:00Z',
        clickedAt: '2026-10-10T10:05:00Z',
        convertedAt: '2026-10-10T11:00:00Z',
        convertedOrderId: 'ord-1',
        revenueNetCents: 120000
      },
      {
        id: 'd2',
        campaignId: 'c1',
        customerId: 'cust-2',
        status: 'clicked',
        openedAt: '2026-10-10T12:00:00Z',
        clickedAt: '2026-10-10T12:15:00Z',
        convertedAt: null,
        convertedOrderId: null,
        revenueNetCents: 0
      },
      {
        id: 'd3',
        campaignId: 'c1',
        customerId: 'cust-3',
        status: 'opened',
        openedAt: '2026-10-10T14:00:00Z',
        clickedAt: null,
        convertedAt: null,
        convertedOrderId: null,
        revenueNetCents: 0
      },
      {
        id: 'd4',
        campaignId: 'c1',
        customerId: 'cust-4',
        status: 'dispatched',
        openedAt: null,
        clickedAt: null,
        convertedAt: null,
        convertedOrderId: null,
        revenueNetCents: 0
      }
    ]

    const metrics = computeCampaignMetrics(dispatches)
    expect(metrics.totalDispatched).toBe(4)
    expect(metrics.totalOpened).toBe(3)
    expect(metrics.totalClicked).toBe(2)
    expect(metrics.totalConverted).toBe(1)
    expect(metrics.totalRevenueNetCents).toBe(120000)
    expect(metrics.conversionRatePercent).toBe(25.0) // 1/4 = 25%
    expect(metrics.openRatePercent).toBe(75.0) // 3/4 = 75%
  })
})
