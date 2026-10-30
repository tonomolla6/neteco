import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminReleaseGatesPanel from '../../app/components/AdminReleaseGatesPanel.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

describe('AdminReleaseGatesPanel: Controles de Release y Despliegues', () => {
  beforeEach(() => {
    mocks.request.mockReset()
  })

  it('muestra el estado de carga mientras espera la respuesta de los endpoints', async () => {
    let finish!: (val: unknown) => void
    mocks.request.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const wrapper = mount(AdminReleaseGatesPanel)
    expect(wrapper.text()).toContain('Cargando controles de release y despliegue...')
    finish([])
    await flushPromises()
  })

  it('comunica el error cuando falla la carga y permite reintentar', async () => {
    mocks.request.mockRejectedValueOnce(new Error('Fallo de red en servidor de despliegues')).mockResolvedValue([])

    const wrapper = await mountSuspended(AdminReleaseGatesPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('Fallo de red en servidor de despliegues')
    const retryBtn = wrapper.get('.btn-retry')
    await retryBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('No hay promociones Alpha→Beta registradas')
  })

  it('muestra estado vacío cuando no existen promociones', async () => {
    mocks.request.mockResolvedValue([])
    const wrapper = await mountSuspended(AdminReleaseGatesPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('No hay promociones Alpha→Beta registradas en el sistema.')
  })

  it('muestra promociones con sus checklist items y recuento de defectos P0/P1', async () => {
    mocks.request.mockImplementation((url: string) => {
      if (url.includes('alpha-beta-promotions')) {
        return Promise.resolve([
          {
            id: 'promo-1',
            releaseVersion: 'v2.6.0-beta.1',
            status: 'draft',
            p0DefectsCount: 0,
            p1DefectsCount: 0,
            checklistSummary: {
              sloVerified: true,
              alertsConfigured: true,
              runbooksPublished: true,
              restoreRehearsed: true,
              pentestCleared: true,
              uatPassed: true
            },
            evidenceHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
          }
        ])
      }
      return Promise.resolve([])
    })

    const wrapper = await mountSuspended(AdminReleaseGatesPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('Versión v2.6.0-beta.1')
    expect(wrapper.text()).toContain('P0: 0')
    expect(wrapper.text()).toContain('P1: 0')
    expect(wrapper.text()).toContain('SLO: Conforme')
    expect(wrapper.text()).toContain('Restore DR: Ensayado')
  })

  it('permite cambiar entre pestañas de rollouts, policies y campañas', async () => {
    mocks.request.mockImplementation((url: string) => {
      if (url.includes('progressive-rollouts')) {
        return Promise.resolve([
          {
            id: 'ro-1',
            featureKey: 'b2b_checkout_v2',
            name: 'Checkout B2B Progresivo',
            status: 'active',
            trafficPercentage: 40,
            cohorts: ['b2b_beta'],
            zones: ['ES-MD'],
            guardrails: { maxErrorRatePercent: 1.0, maxP95LatencyMs: 500, minSampleCount: 10 },
            betaScopeNotice: {
              title: 'Aviso Beta Checkout',
              summary: 'Prueba en curso.'
            }
          }
        ])
      }
      return Promise.resolve([])
    })

    const wrapper = await mountSuspended(AdminReleaseGatesPanel)
    await flushPromises()

    // Cambiar a pestaña Rollouts
    const rolloutTab = wrapper.get('#tab-rollout')
    await rolloutTab.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Checkout B2B Progresivo')
    expect(wrapper.text()).toContain('Tráfico asignado: 40%')
    expect(wrapper.text()).toContain('b2b_beta')
  })
})
