import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import AdminSemanticSearchEvaluation from '../../app/components/AdminSemanticSearchEvaluation.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  runtime: { value: 'cloudflare' as unknown }
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: mocks.runtime.value }
}))

const sampleBenchmark = {
  totalQueries: 5,
  totalJudgments: 12,
  ndcgAt5: 0.885,
  ndcgAt10: 0.912,
  precisionAt5: 0.8,
  mrr: 0.95,
  semanticCoverage: 1.0
}

const sampleEvaluations = [
  {
    id: 'eval-1',
    version: 1,
    queryNormalized: 'desengrasante hornos',
    productId: '10000000-0000-4000-8000-000000000001',
    relevanceScore: 4,
    notes: 'Ajuste perfecto',
    evaluatorId: 'eval-user-1',
    status: 'active' as const,
    createdAt: '2026-10-15T12:00:00Z',
    updatedAt: '2026-10-15T12:00:00Z'
  }
]

describe('AdminSemanticSearchEvaluation component (SEA-019)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders benchmark cards, evaluations list and semantic search workbench', async () => {
    mocks.request.mockImplementation((url: string) => {
      if (url === '/api/admin/search-evaluations/benchmark') {
        return Promise.resolve(sampleBenchmark)
      }
      if (url === '/api/admin/search-evaluations') {
        return Promise.resolve({ items: sampleEvaluations, total: 1 })
      }
      return Promise.resolve({})
    })

    const wrapper = await mountSuspended(AdminSemanticSearchEvaluation, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Evaluación humana de búsqueda semántica (SEA-019)')
    expect(wrapper.text()).toContain('88.5%') // NDCG@5
    expect(wrapper.text()).toContain('80.0%') // Precision@5
    expect(wrapper.text()).toContain('0.950') // MRR
    expect(wrapper.text()).toContain('desengrasante hornos')
    expect(wrapper.text()).toContain('4 / 4')
  })

  it('renders error state with accessible alert when fetch fails', async () => {
    mocks.request.mockRejectedValue(new Error('Network error'))

    const wrapper = await mountSuspended(AdminSemanticSearchEvaluation, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    const alert = wrapper.find('[role="alert"]')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toContain('No se ha podido cargar el panel de evaluación humana')
  })

  it('renders empty state when no evaluations exist', async () => {
    mocks.request.mockImplementation((url: string) => {
      if (url === '/api/admin/search-evaluations/benchmark') {
        return Promise.resolve({ ...sampleBenchmark, totalJudgments: 0, totalQueries: 0 })
      }
      if (url === '/api/admin/search-evaluations') {
        return Promise.resolve({ items: [], total: 0 })
      }
      return Promise.resolve({})
    })

    const wrapper = await mountSuspended(AdminSemanticSearchEvaluation, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('No hay evaluaciones humanas registradas todavía')
  })
})
