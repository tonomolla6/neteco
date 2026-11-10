import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminCommercialCampaignManager from '../../app/components/AdminCommercialCampaignManager.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

describe('AdminCommercialCampaignManager.vue (ADM-026)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.request.mockImplementation((url: string) => {
      if (url.includes('/api/admin/campaigns/calendar')) {
        return Promise.resolve({
          month: '2026-11',
          campaigns: [],
          days: [
            {
              date: '2026-11-01',
              campaignsCount: 1,
              campaigns: [{ id: 'c1', name: 'Black Friday Químicos', priority: 90, status: 'active' }],
              assets: [{ id: 'a1', campaignId: 'c1', assetType: 'banner', assetName: 'Hero 1' }],
              conflicts: []
            }
          ],
          activeConflicts: [
            {
              conflictId: 'conf-1',
              type: 'banner_slot_overlap',
              severity: 'critical',
              message: "Colisión en slot de banner 'home_hero'",
              placementOrSlot: 'home_hero',
              campaignA: {
                id: 'c1',
                code: 'c1',
                name: 'Camp 1',
                startAt: '2026-11-01T00:00:00Z',
                endAt: '2026-11-10T23:59:59Z'
              },
              campaignB: {
                id: 'c2',
                code: 'c2',
                name: 'Camp 2',
                startAt: '2026-11-05T00:00:00Z',
                endAt: '2026-11-15T23:59:59Z'
              }
            }
          ]
        })
      }
      if (url === '/api/admin/campaigns') {
        return Promise.resolve({
          campaigns: [
            {
              id: 'c1',
              code: 'camp-otono-2026',
              name: 'Campaña Desengrasantes Otoño',
              description: 'Gama ecológica industrial',
              status: 'active',
              channelType: 'omnichannel',
              targetAudience: 'b2b',
              priority: 75,
              startAt: '2026-11-01T00:00:00Z',
              endAt: '2026-11-15T23:59:59Z',
              version: 1,
              createdAt: '2026-10-29T12:00:00Z',
              updatedAt: '2026-10-29T12:00:00Z'
            }
          ]
        })
      }
      if (url.includes('/api/admin/campaigns/c1')) {
        return Promise.resolve({
          id: 'c1',
          code: 'camp-otono-2026',
          name: 'Campaña Desengrasantes Otoño',
          description: 'Gama ecológica industrial',
          status: 'active',
          channelType: 'omnichannel',
          targetAudience: 'b2b',
          priority: 75,
          startAt: '2026-11-01T00:00:00Z',
          endAt: '2026-11-15T23:59:59Z',
          version: 1,
          createdAt: '2026-10-29T12:00:00Z',
          updatedAt: '2026-10-29T12:00:00Z',
          linkedAssets: [
            {
              id: 'a1',
              campaignId: 'c1',
              assetType: 'banner',
              assetId: 'banner-hero-5l',
              assetName: 'Banner Hero 5L',
              placementOrSlot: 'home_hero',
              startAt: '2026-11-01T00:00:00Z',
              endAt: '2026-11-15T23:59:59Z',
              status: 'linked'
            },
            {
              id: 'a2',
              campaignId: 'c1',
              assetType: 'landing',
              assetId: 'landing-eco',
              assetName: 'Landing Hostelería',
              placementOrSlot: '/desengrasante-eco',
              startAt: '2026-11-01T00:00:00Z',
              endAt: '2026-11-15T23:59:59Z',
              status: 'linked'
            }
          ],
          conflicts: []
        })
      }
      return Promise.resolve({})
    })
  })

  it('renders campaigns and linked assets', async () => {
    const wrapper = await mountSuspended(AdminCommercialCampaignManager)
    await flushPromises()

    expect(wrapper.text()).toContain('Gestor de Campañas y Calendario Comercial')
    expect(wrapper.text()).toContain('Campaña Desengrasantes Otoño')
    expect(wrapper.text()).toContain('camp-otono-2026')

    // Click on campaign to load detail
    const campaignItem = wrapper.findAll('li').find((li) => li.text().includes('camp-otono-2026'))
    await campaignItem?.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Banner Hero 5L')
    expect(wrapper.text()).toContain('Landing Hostelería')
  })

  it('renders conflict alert and switches to commercial calendar view', async () => {
    const wrapper = await mountSuspended(AdminCommercialCampaignManager)
    await flushPromises()

    // Conflict banner visible
    expect(wrapper.text()).toContain('Conflictos Comerciales y Colisiones de Fechas Detectados')
    expect(wrapper.text()).toContain("Colisión en slot de banner 'home_hero'")

    // Switch to calendar tab
    const calTab = wrapper.findAll('button').find((b) => b.text().includes('Calendario Comercial'))
    await calTab?.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Calendario comercial mensual')
  })
})
