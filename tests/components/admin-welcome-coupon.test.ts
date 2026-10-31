import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminWelcomeCoupon from '../../app/components/AdminWelcomeCoupon.vue'
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
  status: 'active',
  codePrefix: 'BIENVENIDA',
  discountPercent: 10,
  maxDiscountCents: 1500,
  minOrderCents: 5000,
  validityDays: 14,
  excludedCategoryIds: ['cat-maquinaria'],
  excludedProductIds: ['prod-granel'],
  excludeAlreadyDiscounted: true,
  marginFloorBasisPoints: 2000,
  updatedAt: '2026-10-29T12:00:00Z',
  updatedBy: '00000000-0000-4000-8000-000000000000'
}

describe('AdminWelcomeCoupon component (MKT-016)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.request.mockImplementation(async (url: string, opts?: { method?: string; body?: unknown }) => {
      if (url === '/api/admin/welcome-coupon/policy') {
        if (opts?.method === 'PUT') {
          return {
            policy: {
              ...mockPolicy,
              version: 2,
              discountPercent: 15,
              codePrefix: 'HOLA15'
            }
          }
        }
        return { policy: mockPolicy }
      }
      return null
    })
  })

  it('renders welcome coupon form with existing values and anti-fraud rules', async () => {
    const wrapper = await mountSuspended(AdminWelcomeCoupon)
    await flushPromises()

    expect(wrapper.text()).toContain('Cupón de Bienvenida Administrable (MKT-016)')
    expect(wrapper.text()).toContain('Mecanismos Antifraude y Cumplimiento Normativo')

    const prefixInput = wrapper.find('[data-testid="welcome-coupon-prefix"]')
    expect((prefixInput.element as HTMLInputElement).value).toBe('BIENVENIDA')

    const percentInput = wrapper.find('[data-testid="welcome-coupon-percent"]')
    expect((percentInput.element as HTMLInputElement).value).toBe('10')
  })

  it('updates welcome coupon policy with CAS expectedVersion', async () => {
    const wrapper = await mountSuspended(AdminWelcomeCoupon)
    await flushPromises()

    const prefixInput = wrapper.find('[data-testid="welcome-coupon-prefix"]')
    await prefixInput.setValue('HOLA15')

    const percentInput = wrapper.find('[data-testid="welcome-coupon-percent"]')
    await percentInput.setValue(15)

    const saveButton = wrapper.find('[data-testid="save-welcome-coupon-button"]')
    await saveButton.trigger('click')
    await flushPromises()

    expect(mocks.request).toHaveBeenCalledWith(
      '/api/admin/welcome-coupon/policy',
      expect.objectContaining({
        method: 'PUT',
        body: expect.objectContaining({
          expectedVersion: 1,
          codePrefix: 'HOLA15',
          discountPercent: 15
        })
      })
    )

    expect(wrapper.text()).toContain('Política de cupón de bienvenida guardada con éxito (v2)')
  })
})
