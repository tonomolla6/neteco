import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminSeoTechnicalPanel from '../../app/components/AdminSeoTechnicalPanel.vue'
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

const mockCrawlRuns = [
  {
    id: 'run-00000000-0000-4000-8000-000000000001',
    status: 'completed',
    triggerType: 'scheduled',
    totalUrlsScanned: 42,
    status2xxCount: 38,
    status4xxCount: 2,
    status5xxCount: 1,
    canonicalIssuesCount: 3,
    noindexCount: 2,
    missingSchemaCount: 1,
    orphanCount: 1,
    maxDepthReached: 3,
    accidentalChangesCount: 1,
    startedAt: '2026-10-29T10:00:00Z',
    completedAt: '2026-10-29T10:02:00Z'
  }
]

const mockIssues = [
  {
    id: 'issue-1',
    url: '/producto/descontinuado-antiguo',
    issueType: 'http_4xx',
    severity: 'critical' as const,
    details: { statusCode: 404 },
    createdAt: '2026-10-29T10:01:00Z'
  },
  {
    id: 'issue-2',
    url: '/categorias/limpieza-sin-canon',
    issueType: 'canonical_missing',
    severity: 'warning' as const,
    details: { message: 'Missing canonical' },
    createdAt: '2026-10-29T10:01:30Z'
  }
]

const mockBotSummary = {
  totalCrawls: 150,
  verifiedBotCrawls: 120,
  fakeBotCrawls: 15,
  unverifiedCrawls: 15,
  wasteCrawls: 35,
  wastePercentage: 23.33,
  wasteByCategory: {
    none: 115,
    disallowed_url: 12,
    status_4xx: 10,
    status_5xx: 3,
    noindex_target: 5,
    parameter_duplicate: 5
  },
  topWastedUrls: [
    { path: '/buscar?q=lejia', hits: 12, wasteCategory: 'disallowed_url', statusCode: 200 },
    { path: '/producto/roto', hits: 10, wasteCategory: 'status_4xx', statusCode: 404 }
  ],
  errorRate4xx: 6.67,
  errorRate5xx: 2.0
}

const mockAiAnswer = {
  query: 'desengrasante industrial hornos',
  answerText: 'Recomendamos para hornos industriales el "Desengrasante Alcalino Potente 5L".',
  citations: [
    {
      productId: 'p1',
      slug: 'desengrasante-alcalino-5l',
      title: 'Desengrasante Alcalino Potente 5L',
      sku: 'NET-DES-005',
      priceCents: 2490,
      formattedPrice: '24.90 €',
      inStock: true,
      canonicalUrl: '/producto/desengrasante-alcalino-5l',
      relevanceSnippet: 'Limpiador desengrasante para hornos',
      safetyAdvice: 'Uso obligatorio de guantes y protección ocular.'
    }
  ],
  groundingScore: 0.85,
  isIndexable: false,
  noindexEnforced: true,
  canonicalUrl: '/categorias/desengrasantes'
}

describe('AdminSeoTechnicalPanel component', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.request.mockImplementation(async (url: string, opts?: { method?: string; body?: unknown }) => {
      if (url === '/api/admin/seo/crawl/runs') {
        return mockCrawlRuns
      }
      if (url.startsWith('/api/admin/seo/crawl/issues')) {
        return mockIssues
      }
      if (url === '/api/admin/seo/crawl/run' && opts?.method === 'POST') {
        return {
          ...mockCrawlRuns[0],
          id: 'run-new-001',
          totalUrlsScanned: 50
        }
      }
      if (url === '/api/admin/seo/bots/summary') {
        return mockBotSummary
      }
      if (url === '/api/admin/seo/bots/retention/sweep') {
        return { prunedCount: 14 }
      }
      if (url === '/api/admin/seo/ai/curated') {
        return []
      }
      if (url === '/api/search/ai' && opts?.method === 'POST') {
        return mockAiAnswer
      }
      return {}
    })
  })

  it('renders technical SEO crawler tab with metrics and issue breakdown', async () => {
    const wrapper = await mountSuspended(AdminSeoTechnicalPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('SEO Técnico, Crawl & Búsqueda IA')
    expect(wrapper.text()).toContain('Monitorización Técnica')
    expect(wrapper.text()).toContain('42') // URLs Analizadas
    expect(wrapper.text()).toContain('38') // 2xx Válidas
    expect(wrapper.text()).toContain('/producto/descontinuado-antiguo')
    expect(wrapper.text()).toContain('canonical_missing')
  })

  it('switches to bot logs tab and renders crawl waste summary and top wasted URLs', async () => {
    const wrapper = await mountSuspended(AdminSeoTechnicalPanel)
    await flushPromises()

    const botTab = wrapper.findAll('button[role="tab"]').find((btn) => btn.text().includes('Análisis Bots'))
    expect(botTab).toBeDefined()
    await botTab!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Total Rastreos')
    expect(wrapper.text()).toContain('150')
    expect(wrapper.text()).toContain('Bots Verificados')
    expect(wrapper.text()).toContain('120')
    expect(wrapper.text()).toContain('Bots Falsos / Spoofed')
    expect(wrapper.text()).toContain('15')
    expect(wrapper.text()).toContain('23.33%') // Waste percentage
    expect(wrapper.text()).toContain('/buscar?q=lejia')
  })

  it('switches to AI search tab and displays grounded answer with active catalog citations', async () => {
    const wrapper = await mountSuspended(AdminSeoTechnicalPanel)
    await flushPromises()

    const aiTab = wrapper.findAll('button[role="tab"]').find((btn) => btn.text().includes('Búsqueda IA'))
    expect(aiTab).toBeDefined()
    await aiTab!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Protección SEO Base Activa')
    expect(wrapper.text()).toContain('noindex, follow, noarchive')

    // Click "Consultar IA"
    const searchBtn = wrapper.findAll('button').find((btn) => btn.text().includes('Consultar IA'))
    expect(searchBtn).toBeDefined()
    await searchBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Grounding Score: 0.85')
    expect(wrapper.text()).toContain('Desengrasante Alcalino Potente 5L')
    expect(wrapper.text()).toContain('NET-DES-005')
    expect(wrapper.text()).toContain('24.90 €')
    expect(wrapper.text()).toContain('/producto/desengrasante-alcalino-5l')
  })

  it('triggers technical crawl execution and displays success message', async () => {
    const wrapper = await mountSuspended(AdminSeoTechnicalPanel)
    await flushPromises()

    const crawlBtn = wrapper.findAll('button').find((btn) => btn.text().includes('Ejecutar Crawl Técnico'))
    expect(crawlBtn).toBeDefined()
    await crawlBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Crawl completado: 50 URLs analizadas')
  })
})
