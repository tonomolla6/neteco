import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminBrowseRecovery from '../../app/components/AdminBrowseRecovery.vue'
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

const mockPolicy = {
  id: 'global',
  version: 1,
  enabled: true,
  abandonmentWindowMinutes: 120,
  cooldownHours: 72,
  holdoutPercent: 20,
  attributionWindowDays: 7,
  updatedAt: '2026-10-29T12:00:00Z',
  updatedBy: '00000000-0000-4000-8000-000000000000'
}

const mockMetrics = {
  source: 'cloudflare',
  evaluatedAt: '2026-10-29T12:00:00Z',
  treatment: {
    exposures: 50,
    conversions: 5,
    conversionRate: 0.1,
    revenueGrossCents: 50000,
    arpuCents: 1000
  },
  control: {
    exposures: 20,
    conversions: 1,
    conversionRate: 0.05,
    revenueGrossCents: 8000,
    arpuCents: 400
  },
  lift: {
    incrementalConversionRate: 0.05,
    relativeLiftPercent: 100,
    incrementalRevenueGrossCents: 30000,
    statisticallySignificant: true
  }
}

describe('AdminBrowseRecovery component (MKT-014)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.request.mockImplementation(async (url: string, opts?: { method?: string; body?: unknown }) => {
      if (url === '/api/admin/browse-recovery/policy') {
        if (opts?.method === 'PUT') {
          return { policy: { ...mockPolicy, version: 2, abandonmentWindowMinutes: 90 } }
        }
        return { policy: mockPolicy }
      }
      if (url === '/api/admin/browse-recovery/metrics') {
        return { metrics: mockMetrics }
      }
      return null
    })
  })

  it('renders policy inputs and incrementality metrics', async () => {
    const wrapper = await mountSuspended(AdminBrowseRecovery)
    await flushPromises()

    expect(wrapper.text()).toContain('Automatización de Navegación Abandonada (MKT-014)')
    expect(wrapper.text()).toContain('Medición de Incrementalidad')

    const exposures = wrapper.find('[data-testid="treatment-exposures"]').text()
    expect(exposures).toBe('50')

    const controlExp = wrapper.find('[data-testid="control-exposures"]').text()
    expect(controlExp).toBe('20')

    const lift = wrapper.find('[data-testid="relative-lift"]').text()
    expect(lift).toContain('+100.0%')
  })

  it('saves updated policy with expectedVersion CAS increment', async () => {
    const wrapper = await mountSuspended(AdminBrowseRecovery)
    await flushPromises()

    const windowInput = wrapper.find('[data-testid="abandonment-window-input"]')
    await windowInput.setValue(90)

    const saveButton = wrapper.find('[data-testid="save-browse-policy-button"]')
    await saveButton.trigger('click')
    await flushPromises()

    expect(mocks.request).toHaveBeenCalledWith(
      '/api/admin/browse-recovery/policy',
      expect.objectContaining({
        method: 'PUT',
        body: expect.objectContaining({
          expectedVersion: 1,
          abandonmentWindowMinutes: 90
        })
      })
    )

    expect(wrapper.text()).toContain('Política de navegación guardada con éxito (v2)')
  })
})
