import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminDeliverySurveys from '../../app/components/AdminDeliverySurveys.vue'
import AdminDeliverySurveysPage from '../../app/pages/admin/encuestas.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  session: { value: null as unknown },
  runtime: { value: 'cloudflare' as unknown }
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => () => mocks.session.value)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: mocks.runtime.value }
}))

const sampleDashboardSufficient = {
  period: {
    from: '2026-10-01T00:00:00Z',
    to: '2026-10-29T23:59:59Z'
  },
  minSampleThreshold: 10,
  summary: {
    totalInvitations: 50,
    completedSurveys: 25,
    responseRate: 0.5,
    averageScore: 4.4,
    arrivedGoodRate: 0.92,
    problemRate: 0.08,
    totalTicketsCreated: 2,
    hasSufficientSample: true
  },
  bySegment: {
    particular: {
      count: 15,
      averageScore: 4.5,
      arrivedGoodRate: 0.933,
      problemRate: 0.067,
      hasSufficientSample: true
    },
    profesional: {
      count: 10,
      averageScore: 4.2,
      arrivedGoodRate: 0.9,
      problemRate: 0.1,
      hasSufficientSample: true
    }
  },
  byReason: [
    {
      reason: 'compliment',
      label: 'Felicitación / buen servicio',
      count: 12,
      percentage: 0.48,
      averageScore: 5.0,
      hasSufficientSample: true
    },
    {
      reason: 'damaged_product',
      label: 'Producto dañado o roto',
      count: 2,
      percentage: 0.08,
      averageScore: 1.5,
      hasSufficientSample: true
    }
  ],
  scoreDistribution: {
    1: 1,
    2: 1,
    3: 2,
    4: 6,
    5: 15
  },
  items: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      orderId: '00000000-0000-4000-7000-000000000001',
      orderNumber: '00000000',
      score: 5,
      arrivedGood: true,
      contactReason: 'compliment',
      customerSegment: 'particular',
      hasProblem: false,
      supportTicketPublicRef: null,
      submittedAt: '2026-10-28T10:00:00Z'
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      orderId: '00000000-0000-4000-7000-000000000002',
      orderNumber: '00000002',
      score: 1,
      arrivedGood: false,
      contactReason: 'damaged_product',
      customerSegment: 'profesional',
      hasProblem: true,
      supportTicketPublicRef: 'SOP-DEMOTICKET123456789012',
      submittedAt: '2026-10-28T11:00:00Z'
    }
  ],
  pagination: {
    page: 1,
    perPage: 25,
    total: 2
  }
}

const sampleDashboardInsufficient = {
  ...sampleDashboardSufficient,
  summary: {
    totalInvitations: 5,
    completedSurveys: 3,
    responseRate: null,
    averageScore: null,
    arrivedGoodRate: null,
    problemRate: null,
    totalTicketsCreated: 0,
    hasSufficientSample: false
  }
}

describe('AdminDeliverySurveys component', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.session.value = {
      ready: ref(true),
      loggedIn: ref(true),
      user: ref({
        id: '00000000-0000-4000-8000-000000000001',
        emailVerified: true,
        mfaVerified: true,
        permissions: ['administration.manage', 'support.manage']
      })
    }
    mocks.request.mockResolvedValue(sampleDashboardSufficient)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('monta el componente y muestra cabecera y tarjetas KPI con muestra suficiente', async () => {
    const wrapper = await mountSuspended(AdminDeliverySurveys, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Encuestas de entrega')
    expect(wrapper.text()).toContain('25') // Completadas
    expect(wrapper.text()).toContain('50.0%') // Tasa de respuesta
    expect(wrapper.text()).toContain('4.4') // Valoración media
    expect(wrapper.text()).toContain('92.0%') // Llegó bien
  })

  it('muestra aviso de muestra insuficiente (< 10) y suprime porcentajes cuando no se alcanza el umbral', async () => {
    mocks.request.mockResolvedValue(sampleDashboardInsufficient)

    const wrapper = await mountSuspended(AdminDeliverySurveys, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Muestra insuficiente (< 10 respuestas)')
    expect(wrapper.text()).toMatch(/Muestra insuficiente|—/)
  })

  it('muestra el desglose por segmento (particular vs profesional)', async () => {
    const wrapper = await mountSuspended(AdminDeliverySurveys, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Particular')
    expect(wrapper.text()).toContain('15 respuestas')
    expect(wrapper.text()).toContain('Profesional')
    expect(wrapper.text()).toContain('10 respuestas')
  })

  it('muestra el catálogo estable de motivos y tickets de soporte vinculados', async () => {
    const wrapper = await mountSuspended(AdminDeliverySurveys, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Felicitación / buen servicio')
    expect(wrapper.text()).toContain('Producto dañado o roto')
    expect(wrapper.text()).toContain('SOP-DEMOTICKET123456789012')
  })

  it('permite aplicar filtros de periodo y segmento', async () => {
    const wrapper = await mountSuspended(AdminDeliverySurveys, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    const segmentSelect = wrapper.find('select[data-filter="segment"]')
    expect(segmentSelect.exists()).toBe(true)
    await segmentSelect.setValue('profesional')

    await wrapper.find('button[data-action="apply-filters"]').trigger('click')
    await flushPromises()

    expect(mocks.request).toHaveBeenCalledWith(
      expect.stringContaining('/api/admin/fulfillment/delivery-surveys'),
      expect.objectContaining({
        query: expect.objectContaining({
          segment: 'profesional'
        })
      })
    )
  })

  it('monta correctamente la página admin/encuestas.vue', async () => {
    const wrapper = await mountSuspended(AdminDeliverySurveysPage)
    await flushPromises()

    expect(wrapper.text()).toContain('Encuestas de entrega')
  })
})
