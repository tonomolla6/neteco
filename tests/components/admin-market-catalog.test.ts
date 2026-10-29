import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminMarketCatalog from '../../app/components/AdminMarketCatalog.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

describe('AdminMarketCatalog component', () => {
  beforeEach(() => {
    mocks.request.mockReset()
  })

  it('renders market selection and empty state when no product is loaded', async () => {
    mocks.request.mockResolvedValueOnce([
      { code: 'ES', name: 'España', defaultLocale: 'es-ES' },
      { code: 'FR', name: 'Francia', defaultLocale: 'fr-FR' }
    ])

    const wrapper = await mountSuspended(AdminMarketCatalog)
    await flushPromises()

    expect(wrapper.text()).toContain('Catálogo por Mercado y Cumplimiento Químico')
    expect(wrapper.find('select[name=marketCode]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Seleccione o introduzca un ID de producto')
  })

  it('loads product market configuration and displays availability and compliance', async () => {
    mocks.request
      .mockResolvedValueOnce([
        { code: 'ES', name: 'España', defaultLocale: 'es-ES' },
        { code: 'FR', name: 'Francia', defaultLocale: 'fr-FR' }
      ])
      .mockResolvedValueOnce([
        {
          productId: 'p-1',
          marketCode: 'FR',
          locale: 'fr-FR',
          title: 'Dégraissant Industriel',
          description: 'Nettoyant pro',
          slug: 'degraissant-pro',
          isAvailable: 1,
          isCompliant: 1,
          ufiCode: 'UFI-FR-1111',
          version: 1
        }
      ])

    const wrapper = await mountSuspended(AdminMarketCatalog)
    await flushPromises()

    await wrapper.find('input[name=productId]').setValue('p-1')
    await wrapper.find('button[data-action=load-product]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Dégraissant Industriel')
    expect(wrapper.text()).toContain('UFI-FR-1111')
    expect(wrapper.find('button[data-action=save-market-config]').exists()).toBe(true)
  })

  it('displays error alert when fetch fails', async () => {
    mocks.request.mockRejectedValue(new Error('Network error'))

    const wrapper = await mountSuspended(AdminMarketCatalog)
    await flushPromises()

    expect(wrapper.find('[role=alert]').exists()).toBe(true)
  })
})
