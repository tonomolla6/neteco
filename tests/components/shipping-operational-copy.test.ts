import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, expect, it } from 'vitest'
import Page from '../../app/pages/envios.vue'
import '#app/nuxt-vitest-app-entry'
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: 'cloudflare', freeShippingThresholdCents: 0 }
}))
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
afterEach(() => wrapper?.unmount())
it('explains operational estimates without hardcoded delivery-hour promises and preserves collection information', async () => {
  wrapper = await mountSuspended(Page, { global: { stubs: { UIcon: true, UButton: true } } })
  expect(wrapper.text()).not.toMatch(/24\s*[-–]\s*48\s*h|48\s+y\s+72\s*h/)
  expect(wrapper.text()).toContain('Lo ves al elegir el envío en el pedido')
  expect(wrapper.text()).toContain('Escríbenos y te decimos el próximo día de ruta')
  expect(wrapper.text()).toContain('Lo recoges tú')
  expect(wrapper.text()).toContain('número de pedido')
})
