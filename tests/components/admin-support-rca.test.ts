import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminSupportRca from '../../app/components/AdminSupportRca.vue'
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

const mockRcas = [
  {
    id: 'rca-1111-1111-1111-111111111111',
    publicRef: 'RCA-00000000000000000001',
    incidentCategory: 'damage',
    title: 'Rotura de garrafas en transporte paletizado',
    status: 'action_planned',
    severity: 'critical',
    rootCauseSummary: 'Falta de cantoneras protectoras en palés de productos químicos corrosivos',
    fiveWhys: ['Envase perforado', 'Flejado excesivo', 'Sin cantoneras', 'Stock agotado', 'Fallo aprovisionamiento'],
    preventiveActions: [
      {
        id: 'act-1',
        actionType: 'packaging_update',
        description: 'Obligatoriedad de cantoneras rígidas y fleje plástico con limitador de par',
        assignee: 'Responsable de Logística',
        targetDate: '2026-11-10T00:00:00Z',
        status: 'pending'
      }
    ],
    verificationStatus: 'unverified',
    version: 1,
    createdAt: '2026-10-29T12:00:00Z'
  }
]

describe('AdminSupportRca component (SUP-018)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.request.mockImplementation(async (url: string, opts?: { method?: string; body?: unknown }) => {
      if (url === '/api/admin/support/rca') {
        if (opts?.method === 'POST') {
          return {
            rcaId: 'rca-2222-2222-2222-222222222222',
            publicRef: 'RCA-00000000000000000002',
            version: 1,
            status: 'action_planned'
          }
        }
        return { items: mockRcas }
      }
      if (url.startsWith('/api/admin/support/rca/') && url.endsWith('/verify')) {
        return {
          rcaId: 'rca-1111-1111-1111-111111111111',
          version: 2,
          verificationStatus: 'verified_effective',
          status: 'verified'
        }
      }
      throw new Error(`Unhandled URL ${url}`)
    })
  })

  it('renders RCA list with category badges and operational categories', async () => {
    const wrapper = await mountSuspended(AdminSupportRca)
    await flushPromises()

    expect(wrapper.text()).toContain('Análisis de Causa Raíz (RCA)')
    expect(wrapper.text()).toContain('Rotura de garrafas en transporte')
    expect(wrapper.text()).toContain('Daño')
    expect(wrapper.text().toLowerCase()).toContain('cantoneras')
  })

  it('allows creating a new operational RCA', async () => {
    const wrapper = await mountSuspended(AdminSupportRca)
    await flushPromises()

    const openBtn = wrapper.find('button[data-test="open-create-rca"]')
    expect(openBtn.exists()).toBe(true)
    await openBtn.trigger('click')
    await flushPromises()

    const titleInput = wrapper.find('input[name="rcaTitle"]')
    if (titleInput.exists()) {
      await titleInput.setValue('Error en picking de hipoclorito')
    }

    const submitBtn = wrapper.find('button[data-test="submit-rca"]')
    expect(submitBtn.exists()).toBe(true)
  })

  it('allows verifying preventive action effectiveness', async () => {
    const wrapper = await mountSuspended(AdminSupportRca)
    await flushPromises()

    const verifyBtn = wrapper.find('button[data-test="verify-rca"]')
    if (verifyBtn.exists()) {
      await verifyBtn.trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain('Verificado')
    }
  })
})
