import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createBaTestWorld,
  MKT_MGR_IDENTITY,
  UNPRIVILEGED_IDENTITY,
  FIXTURE_NOW,
  type BaTestWorld
} from './d1-ba-preview-diff-fixtures'
import {
  createSeasonalSectorCampaign,
  updateSeasonalSectorCampaign,
  setSeasonalCampaignStatus,
  saveSeasonalCampaignPostmortem,
  approveSeasonalCampaignPostmortem,
  getSeasonalSectorCampaignDetail,
  getSeasonalCampaignCalendar
} from '../../workers/marketing/seasonal-campaigns'

describe('MKT-032: Calendario de campañas estacionales por sector y postmortem', () => {
  let world: BaTestWorld

  beforeEach(async () => {
    world = await createBaTestWorld()
    // Apply migration 0143
    const migrationSql = await readFile('db/d1/migrations/0143_seasonal_sector_campaigns.sql', 'utf8')
    world.sqlite.exec(migrationSql)
  })

  afterEach(() => world.close())

  const validPillars = {
    need: {
      needJustification:
        'Preparación integral de terrazas y cocinas de hostelería ante la temporada de primavera-verano.',
      targetCustomerProfile: 'horeca_operators' as const
    },
    window: {
      procurementStartAt: '2027-02-01T00:00:00Z',
      windowStartAt: '2027-03-01T00:00:00Z',
      windowEndAt: '2027-04-30T23:59:59Z'
    },
    inventory: {
      items: [
        {
          sku: 'DESENG-IND-05L',
          variantId: 'v-deseng-05l',
          plannedUnits: 1200,
          safetyStockUnits: 200,
          maxAllocationUnits: 2000
        },
        {
          sku: 'LAVAVAJ-ECO-10L',
          variantId: 'v-lavavaj-10l',
          plannedUnits: 800,
          safetyStockUnits: 150,
          maxAllocationUnits: 1500
        }
      ],
      bufferPercentage: 15
    },
    logistics: {
      allowedProfiles: ['parcel', 'pallet'] as ('parcel' | 'pallet')[],
      carrierNotes: 'Priorizar entregas matinales antes de apertura de restaurantes (09:00 - 12:00)',
      packagingGuidelines: 'Cajas reforzadas con precinto de seguridad antifuga química',
      maxLeadTimeDays: 3,
      localDeliveryPriority: true
    },
    content: {
      landingSlug: 'primavera-hosteleria-2027',
      bannerSlots: ['home_hero', 'category_horeca_header'],
      emailCampaignCode: 'EML-HORECA-SPRING-27',
      marketingTags: ['hosteleria', 'primavera', 'desengrasantes', 'ecolabel']
    },
    margin: {
      targetRevenueCents: 4500000, // 45.000 €
      budgetLimitCents: 350000, // 3.500 €
      minMarginBasisPoints: 2200, // 22%
      maxDiscountBasisPoints: 1500 // 15%
    }
  }

  describe('Campaign Lifecycle and 6-Pillar Coordination', () => {
    it('creates, retrieves, and coordinates all 6 pillars successfully', async () => {
      const campaign = await createSeasonalSectorCampaign(world.db, {
        commandId: 'cmd-seasonal-create-01',
        actorId: MKT_MGR_IDENTITY,
        code: 'camp-horeca-primavera-2027',
        name: 'Puesta a punto terrazas y cocinas HORECA 2027',
        sector: 'horeca',
        season: 'spring',
        year: 2027,
        ...validPillars,
        now: FIXTURE_NOW
      })

      expect(campaign.id).toBeDefined()
      expect(campaign.status).toBe('draft')
      expect(campaign.sector).toBe('horeca')
      expect(campaign.season).toBe('spring')
      expect(campaign.need.needJustification).toContain('terrazas')
      expect(campaign.inventory.items).toHaveLength(2)
      expect(campaign.logistics.allowedProfiles).toContain('pallet')
      expect(campaign.margin.minMarginBasisPoints).toBe(2200)

      // Retrieve full detail
      const detail = await getSeasonalSectorCampaignDetail(world.db, campaign.id)
      expect(detail).toBeDefined()
      expect(detail?.code).toBe('camp-horeca-primavera-2027')
      expect(detail?.coordination.isFullyCoordinated).toBe(true)
      expect(detail?.coordination.missingPillars).toHaveLength(0)
    })

    it('activates campaign when fully coordinated and prevents activation if uncoordinated', async () => {
      // Create campaign missing content landing and banners
      const partialPillars = {
        ...validPillars,
        content: {
          bannerSlots: [],
          marketingTags: []
        }
      }

      const campaign = await createSeasonalSectorCampaign(world.db, {
        commandId: 'cmd-seasonal-uncoordinated-01',
        actorId: MKT_MGR_IDENTITY,
        code: 'camp-healthcare-desinf-2027',
        name: 'Desinfección Clínica Prevención Sanitaria',
        sector: 'healthcare',
        season: 'winter',
        year: 2027,
        ...partialPillars,
        now: FIXTURE_NOW
      })

      // Attempting to activate an uncoordinated campaign must fail
      await expect(
        setSeasonalCampaignStatus(world.db, {
          commandId: 'cmd-status-fail-01',
          actorId: MKT_MGR_IDENTITY,
          campaignId: campaign.id,
          expectedVersion: 1,
          status: 'active',
          now: FIXTURE_NOW
        })
      ).rejects.toThrowError(/uncoordinated_campaign/)

      // Now update with complete content
      await updateSeasonalSectorCampaign(world.db, {
        commandId: 'cmd-update-coord-01',
        actorId: MKT_MGR_IDENTITY,
        campaignId: campaign.id,
        expectedVersion: 1,
        content: validPillars.content,
        now: FIXTURE_NOW
      })

      // Now activation succeeds under CAS version 2
      const activated = await setSeasonalCampaignStatus(world.db, {
        commandId: 'cmd-status-success-01',
        actorId: MKT_MGR_IDENTITY,
        campaignId: campaign.id,
        expectedVersion: 2,
        status: 'active',
        now: FIXTURE_NOW
      })

      expect(activated.status).toBe('active')
      expect(activated.version).toBe(3)
    })

    it('enforces CAS version concurrency check on update', async () => {
      const campaign = await createSeasonalSectorCampaign(world.db, {
        commandId: 'cmd-seasonal-cas-01',
        actorId: MKT_MGR_IDENTITY,
        code: 'camp-industrial-deseng-2027',
        name: 'Limpieza Técnica Industrial',
        sector: 'industrial',
        season: 'autumn',
        year: 2027,
        ...validPillars,
        now: FIXTURE_NOW
      })

      // Wrong version throws version_conflict
      await expect(
        updateSeasonalSectorCampaign(world.db, {
          commandId: 'cmd-cas-fail-01',
          actorId: MKT_MGR_IDENTITY,
          campaignId: campaign.id,
          expectedVersion: 999,
          name: 'Nombre modificado',
          now: FIXTURE_NOW
        })
      ).rejects.toThrowError(/version_conflict/)
    })

    it('idempotency: replaying same command returns existing entity without duplicates', async () => {
      const input = {
        commandId: 'cmd-idempotent-01',
        actorId: MKT_MGR_IDENTITY,
        code: 'camp-facility-colegios-2027',
        name: 'Vuelta al Cole Facility Services 2027',
        sector: 'facility_services' as const,
        season: 'autumn' as const,
        year: 2027,
        ...validPillars,
        now: FIXTURE_NOW
      }

      const first = await createSeasonalSectorCampaign(world.db, input)
      const second = await createSeasonalSectorCampaign(world.db, input)

      expect(first.id).toBe(second.id)
      expect(first.code).toBe(second.code)
    })

    it('checks permissions: unprivileged identity is rejected with forbidden', async () => {
      await expect(
        createSeasonalSectorCampaign(world.db, {
          commandId: 'cmd-unauth-01',
          actorId: UNPRIVILEGED_IDENTITY,
          code: 'camp-unauth-01',
          name: 'Campaña no autorizada',
          sector: 'horeca',
          season: 'spring',
          year: 2027,
          ...validPillars,
          now: FIXTURE_NOW
        })
      ).rejects.toThrowError(/forbidden/)
    })
  })

  describe('Postmortem por campaña', () => {
    it('records and approves detailed postmortem with metrics, learnings and action items', async () => {
      const campaign = await createSeasonalSectorCampaign(world.db, {
        commandId: 'cmd-camp-postmortem-01',
        actorId: MKT_MGR_IDENTITY,
        code: 'camp-verano-piscinas-2026',
        name: 'Tratamiento de Aguas y Piscinas Verano 2026',
        sector: 'facility_services',
        season: 'summer',
        year: 2026,
        ...validPillars,
        now: FIXTURE_NOW
      })

      // Complete the campaign
      await setSeasonalCampaignStatus(world.db, {
        commandId: 'cmd-complete-camp-01',
        actorId: MKT_MGR_IDENTITY,
        campaignId: campaign.id,
        expectedVersion: 1,
        status: 'completed',
        now: FIXTURE_NOW
      })

      // Save Postmortem
      const postmortem = await saveSeasonalCampaignPostmortem(world.db, {
        commandId: 'cmd-save-postmortem-01',
        actorId: MKT_MGR_IDENTITY,
        campaignId: campaign.id,
        expectedVersion: 0, // new postmortem
        actualRevenueCents: 5200000, // 52.000 € (exceeded target 45.000 €)
        actualMarginBasisPoints: 2450, // 24.5% (target was 22%)
        targetMarginAchieved: true,
        stockoutOccurred: false,
        stockoutDetails: 'Sin roturas de stock. El buffer de seguridad del 15% absorbió los picos de demanda.',
        logisticsIncidentsCount: 1,
        logisticsIncidentNotes: 'Un retraso puntual de 24h en entrega paletizada por festivo local en Alicante.',
        contentPerformanceScore: 92,
        roiBasisPoints: 480, // ROI del 48% sobre presupuesto
        keyLearnings:
          'La concentración del aprovisionamiento en febrero permitió evitar la subida de precios de materias primas en abril. Para 2027 ampliar gama de dosificadores automáticos.',
        actionItems: [
          {
            id: 'act-01',
            title: 'Negociar reserva de cloro con proveedor antes de diciembre 2026',
            owner: 'Compras',
            dueDate: '2026-12-15',
            status: 'open'
          },
          {
            id: 'act-02',
            title: 'Revisar transportista de palé para rutas de costa en temporada alta',
            owner: 'Logística',
            dueDate: '2027-01-30',
            status: 'open'
          }
        ],
        now: FIXTURE_NOW
      })

      expect(postmortem.id).toBeDefined()
      expect(postmortem.status).toBe('draft')
      expect(postmortem.actualRevenueCents).toBe(5200000)
      expect(postmortem.targetMarginAchieved).toBe(true)
      expect(postmortem.actionItems).toHaveLength(2)

      // Approve Postmortem
      const approved = await approveSeasonalCampaignPostmortem(world.db, {
        commandId: 'cmd-approve-postmortem-01',
        actorId: MKT_MGR_IDENTITY,
        postmortemId: postmortem.id,
        expectedVersion: 1,
        now: FIXTURE_NOW
      })

      expect(approved.status).toBe('approved')
      expect(approved.version).toBe(2)

      // Detail includes postmortem
      const detail = await getSeasonalSectorCampaignDetail(world.db, campaign.id)
      expect(detail?.postmortem).toBeDefined()
      expect(detail?.postmortem?.status).toBe('approved')
      expect(detail?.postmortem?.actualMarginBasisPoints).toBe(2450)
    })
  })

  describe('Calendar Feed & Filtering by Sector and Season', () => {
    it('returns filtered calendar view with sector badges and active windows', async () => {
      // Seed two campaigns in different sectors
      await createSeasonalSectorCampaign(world.db, {
        commandId: 'cmd-cal-01',
        actorId: MKT_MGR_IDENTITY,
        code: 'camp-horeca-navidad-2026',
        name: 'Campana HORECA Cenas de Navidad',
        sector: 'horeca',
        season: 'winter',
        year: 2026,
        ...validPillars,
        now: FIXTURE_NOW
      })

      await createSeasonalSectorCampaign(world.db, {
        commandId: 'cmd-cal-02',
        actorId: MKT_MGR_IDENTITY,
        code: 'camp-educacion-vuelta-2026',
        name: 'Campaña Higiene y Desinfección Escolar',
        sector: 'education',
        season: 'autumn',
        year: 2026,
        ...validPillars,
        now: FIXTURE_NOW
      })

      // Query all 2026
      const feedAll = await getSeasonalCampaignCalendar(world.db, { year: 2026 })
      expect(feedAll.campaigns).toHaveLength(2)
      expect(feedAll.sectorsRepresented).toContain('horeca')
      expect(feedAll.sectorsRepresented).toContain('education')

      // Filter by sector = horeca
      const feedHoreca = await getSeasonalCampaignCalendar(world.db, { year: 2026, sector: 'horeca' })
      expect(feedHoreca.campaigns).toHaveLength(1)
      expect(feedHoreca.campaigns[0]?.sector).toBe('horeca')
    })
  })
})
