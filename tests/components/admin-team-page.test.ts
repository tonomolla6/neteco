import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { computed, ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Page from '../../app/pages/admin/equipo.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  navigation: vi.fn(),
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  }))
}))
mockNuxtImport('useUserSession', () => mocks.session)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
vi.mock('../../app/composables/useAdminNavigation', () => ({ useAdminNavigation: mocks.navigation }))
const actor = ref({ id: '10000000-0000-4000-8000-000000000082', emailVerified: true, mfaVerified: true })
const session = ref({ sessionId: '20000000-0000-4000-8000-000000000082', sessionVersion: 1 })
const permission = ref(true)
const wrappers: Awaited<ReturnType<typeof mountSuspended>>[] = []
beforeEach(() => {
  permission.value = true
  actor.value.emailVerified = true
  actor.value.mfaVerified = true
  session.value.sessionVersion = 1
  mocks.session.mockReturnValue({ ready: ref(true), loggedIn: ref(true), user: actor, session })
  mocks.navigation.mockReturnValue({
    status: ref('ready'),
    capabilities: computed(() => ({
      state: 'ready',
      identityId: actor.value.id,
      sessionId: session.value.sessionId,
      sessionVersion: 1,
      permissions: permission.value ? ['administration.manage'] : []
    }))
  })
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
})
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount())
  vi.restoreAllMocks()
})
async function render() {
  const wrapper = await mountSuspended(Page, {
    global: {
      stubs: {
        AdminInvitationsPanel: {
          name: 'AdminInvitationsPanel',
          props: ['enabled', 'scopeKey', 'pending'],
          template: '<div data-team-panel />'
        }
      }
    }
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
it('mounts the invitation panel under identity/session-bound live administration authority and purges scope after revocation', async () => {
  const wrapper = await render()
  const panel = wrapper.findComponent({ name: 'AdminInvitationsPanel' })
  expect(panel.exists()).toBe(true)
  expect(panel.props('enabled')).toBe(true)
  expect(panel.props('scopeKey')).toContain(actor.value.id)
  permission.value = false
  await flushPromises()
  expect(panel.props('enabled')).toBe(false)
  expect(panel.props('scopeKey')).toBe('')
})
it('does not enable invitations for Node, missing MFA or a stale session version', async () => {
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'node' }
  })
  const node = await render()
  expect(node.findComponent({ name: 'AdminInvitationsPanel' }).props('enabled')).toBe(false)
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
  actor.value.mfaVerified = false
  const cloudflare = await render()
  expect(cloudflare.findComponent({ name: 'AdminInvitationsPanel' }).props('enabled')).toBe(false)
  actor.value.mfaVerified = true
  session.value.sessionVersion = 2
  await flushPromises()
  expect(cloudflare.findComponent({ name: 'AdminInvitationsPanel' }).props('enabled')).toBe(false)
})
