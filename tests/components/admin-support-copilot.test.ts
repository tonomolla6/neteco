import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminSupportCopilot from '../../app/components/AdminSupportCopilot.vue'
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

const mockDraft = {
  interactionId: 'copilot-1111-1111-1111-111111111111',
  ticketId: 'ticket-1',
  contextSummary: 'Ticket de consulta logística para pedido ORD-1001. Pedido expedido con GLS el 2026-10-28.',
  proposedReply:
    'Estimado cliente, su pedido ORD-1001 se encuentra en tránsito con el transportista GLS [Cita 1]. La entrega está programada para el 2026-10-30 en la dirección indicada [Cita 2].',
  citations: [
    {
      id: 'cit-1',
      sourceType: 'shipment',
      factKey: 'carrier_tracking',
      citationText: 'Expedición GLS #ES12345678 enviada el 2026-10-28',
      verified: true
    },
    {
      id: 'cit-2',
      sourceType: 'order',
      factKey: 'estimated_delivery',
      citationText: 'Entrega estimada 2026-10-30 en Pol. Carrascot Ontinyent',
      verified: true
    }
  ],
  redactionFlags: {
    noUnauthorizedRefundCommitment: true,
    toneAppropriate: true,
    safePiiMasking: true
  },
  approvalStatus: 'pending'
}

describe('AdminSupportCopilot component (SUP-019)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.request.mockImplementation(async (url: string, _opts?: { method?: string; body?: unknown }) => {
      if (url === '/api/admin/support/copilot/draft') {
        return mockDraft
      }
      if (url.includes('/decision')) {
        return {
          interactionId: mockDraft.interactionId,
          approvalStatus: 'approved',
          humanApprovedAt: '2026-10-29T12:00:00Z'
        }
      }
      if (url.includes('/evaluate')) {
        return {
          interactionId: mockDraft.interactionId,
          accuracyScore: 5,
          accuracyEvaluation: 'accurate'
        }
      }
      throw new Error(`Unhandled URL ${url}`)
    })
  })

  it('renders copilot trigger and generates proposal with verified citations', async () => {
    const wrapper = await mountSuspended(AdminSupportCopilot, {
      props: { ticketId: 'ticket-1' }
    })
    await flushPromises()

    const draftBtn = wrapper.find('button[data-test="generate-copilot-draft"]')
    expect(draftBtn.exists()).toBe(true)
    await draftBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Respuesta propuesta')
    expect(wrapper.text()).toContain('GLS')
    expect(wrapper.text()).toContain('Citas de datos verificadas')
  })

  it('provides human approval and rejection actions', async () => {
    const wrapper = await mountSuspended(AdminSupportCopilot, {
      props: { ticketId: 'ticket-1' }
    })
    await flushPromises()

    await wrapper.find('button[data-test="generate-copilot-draft"]').trigger('click')
    await flushPromises()

    const approveBtn = wrapper.find('button[data-test="approve-draft"]')
    expect(approveBtn.exists()).toBe(true)

    const rejectBtn = wrapper.find('button[data-test="reject-draft"]')
    expect(rejectBtn.exists()).toBe(true)

    await approveBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Respuesta aprobada')
  })
})
