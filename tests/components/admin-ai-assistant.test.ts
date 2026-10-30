import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminAiAssistant from '../../app/components/AdminAiAssistant.vue'
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

const mockProposal = {
  id: 'proposal-1111-2222-3333-444444444444',
  category: 'catalog_review',
  prompt: 'Revisa existencias de desengrasante',
  contextSummary: 'Producto Desengrasante Alcalino Extra Fuerte. Stock: 50 uds.',
  proposedReply:
    'El stock actual es de 50 unidades [Cita 1]. Se recomienda mantener el nivel de reaprovisionamiento [Cita 2].',
  proposedAction: 'Generar alerta de reaprovisionamiento preventivo',
  actionType: 'propose_restock_alert',
  actionPayload: { threshold: 20 },
  citations: [
    {
      id: 'cit-1',
      sourceType: 'inventory',
      factKey: 'physical_quantity',
      citationText: 'Existencias físicas: 50 unidades en almacén central',
      verified: true
    },
    {
      id: 'cit-2',
      sourceType: 'policy',
      factKey: 'restock_policy',
      citationText: 'Umbral mínimo de seguridad: 20 unidades',
      verified: true
    }
  ],
  redactionFlags: {
    noUnauthorizedRefundCommitment: true,
    toneAppropriate: true,
    safePiiMasking: true,
    restrictedAccessFiltered: true
  },
  requiresHumanApproval: true,
  autoExecutionForbidden: true,
  approvalStatus: 'pending',
  version: 1
}

describe('AdminAiAssistant component (ADM-032)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.request.mockImplementation(async (url: string) => {
      if (url.includes('/api/admin/ai/assistant/propose')) {
        return { interaction: mockProposal }
      }
      if (url.includes('/decision')) {
        return {
          interaction: {
            ...mockProposal,
            approvalStatus: 'approved',
            humanDecidedAt: '2026-10-29T12:00:00Z',
            version: 2
          }
        }
      }
      throw new Error(`Unhandled request URL: ${url}`)
    })
  })

  it('renders prompt input, generates proposal and displays verified citations', async () => {
    const wrapper = await mountSuspended(AdminAiAssistant)
    await flushPromises()

    const promptInput = wrapper.find('textarea[data-test="assistant-prompt"]')
    expect(promptInput.exists()).toBe(true)

    await promptInput.setValue('Revisa existencias de desengrasante')
    const submitBtn = wrapper.find('button[data-test="generate-proposal-btn"]')
    expect(submitBtn.exists()).toBe(true)

    await submitBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Propuesta de Copiloto')
    expect(wrapper.text()).toContain('Existencias físicas: 50 unidades')
    expect(wrapper.text()).toContain('Citas de datos verificadas')
  })

  it('provides human approval and rejection actions with CAS', async () => {
    const wrapper = await mountSuspended(AdminAiAssistant)
    await flushPromises()

    await wrapper.find('textarea[data-test="assistant-prompt"]').setValue('Test')
    await wrapper.find('button[data-test="generate-proposal-btn"]').trigger('click')
    await flushPromises()

    const approveBtn = wrapper.find('button[data-test="approve-proposal-btn"]')
    expect(approveBtn.exists()).toBe(true)

    await approveBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Propuesta Aprobada')
  })
})
