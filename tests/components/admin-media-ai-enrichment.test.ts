import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminMediaAiEnrichment from '../../app/components/AdminMediaAiEnrichment.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  runtime: 'cloudflare'
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: mocks.runtime }
}))

const mockEnrichment = {
  id: 'enrich-1111-2222-3333-444444444444',
  assetId: 'asset-00000000-0000-4000-8000-000000000001',
  enrichmentType: 'full_visual_enrichment',
  backgroundRemoval: {
    maskDescription: 'Máscara perimetral de recorte limpio',
    alphaCutoutStorageKey: 'media/cutouts/asset-1-alpha.png',
    backgroundType: 'transparent',
    edgeAccuracyScore: 0.98,
    noPackagingInvented: true
  },
  proposedCrops: [
    { ratio: '1:1', purpose: 'catalog_thumbnail', x: 0, y: 0, width: 800, height: 800 },
    { ratio: '4:3', purpose: 'gallery_main', x: 0, y: 50, width: 800, height: 600 }
  ],
  proposedMetadata: {
    suggestedAltText: 'Garrafa blanca de 5L de producto desengrasante',
    dominantColors: ['#FFFFFF', '#1E3A8A'],
    focalPoint: { x: 0.5, y: 0.5 },
    noFictionalClaimsOrBadges: true
  },
  prohibitedInventionCheck: {
    passed: true,
    noInventedPackaging: true,
    noInventedClaims: true,
    noInventedUses: true,
    flaggedTokens: []
  },
  requiresHumanApproval: true,
  approvalStatus: 'pending_approval',
  version: 1
}

describe('AdminMediaAiEnrichment component (MED-023)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.request.mockImplementation(async (url: string) => {
      if (url.includes('/api/admin/media/ai-enrich/propose')) {
        return { enrichment: mockEnrichment }
      }
      if (url.includes('/decision')) {
        return {
          enrichment: {
            ...mockEnrichment,
            approvalStatus: 'approved',
            humanDecidedAt: '2026-10-29T12:00:00Z',
            version: 2
          }
        }
      }
      if (url.includes('/apply')) {
        return { applied: true, assetId: mockEnrichment.assetId }
      }
      throw new Error(`Unhandled URL: ${url}`)
    })
  })

  it('renders enrichment options, executes proposal and displays background removal & crops', async () => {
    const wrapper = await mountSuspended(AdminMediaAiEnrichment, {
      props: { assetId: mockEnrichment.assetId }
    })
    await flushPromises()

    const proposeBtn = wrapper.find('button[data-test="propose-enrichment-btn"]')
    expect(proposeBtn.exists()).toBe(true)
    await proposeBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Propuesta de Enriquecimiento Visual')
    expect(wrapper.text()).toContain('Eliminación de fondo propuesta')
    expect(wrapper.text()).toContain('Recortes propuestos (Crops)')
    expect(wrapper.text()).toContain('Garrafa blanca de 5L')
    expect(wrapper.text()).toContain('Sin invención de envases ni claims')
  })

  it('supports human approval decision before applying to asset', async () => {
    const wrapper = await mountSuspended(AdminMediaAiEnrichment, {
      props: { assetId: mockEnrichment.assetId }
    })
    await flushPromises()

    await wrapper.find('button[data-test="propose-enrichment-btn"]').trigger('click')
    await flushPromises()

    const approveBtn = wrapper.find('button[data-test="approve-enrichment-btn"]')
    expect(approveBtn.exists()).toBe(true)
    await approveBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Enriquecimiento Aprobado')

    const applyBtn = wrapper.find('button[data-test="apply-enrichment-btn"]')
    expect(applyBtn.exists()).toBe(true)
    await applyBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Aplicado al activo multimedia')
  })
})
