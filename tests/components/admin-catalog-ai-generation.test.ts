import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminCatalogAiGeneration from '../../app/components/AdminCatalogAiGeneration.vue'
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

const mockGeneration = {
  id: 'gen-1111-2222-3333-444444444444',
  productId: 'prod-desengrasante-1',
  targetScope: 'full_editorial',
  prompt: 'Generar descripción técnica',
  sources: [
    {
      id: 'src-1',
      title: 'Ficha Técnica FDS-101',
      type: 'fds',
      verifiedClaims: ['Biodegradable OECD 301', 'pH 7.0'],
      textSnippet: 'Limpiador alcalino concentrado'
    }
  ],
  generatedTitle: 'Desengrasante Alcalino de Alta Gama',
  generatedShortDescription: 'Desengrasante multiusos potente.',
  generatedDescription: 'Fórmula profesional para eliminación de grasas.',
  generatedUsage: 'Diluir al 10% en agua tibia.',
  generatedAttributes: { pH: 7.0, dilucion: '1:10' },
  verifiableClaims: [
    {
      claimText: 'Biodegradable OECD 301',
      sourceRef: 'src-1',
      verified: true,
      hazardClpCompliant: true,
      category: 'eco'
    }
  ],
  duplicateCheck: {
    maxSimilarityScore: 0.12,
    duplicateRisk: 'none',
    matchedProducts: []
  },
  isAiGenerated: true,
  aiModelName: 'neteco-catalog-gen-v1',
  approvalStatus: 'pending_review',
  version: 1
}

describe('AdminCatalogAiGeneration component (ADM-033)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.request.mockImplementation(async (url: string) => {
      if (url.includes('/api/admin/catalog/ai-generate/propose')) {
        return { generation: mockGeneration }
      }
      if (url.includes('/review')) {
        return {
          generation: {
            ...mockGeneration,
            approvalStatus: 'approved',
            humanReviewedAt: '2026-10-29T12:00:00Z',
            version: 2
          }
        }
      }
      if (url.includes('/apply')) {
        return { applied: true, targetProductId: 'prod-desengrasante-1' }
      }
      throw new Error(`Unhandled URL: ${url}`)
    })
  })

  it('renders technical sources form and generated content with verifiable claims badge', async () => {
    const wrapper = await mountSuspended(AdminCatalogAiGeneration)
    await flushPromises()

    const nameInput = wrapper.find('input[data-test="product-name-input"]')
    expect(nameInput.exists()).toBe(true)
    await nameInput.setValue('Desengrasante Industrial')

    const submitBtn = wrapper.find('button[data-test="generate-content-btn"]')
    expect(submitBtn.exists()).toBe(true)

    await submitBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Contenido Generado por IA')
    expect(wrapper.text()).toContain('Biodegradable OECD 301')
    expect(wrapper.text()).toContain('Claims técnicos verificados')
  })

  it('handles review and application of approved content to catalog', async () => {
    const wrapper = await mountSuspended(AdminCatalogAiGeneration)
    await flushPromises()

    await wrapper.find('input[data-test="product-name-input"]').setValue('Desengrasante Industrial')
    await wrapper.find('button[data-test="generate-content-btn"]').trigger('click')
    await flushPromises()

    const reviewApproveBtn = wrapper.find('button[data-test="approve-content-btn"]')
    expect(reviewApproveBtn.exists()).toBe(true)

    await reviewApproveBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Revisión Aprobada')

    const applyBtn = wrapper.find('button[data-test="apply-content-btn"]')
    expect(applyBtn.exists()).toBe(true)
    await applyBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Contenido Aplicado al Catálogo')
  })
})
