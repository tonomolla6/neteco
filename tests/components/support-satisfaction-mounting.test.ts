import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { computed, ref } from 'vue'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import CustomerSupportSection from '../../app/components/CustomerSupportSection.vue'
import AdminSupportSection from '../../app/components/AdminSupportSection.vue'
import { ACTOR, REF, customerContext, adminContext, listContext } from './support-operations-fixture'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ read: vi.fn(), request: vi.fn(), session: vi.fn(), navigation: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.read)
mockNuxtImport('$fetch', () => mocks.request)
mockNuxtImport('useUserSession', () => mocks.session)
vi.mock('../../app/composables/useAdminNavigation', () => ({ useAdminNavigation: mocks.navigation }))
const SESSION = '10000000-0000-4000-8000-000000000051'
function identity() {
  return {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: ACTOR, emailVerified: true, mfaVerified: true }),
    session: ref({ sessionId: SESSION, sessionVersion: 1 })
  }
}
let actor: ReturnType<typeof identity>
const wrappers: Array<{ unmount(): void }> = []
beforeEach(() => {
  actor = identity()
  mocks.session.mockReturnValue(actor)
  mocks.read.mockReset()
  mocks.request.mockReset()
  mocks.request.mockRejectedValue(new Error('No satisfaction state fixture yet'))
  mocks.navigation.mockReturnValue({
    status: ref('ready'),
    capabilities: computed(() => ({
      source: 'cloudflare',
      state: 'ready',
      identityId: actor.user.value.id,
      sessionId: actor.session.value.sessionId,
      sessionVersion: actor.session.value.sessionVersion,
      permissions: ['support.manage']
    }))
  })
})
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
})
async function mountCustomer(state: 'open' | 'resolved' | 'closed' = 'resolved', runtime = 'cloudflare') {
  mocks.read.mockImplementation(async (path: string) =>
    path === '/api/account/support' ? listContext() : { ...customerContext(), state }
  )
  const wrapper = await mountSuspended(CustomerSupportSection, { props: { runtime } })
  wrappers.push(wrapper)
  await flushPromises()
  const select = wrapper.findAll('button').find((button) => button.text().includes(REF))
  if (select) {
    await select.trigger('click')
    await flushPromises()
  }
  return wrapper
}
describe('satisfaction enters through existing private support journeys', () => {
  it('offers an optional rating after selecting a confirmed resolved own ticket without posting', async () => {
    const wrapper = await mountCustomer()
    expect(wrapper.find('[aria-label="Valoración opcional de soporte"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Mis consultas de soporte')
    expect(mocks.request.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
  })
  it.each(['open', 'node'] as const)('does not offer native post-service rating for %s', async (boundary) => {
    const wrapper = await mountCustomer(
      boundary === 'open' ? 'open' : 'resolved',
      boundary === 'node' ? 'node' : 'cloudflare'
    )
    expect(wrapper.find('[aria-label="Valoración opcional de soporte"]').exists()).toBe(false)
  })
  it('purges the selected optional rating when verified authority is lost with the same actor', async () => {
    const wrapper = await mountCustomer()
    expect(wrapper.find('[aria-label="Valoración opcional de soporte"]').exists()).toBe(true)
    actor.user.value.emailVerified = false
    await flushPromises()
    expect(wrapper.find('[aria-label="Valoración opcional de soporte"]').exists()).toBe(false)
  })
  it('offers an independent minimal satisfaction overview to a verified support operator', async () => {
    mocks.read.mockImplementation(async (path: string) =>
      path === '/api/admin/support' ? listContext(true) : adminContext()
    )
    const wrapper = await mountSuspended(AdminSupportSection, { props: { runtime: 'cloudflare' } })
    wrappers.push(wrapper)
    await flushPromises()
    expect(wrapper.find('[aria-label="Satisfacción de clientes"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Soporte e incidencias')
    expect(mocks.request.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
  })
})
