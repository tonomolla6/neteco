import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import CuentaLayout from '../../app/layouts/cuenta.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  }))
}))
mockNuxtImport('useUserSession', () => mocks.session)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
beforeEach(() => {
  mocks.session.mockReturnValue({
    user: ref({ name: 'Cliente sintético', email: 'buyer@example.invalid' }),
    clear: vi.fn()
  })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

async function links(serverRuntime: string) {
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime }
  })
  wrapper = await mountSuspended(CuentaLayout, {
    global: {
      stubs: {
        AppHeader: true,
        NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
        UIcon: true,
        UButton: { template: '<button><slot /></button>' },
        USelectMenu: true
      }
    }
  })
  return wrapper.findAll('nav a').map((link) => link.attributes('href'))
}

it('makes product notices and contributions discoverable from the actual Cloudflare account shell', async () => {
  expect(await links('cloudflare')).toEqual(
    expect.arrayContaining(['/cuenta/avisos-productos', '/cuenta/aportaciones-productos'])
  )
})
it('does not expose Cloudflare-only engagement routes in the legacy account shell', async () => {
  const legacy = await links('node')
  expect(legacy).not.toContain('/cuenta/avisos-productos')
  expect(legacy).not.toContain('/cuenta/aportaciones-productos')
  expect(legacy).not.toContain('/cuenta/presupuestos')
})
it('makes approved commercial quotes discoverable from the Cloudflare account shell', async () => {
  expect(await links('cloudflare')).toContain('/cuenta/presupuestos')
})
