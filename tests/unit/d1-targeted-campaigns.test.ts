import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createTargetedCampaignAdmin,
  dispatchCampaignToRecipient,
  evaluateEligibleRecipients,
  getCampaignReporting,
  listActiveCustomerCampaigns,
  recordCampaignInteraction,
  TargetedCampaignError
} from '../../workers/marketing/targeted-campaigns'
import type { CreateTargetedCampaignInput } from '../../shared/targeted-campaigns'
import {
  ADMIN_IDENTITY,
  CUSTOMER_IDENTITY_1,
  CUSTOMER_IDENTITY_2,
  CUSTOMER_UNSUBSCRIBED,
  COMPANY_ID_1,
  NOW,
  ORDER_1,
  OTHER_IDENTITY,
  createLearningCampaignsWorld,
  type LearningCampaignsWorld
} from './learning-campaigns-fixture'

let world: LearningCampaignsWorld
beforeEach(async () => {
  world = await createLearningCampaignsWorld()
})
afterEach(() => world.close())

const code = (e: unknown) => (e instanceof TargetedCampaignError ? e.code : `unknown:${String(e)}`)
const fails = (p: Promise<unknown>) => p.then(() => 'resolved', code)

describe('MKT-035: D1 Targeted B2B Marketing Campaigns', () => {
  const companyCampaignInput = {
    code: 'camp-b2b-turia-vip',
    name: 'Tarifa Especial Lavanderías Turia Q4',
    description: '10% de descuento directo en toda la gama de peróxidos y álcalis para Turia.',
    targetType: 'company' as const,
    targetId: COMPANY_ID_1,
    tariffType: 'percentage_discount' as const,
    discountPercent: 10,
    minOrderNetCents: 20000,
    marginFloorBasisPoints: 1500,
    startAt: '2026-10-01T00:00:00Z',
    endAt: '2026-12-31T23:59:59Z'
  }

  it('allows live admin to create targeted campaign and forbids non-admin', async () => {
    // Non-admin rejected
    expect(
      await fails(
        createTargetedCampaignAdmin(world.db, {
          actorId: OTHER_IDENTITY,
          input: companyCampaignInput,
          now: NOW
        })
      )
    ).toBe('forbidden')

    // Live admin succeeds
    const camp = await createTargetedCampaignAdmin(world.db, {
      actorId: ADMIN_IDENTITY,
      input: companyCampaignInput,
      now: NOW
    })
    expect(camp.id).toBeDefined()
    expect(camp.targetType).toBe('company')
    expect(camp.targetId).toBe(COMPANY_ID_1)

    // Rejects duplicate code
    expect(
      await fails(
        createTargetedCampaignAdmin(world.db, {
          actorId: ADMIN_IDENTITY,
          input: companyCampaignInput,
          now: NOW
        })
      )
    ).toBe('code_conflict')
  })

  it('strictly rejects any attempts to target by sede, branch or buyer hierarchy', async () => {
    const invalidInput = {
      ...companyCampaignInput,
      code: 'camp-sede-fail',
      sedeId: 'branch-madrid-sur',
      buyerHierarchy: 'regional_director'
    }

    expect(
      await fails(
        createTargetedCampaignAdmin(world.db, {
          actorId: ADMIN_IDENTITY,
          input: invalidInput as unknown as CreateTargetedCampaignInput,
          now: NOW
        })
      )
    ).toBe('sede_or_hierarchy_targeting_forbidden')
  })

  it('verifies commercial consent strictly: includes confirmed subscribers and excludes unsubscribed/suppressed', async () => {
    // Sector campaign targeting all customers
    const sectorCampaign = await createTargetedCampaignAdmin(world.db, {
      actorId: ADMIN_IDENTITY,
      input: {
        ...companyCampaignInput,
        code: 'camp-sector-limpieza',
        targetType: 'sector',
        targetId: 'lavanderia_industrial'
      },
      now: NOW
    })

    // Evaluate eligible recipients
    const recipients = await evaluateEligibleRecipients(world.db, sectorCampaign.id)

    // Customer 1 and Customer 2 have confirmed subscriptions
    const elena = recipients.find((r) => r.customerId === CUSTOMER_IDENTITY_1)
    const carlos = recipients.find((r) => r.customerId === CUSTOMER_IDENTITY_2)
    // Customer 3 is unsubscribed / suppressed in newsletter_suppressions
    const laura = recipients.find((r) => r.customerId === CUSTOMER_UNSUBSCRIBED)

    expect(elena?.hasConsent).toBe(true)
    expect(carlos?.hasConsent).toBe(true)
    expect(laura?.hasConsent).toBe(false)
    expect(laura?.exclusionReason).toBe('unsubscribed_or_suppressed')

    // Attempting to dispatch to unsubscribed customer fails
    expect(
      await fails(
        dispatchCampaignToRecipient(world.db, {
          campaignId: sectorCampaign.id,
          customerId: CUSTOMER_UNSUBSCRIBED,
          channel: 'email',
          now: NOW
        })
      )
    ).toBe('consent_missing_or_suppressed')

    // Dispatching to customer with valid consent succeeds
    const dispatch = await dispatchCampaignToRecipient(world.db, {
      campaignId: sectorCampaign.id,
      customerId: CUSTOMER_IDENTITY_1,
      channel: 'email',
      now: NOW
    })
    expect(dispatch.id).toBeDefined()
    expect(dispatch.consentVerified).toBe(true)
    expect(dispatch.status).toBe('dispatched')

    // Duplicate dispatch to same customer is prevented
    expect(
      await fails(
        dispatchCampaignToRecipient(world.db, {
          campaignId: sectorCampaign.id,
          customerId: CUSTOMER_IDENTITY_1,
          channel: 'email',
          now: NOW
        })
      )
    ).toBe('already_dispatched')
  })

  it('tracks campaign interaction lifecycle (opened, clicked, converted) and aggregates reporting metrics', async () => {
    const camp = await createTargetedCampaignAdmin(world.db, {
      actorId: ADMIN_IDENTITY,
      input: companyCampaignInput,
      now: NOW
    })

    // Dispatch to Customer 1 (belongs to Company 1)
    await dispatchCampaignToRecipient(world.db, {
      campaignId: camp.id,
      customerId: CUSTOMER_IDENTITY_1,
      channel: 'email',
      now: NOW
    })

    // Record open event
    await recordCampaignInteraction(world.db, {
      campaignId: camp.id,
      customerId: CUSTOMER_IDENTITY_1,
      interactionType: 'open',
      now: NOW
    })

    // Record click event
    await recordCampaignInteraction(world.db, {
      campaignId: camp.id,
      customerId: CUSTOMER_IDENTITY_1,
      interactionType: 'click',
      now: NOW
    })

    // Record conversion event with order
    await recordCampaignInteraction(world.db, {
      campaignId: camp.id,
      customerId: CUSTOMER_IDENTITY_1,
      interactionType: 'conversion',
      orderId: ORDER_1,
      revenueNetCents: 1250000,
      now: NOW
    })

    // Get reporting metrics
    const report = await getCampaignReporting(world.db, {
      actorId: ADMIN_IDENTITY,
      campaignId: camp.id
    })
    expect(report.metrics.totalDispatched).toBe(1)
    expect(report.metrics.totalOpened).toBe(1)
    expect(report.metrics.totalClicked).toBe(1)
    expect(report.metrics.totalConverted).toBe(1)
    expect(report.metrics.totalRevenueNetCents).toBe(1250000)
    expect(report.metrics.conversionRatePercent).toBe(100)
  })

  it('returns active targeted campaigns to eligible customers with active consent', async () => {
    await createTargetedCampaignAdmin(world.db, {
      actorId: ADMIN_IDENTITY,
      input: {
        ...companyCampaignInput,
        status: 'active'
      },
      now: NOW
    })

    // Customer 1 (Company 1, active consent) sees the campaign
    const cust1Campaigns = await listActiveCustomerCampaigns(world.db, {
      customerId: CUSTOMER_IDENTITY_1,
      now: NOW
    })
    expect(cust1Campaigns.length).toBe(1)
    expect(cust1Campaigns[0].code).toBe(companyCampaignInput.code)

    // Customer 2 (Company 2) does not match target company
    const cust2Campaigns = await listActiveCustomerCampaigns(world.db, {
      customerId: CUSTOMER_IDENTITY_2,
      now: NOW
    })
    expect(cust2Campaigns.length).toBe(0)

    // Unsubscribed customer never receives campaigns even if targeted
    await createTargetedCampaignAdmin(world.db, {
      actorId: ADMIN_IDENTITY,
      input: {
        ...companyCampaignInput,
        code: 'camp-directa-laura',
        targetType: 'customer',
        targetId: CUSTOMER_UNSUBSCRIBED,
        status: 'active'
      },
      now: NOW
    })
    const unsubscribedCampaigns = await listActiveCustomerCampaigns(world.db, {
      customerId: CUSTOMER_UNSUBSCRIBED,
      now: NOW
    })
    expect(unsubscribedCampaigns.length).toBe(0)
  })
})
