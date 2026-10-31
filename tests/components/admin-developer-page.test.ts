import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import DeveloperPage from '../../app/pages/admin/plataforma.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
mockNuxtImport('useAdminNavigation', () => () => mocks.state.navigation)
mockNuxtImport('useUserSession', () => () => mocks.state.session)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: 'cloudflare' }
}))
const stubs = {
  AdminDeveloperPortal: { template: '<div>catálogo</div>' },
  AdminDeveloperMetrics: { template: '<div>métricas protegidas</div>' },
  AdminB2bPublicKeys: { template: '<div>gestión de claves</div>' },
  AdminDeveloperOwnership: { template: '<div>responsables persistentes</div>' }
}
function setup(permission: boolean) {
  const capabilities = ref({
    state: 'ready',
    identityId: 'u',
    sessionId: 's',
    sessionVersion: 1,
    permissions: permission ? ['administration.manage'] : []
  })
  mocks.state.navigation = { status: ref('ready'), capabilities }
  mocks.state.session = {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: 'u', emailVerified: true, mfaVerified: true }),
    session: ref({ sessionId: 's', sessionVersion: 1 })
  }
  return capabilities
}
describe('portal de plataforma administrativo', () => {
  it('muestra operaciones privadas solo con capacidad y sesión vinculadas', async () => {
    const capabilities = setup(true)
    const wrapper = await mountSuspended(DeveloperPage, { global: { stubs } })
    expect(wrapper.text()).toContain('gestión de claves')
    expect(wrapper.text()).toContain('métricas protegidas')
    expect(wrapper.text()).toContain('responsables persistentes')
    capabilities.value = { ...capabilities.value, permissions: [] }
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).not.toContain('gestión de claves')
    expect(wrapper.text()).not.toContain('métricas protegidas')
    expect(wrapper.text()).not.toContain('responsables persistentes')
  })
  it('no monta operaciones privadas sin permiso', async () => {
    setup(false)
    const wrapper = await mountSuspended(DeveloperPage, { global: { stubs } })
    expect(wrapper.text()).not.toContain('gestión de claves')
    expect(wrapper.text()).not.toContain('métricas protegidas')
    expect(wrapper.text()).not.toContain('responsables persistentes')
  })
})
