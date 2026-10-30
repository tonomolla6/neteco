import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createBaTestWorld,
  ADMIN_IDENTITY,
  MKT_MGR_IDENTITY,
  FIXTURE_NOW,
  type BaTestWorld
} from './d1-ba-preview-diff-fixtures'
import {
  createCommercialCampaign,
  linkCampaignAsset,
  unlinkCampaignAsset,
  getCommercialCampaignDetail,
  getCommercialCalendarFeed,
  detectCampaignConflictsInPeriod
} from '../../workers/marketing/commercial-campaigns'
import { detectCommercialCampaignConflicts } from '../../shared/commercial-campaigns'

describe('ADM-026: Commercial campaign manager & commercial calendar with conflict detection', () => {
  let world: BaTestWorld

  beforeEach(async () => {
    world = await createBaTestWorld()
  })

  afterEach(() => world.close())

  describe('Campaign CRUD and asset linking', () => {
    it('creates commercial campaign, links banners, promotions, modales, emails, landings, and returns full detail', async () => {
      const campaign = await createCommercialCampaign(world.db, {
        commandId: 'cmd-camp-create-01',
        actorId: MKT_MGR_IDENTITY,
        code: 'camp-otono-desengrasantes-2026',
        name: 'Campaña de Otoño: Desengrasantes Ecológicos',
        description: 'Promoción integral en web, email y landing especializada para hostelería y talleres.',
        channelType: 'omnichannel',
        targetAudience: 'b2b',
        priority: 75,
        budgetLimitCents: 500000,
        startAt: '2026-11-01T00:00:00Z',
        endAt: '2026-11-15T23:59:59Z',
        now: FIXTURE_NOW
      })

      expect(campaign.id).toBeDefined()
      expect(campaign.status).toBe('draft')
      expect(campaign.code).toBe('camp-otono-desengrasantes-2026')

      // Link 1: Banner
      const bannerLink = await linkCampaignAsset(world.db, {
        commandId: 'cmd-link-banner-01',
        actorId: MKT_MGR_IDENTITY,
        campaignId: campaign.id,
        assetType: 'banner',
        assetId: 'banner-hero-otono-5l',
        assetName: 'Banner Hero 5L Ecolabel',
        placementOrSlot: 'home_hero',
        startAt: '2026-11-01T00:00:00Z',
        endAt: '2026-11-15T23:59:59Z',
        config: { imageUrl: '/images/hero-otono.webp', ctaText: 'Ver oferta' },
        now: FIXTURE_NOW
      })
      expect(bannerLink.id).toBeDefined()

      // Link 2: Promoción
      const promoLink = await linkCampaignAsset(world.db, {
        commandId: 'cmd-link-promo-01',
        actorId: MKT_MGR_IDENTITY,
        campaignId: campaign.id,
        assetType: 'promotion',
        assetId: 'promo-desc-15-otono',
        assetName: '15% de Descuento en Gama Eco',
        placementOrSlot: 'checkout_coupon',
        startAt: '2026-11-01T00:00:00Z',
        endAt: '2026-11-15T23:59:59Z',
        config: { discountPercent: 15, couponCode: 'ECO15' },
        now: FIXTURE_NOW
      })
      expect(promoLink.assetType).toBe('promotion')

      // Link 3: Modal
      const modalLink = await linkCampaignAsset(world.db, {
        commandId: 'cmd-link-modal-01',
        actorId: MKT_MGR_IDENTITY,
        campaignId: campaign.id,
        assetType: 'modal',
        assetId: 'modal-welcome-eco-sample',
        assetName: 'Modal Muestra Gratuita Desengrasante',
        placementOrSlot: 'storefront_popup',
        startAt: '2026-11-01T00:00:00Z',
        endAt: '2026-11-07T23:59:59Z',
        config: { triggerAfterSeconds: 5 },
        now: FIXTURE_NOW
      })
      expect(modalLink.assetType).toBe('modal')

      // Link 4: Email
      const emailLink = await linkCampaignAsset(world.db, {
        commandId: 'cmd-link-email-01',
        actorId: MKT_MGR_IDENTITY,
        campaignId: campaign.id,
        assetType: 'email',
        assetId: 'nl-dispatch-otono-01',
        assetName: 'Newsletter Lanzamiento Otoño Ecológico',
        placementOrSlot: 'email_newsletter_b2b',
        startAt: '2026-11-02T09:00:00Z',
        endAt: '2026-11-02T12:00:00Z',
        config: { templateId: 'tpl-b2b-launch' },
        now: FIXTURE_NOW
      })
      expect(emailLink.assetType).toBe('email')

      // Link 5: Landing
      const landingLink = await linkCampaignAsset(world.db, {
        commandId: 'cmd-link-landing-01',
        actorId: MKT_MGR_IDENTITY,
        campaignId: campaign.id,
        assetType: 'landing',
        assetId: 'landing-desengrasante-eco',
        assetName: 'Landing Page Especializada Hostelería',
        placementOrSlot: '/desengrasante-industrial-ecologico',
        startAt: '2026-11-01T00:00:00Z',
        endAt: '2026-11-15T23:59:59Z',
        config: { slug: 'desengrasante-industrial-ecologico' },
        now: FIXTURE_NOW
      })
      expect(landingLink.assetType).toBe('landing')

      // Retrieve full detail
      const detail = await getCommercialCampaignDetail(world.db, campaign.id)
      expect(detail.id).toBe(campaign.id)
      expect(detail.linkedAssets.length).toBe(5)
      expect(detail.linkedAssets.map((a) => a.assetType).sort()).toEqual([
        'banner',
        'email',
        'landing',
        'modal',
        'promotion'
      ])

      // Unlink an asset
      const unlinked = await unlinkCampaignAsset(world.db, {
        commandId: 'cmd-unlink-modal-01',
        actorId: MKT_MGR_IDENTITY,
        campaignId: campaign.id,
        assetId: modalLink.id,
        now: FIXTURE_NOW
      })
      expect(unlinked.unlinked).toBe(true)

      const detailAfterUnlink = await getCommercialCampaignDetail(world.db, campaign.id)
      expect(detailAfterUnlink.linkedAssets.length).toBe(4)
    })
  })

  describe('Commercial campaign conflict detection engine', () => {
    it('detects banner placement collision when two campaigns claim the same slot on overlapping dates', async () => {
      // Campaign A
      const campA = await createCommercialCampaign(world.db, {
        commandId: 'cmd-c1',
        actorId: MKT_MGR_IDENTITY,
        code: 'camp-black-friday-quimicos',
        name: 'Black Friday Químicos',
        channelType: 'web',
        targetAudience: 'all',
        priority: 90,
        startAt: '2026-11-20T00:00:00Z',
        endAt: '2026-11-30T23:59:59Z',
        now: FIXTURE_NOW
      })

      await linkCampaignAsset(world.db, {
        commandId: 'cmd-c1-banner',
        actorId: MKT_MGR_IDENTITY,
        campaignId: campA.id,
        assetType: 'banner',
        assetId: 'b-bf-01',
        assetName: 'Banner Hero BF',
        placementOrSlot: 'home_hero',
        startAt: '2026-11-20T00:00:00Z',
        endAt: '2026-11-30T23:59:59Z',
        config: {},
        now: FIXTURE_NOW
      })

      // Campaign B (overlapping dates and identical slot home_hero!)
      const campB = await createCommercialCampaign(world.db, {
        commandId: 'cmd-c2',
        actorId: MKT_MGR_IDENTITY,
        code: 'camp-cyber-monday-adelantado',
        name: 'Cyber Monday Adelantado',
        channelType: 'web',
        targetAudience: 'all',
        priority: 70,
        startAt: '2026-11-25T00:00:00Z',
        endAt: '2026-12-02T23:59:59Z',
        now: FIXTURE_NOW
      })

      await linkCampaignAsset(world.db, {
        commandId: 'cmd-c2-banner',
        actorId: MKT_MGR_IDENTITY,
        campaignId: campB.id,
        assetType: 'banner',
        assetId: 'b-cm-01',
        assetName: 'Banner Hero Cyber Monday',
        placementOrSlot: 'home_hero',
        startAt: '2026-11-25T00:00:00Z',
        endAt: '2026-12-02T23:59:59Z',
        config: {},
        now: FIXTURE_NOW
      })

      // Query conflicts
      const conflicts = await detectCampaignConflictsInPeriod(world.db, {
        startAt: '2026-11-01T00:00:00Z',
        endAt: '2026-11-30T23:59:59Z'
      })

      expect(conflicts.length).toBeGreaterThan(0)
      const bannerConflict = conflicts.find((c) => c.type === 'banner_slot_overlap')
      expect(bannerConflict).toBeDefined()
      expect(bannerConflict?.severity).toBe('critical')
      expect(bannerConflict?.placementOrSlot).toBe('home_hero')
    })

    it('detects modal popup collision and email fatigue clashes', () => {
      const campaigns = [
        {
          id: 'c1',
          code: 'c1',
          name: 'Campaña 1',
          startAt: '2026-11-10T00:00:00Z',
          endAt: '2026-11-20T23:59:59Z',
          targetAudience: 'b2b'
        },
        {
          id: 'c2',
          code: 'c2',
          name: 'Campaña 2',
          startAt: '2026-11-12T00:00:00Z',
          endAt: '2026-11-18T23:59:59Z',
          targetAudience: 'b2b'
        }
      ]

      const assets = [
        // Modal collision
        {
          id: 'a1',
          campaignId: 'c1',
          assetType: 'modal' as const,
          assetId: 'm1',
          assetName: 'Modal 1',
          placementOrSlot: 'storefront_popup',
          startAt: '2026-11-10T00:00:00Z',
          endAt: '2026-11-15T23:59:59Z'
        },
        {
          id: 'a2',
          campaignId: 'c2',
          assetType: 'modal' as const,
          assetId: 'm2',
          assetName: 'Modal 2',
          placementOrSlot: 'storefront_popup',
          startAt: '2026-11-12T00:00:00Z',
          endAt: '2026-11-17T23:59:59Z'
        },
        // Email clash (same day for same audience)
        {
          id: 'a3',
          campaignId: 'c1',
          assetType: 'email' as const,
          assetId: 'e1',
          assetName: 'Email 1',
          placementOrSlot: 'newsletter',
          startAt: '2026-11-14T09:00:00Z',
          endAt: '2026-11-14T11:00:00Z'
        },
        {
          id: 'a4',
          campaignId: 'c2',
          assetType: 'email' as const,
          assetId: 'e2',
          assetName: 'Email 2',
          placementOrSlot: 'newsletter',
          startAt: '2026-11-14T15:00:00Z',
          endAt: '2026-11-14T17:00:00Z'
        }
      ]

      const detected = detectCommercialCampaignConflicts(campaigns, assets)
      expect(detected.some((c) => c.type === 'modal_collision')).toBe(true)
      expect(detected.some((c) => c.type === 'email_schedule_fatigue')).toBe(true)
    })
  })

  describe('Commercial Calendar View with Madrid month boundaries and visible conflict badges', () => {
    it('generates commercial calendar feed with active campaigns, assets and flagged date conflicts', async () => {
      // Create campaign for November
      const camp = await createCommercialCampaign(world.db, {
        commandId: 'cmd-cal-01',
        actorId: ADMIN_IDENTITY,
        code: 'camp-noviembre-2026',
        name: 'Campaña Mes de Noviembre',
        channelType: 'omnichannel',
        targetAudience: 'all',
        priority: 60,
        startAt: '2026-11-05T00:00:00Z',
        endAt: '2026-11-25T23:59:59Z',
        now: FIXTURE_NOW
      })

      await linkCampaignAsset(world.db, {
        commandId: 'cmd-cal-banner-01',
        actorId: ADMIN_IDENTITY,
        campaignId: camp.id,
        assetType: 'banner',
        assetId: 'b-nov-01',
        assetName: 'Banner General',
        placementOrSlot: 'home_hero',
        startAt: '2026-11-05T00:00:00Z',
        endAt: '2026-11-25T23:59:59Z',
        config: {},
        now: FIXTURE_NOW
      })

      const calendarFeed = await getCommercialCalendarFeed(world.db, {
        month: '2026-11',
        now: FIXTURE_NOW
      })

      expect(calendarFeed.month).toBe('2026-11')
      expect(calendarFeed.campaigns.length).toBeGreaterThan(0)
      expect(calendarFeed.days.length).toBeGreaterThanOrEqual(28)
      expect(calendarFeed.days.some((d) => d.campaignsCount > 0)).toBe(true)
    })
  })
})
