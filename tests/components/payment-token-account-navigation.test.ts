import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { expect, it, vi } from 'vitest'
import AccountLayout from '../../app/layouts/cuenta.vue'
import '#app/nuxt-vitest-app-entry'
mockNuxtImport('useRuntimeConfig', () => () => ({
  public: { serverRuntime: 'cloudflare' },
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' }
}))
mockNuxtImport('useUserSession', () => () => ({
  user: { value: { name: 'Cliente', email: 'buyer@example.invalid' } },
  clear: vi.fn()
}))
it('offers the customer a link to manage saved payment methods', async () => {
  const wrapper = await mountSuspended(AccountLayout, {
    global: {
      stubs: { AppHeader: true, AppFooter: true, ConsentManager: true, USelectMenu: true, UButton: true, UIcon: true }
    }
  })
  expect(wrapper.find('a[href="/cuenta/metodos-de-pago"]').exists()).toBe(true)
})
