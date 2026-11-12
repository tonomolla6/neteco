import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { computed, ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Panel from '../../app/components/ShippingCalendarPanel.vue'
import {
  shippingCalendarIntentHash,
  shippingCalendarConfigurationHash,
  type ShippingCalendarInput
} from '../../shared/shipping-calendar'
import '#app/nuxt-vitest-app-entry'
import { testUuid } from '../support/deterministic'
const mocks = vi.hoisted(() => ({ request: vi.fn(), session: vi.fn(), navigation: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => mocks.session)
vi.mock('../../app/composables/useAdminNavigation', () => ({ useAdminNavigation: mocks.navigation }))
const actor = '10000000-0000-4000-8000-000000000078',
  sid = '20000000-0000-4000-8000-000000000078'
const initial = { source: 'cloudflare', version: 0, configuration: null, configurationHash: null, updatedAt: null }
const permission = ref(true)
let auth: ReturnType<typeof session>
function session() {
  return {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: actor, emailVerified: true, mfaVerified: true }),
    session: ref({ sessionId: sid, sessionVersion: 1 })
  }
}
const mounted: Array<{ unmount(): void }> = []
type Options = { method?: string; body?: ShippingCalendarInput; headers?: Record<string, string> }
beforeEach(() => {
  auth = session()
  permission.value = true
  mocks.session.mockReturnValue(auth)
  mocks.navigation.mockReturnValue({
    status: ref('ready'),
    capabilities: computed(() => ({
      state: 'ready',
      identityId: auth.user.value?.id,
      sessionId: auth.session.value?.sessionId,
      sessionVersion: auth.session.value?.sessionVersion,
      permissions: permission.value ? ['administration.manage'] : []
    }))
  })
  let current: unknown = initial
  mocks.request.mockReset().mockImplementation(async (_path: string, options: Options) => {
    if (options.method === 'POST') {
      const body = options.body!,
        hash = await shippingCalendarConfigurationHash(body.configuration),
        recordedAt = '2026-10-09T19:00:00Z'
      current = {
        source: 'cloudflare',
        version: body.expectedVersion + 1,
        configuration: body.configuration,
        configurationHash: hash,
        updatedAt: recordedAt
      }
      return {
        source: 'cloudflare',
        commandId: options.headers!['Idempotency-Key'],
        expectedVersion: body.expectedVersion,
        version: body.expectedVersion + 1,
        payloadHash: await shippingCalendarIntentHash(body),
        configurationHash: hash,
        recordedAt
      }
    }
    return current
  })
})
afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount())
  vi.restoreAllMocks()
})
async function render(props = {}) {
  const w = await mountSuspended(Panel, {
    props: { scopeKey: 'calendar-current', enabled: true, pending: false, ...props }
  })
  mounted.push(w)
  await flushPromises()
  return w
}
const posts = () => mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')
async function review(w: Awaited<ReturnType<typeof render>>) {
  await w.get('[data-calendar-preparation]').setValue('1')
  await w.get('[data-calendar-cutoff]').setValue('14:00')
  await w.get('[data-calendar-add]').trigger('click')
  await w.get('[data-calendar-name="0"]').setValue('Synthetic reviewed calendar')
  for (const day of [1, 2, 3, 4, 5]) await w.get(`[data-calendar-weekday="0-${day}"]`).setValue(true)
  await w.get('[data-calendar-dates="0"]').setValue('2026-10-12')
  await w.get('[data-calendar-reason]').setValue('Synthetic explicitly reviewed local calendar')
  await w.get('[data-calendar-reference]').setValue('CALENDAR-REVIEW-78')
  await w.get('[data-calendar-review]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-calendar-confirm]').exists()).toBe(true))
}
it('reads unconfigured state explicitly, with no seeded operational days or holidays', async () => {
  const w = await render()
  expect(mocks.request).toHaveBeenCalledTimes(1)
  expect(w.text()).toContain('Sin calendario configurado')
  expect(w.get('[data-calendar-preparation]').element).toHaveProperty('value', '')
  expect(posts()).toHaveLength(0)
})
it.each([{ enabled: false }, { pending: true }, { scopeKey: '' }])(
  'does not request without current active context %j',
  async (props) => {
    await render(props)
    expect(mocks.request).not.toHaveBeenCalled()
  }
)
it('requires matching live administration permission and MFA', async () => {
  permission.value = false
  await render()
  expect(mocks.request).not.toHaveBeenCalled()
})
it('requires review and explicit confirmation then receipt plus current GET before success', async () => {
  const w = await render()
  await review(w)
  expect(posts()).toHaveLength(0)
  await w.get('[data-calendar-confirm]').trigger('click')
  await vi.waitFor(() => expect(w.text()).toContain('Calendario guardado y verificado'))
  expect(posts()).toHaveLength(1)
  expect(mocks.request).toHaveBeenCalledTimes(3)
  expect(posts()[0]![1].body.configuration.calendars[0].operatingWeekdays).toEqual([1, 2, 3, 4, 5])
})
it('does not invent an empty calendar when the current-state read fails', async () => {
  mocks.request.mockRejectedValue(Error('unavailable'))
  const w = await render()
  expect(w.find('[data-calendar-review]').exists()).toBe(false)
  expect(w.find('[data-calendar-load]').exists()).toBe(true)
})
it('purges private review drafts and response on permission loss', async () => {
  const w = await render()
  await review(w)
  permission.value = false
  await flushPromises()
  expect(w.text()).not.toContain('Synthetic explicitly reviewed local calendar')
  const state = w.vm.$.setupState as Record<string, unknown>
  expect(state.reason).toBe('')
  expect(state.intent).toBe(null)
  expect(state.snapshot).toBe(null)
})
it('recovers a deliberately lost committed response using exact hash and fresh GET without another POST', async () => {
  const original = mocks.request.getMockImplementation()!,
    receipts: { value: unknown } = { value: null }
  mocks.request.mockImplementation(async (path: string, options: Options) => {
    if (options.method === 'POST') {
      receipts.value = await original(path, options)
      throw Error('synthetic_lost_response')
    }
    if (path.includes('/commands/')) return { source: 'cloudflare', outcome: 'applied', receipt: receipts.value }
    return original(path, options)
  })
  const w = await render()
  await review(w)
  await w.get('[data-calendar-confirm]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-calendar-check]').exists()).toBe(true))
  expect(w.emitted('confirmed')).toBeUndefined()
  await w.get('[data-calendar-check]').trigger('click')
  await vi.waitFor(() => expect(w.text()).toContain('Calendario guardado y verificado'))
  expect(posts()).toHaveLength(1)
  const lookup = mocks.request.mock.calls.find(([path]) => path.includes('/commands/'))!
  expect(lookup[1].headers['X-Neteco-Command-Payload-Hash']).toBe(await shippingCalendarIntentHash(posts()[0]![1].body))
})
it('keeps unknown recovery frozen and never automatically resubmits', async () => {
  mocks.request.mockImplementation(async (path: string, options: Options) => {
    if (options.method === 'POST') throw Error('synthetic_unknown')
    if (path.includes('/commands/')) return { source: 'cloudflare', outcome: 'unknown', receipt: null }
    return initial
  })
  const w = await render()
  await review(w)
  await w.get('[data-calendar-confirm]').trigger('click')
  await flushPromises()
  await w.get('[data-calendar-check]').trigger('click')
  await flushPromises()
  expect(posts()).toHaveLength(1)
  expect(w.emitted('confirmed')).toBeUndefined()
  expect(w.find('[data-calendar-check]').exists()).toBe(true)
  expect(w.emitted('pending')?.at(-1)).toEqual([true])
})
it('does not confirm a receipt for another command even when it is structurally valid', async () => {
  const original = mocks.request.getMockImplementation()!
  mocks.request.mockImplementation(async (path: string, options: Options) => {
    const value = await original(path, options)
    return options.method === 'POST' ? { ...value, commandId: testUuid() } : value
  })
  const w = await render()
  await review(w)
  await w.get('[data-calendar-confirm]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-calendar-check]').exists()).toBe(true))
  expect(w.emitted('confirmed')).toBeUndefined()
  expect(w.find('[data-calendar-check]').exists()).toBe(true)
  expect(posts()).toHaveLength(1)
})
it('purges private intent and drafts on a confirmed recovery authorization failure', async () => {
  mocks.request.mockImplementation(async (path: string, options: Options) => {
    if (path.includes('/commands/')) throw { statusCode: 403 }
    if (options.method === 'POST') throw Error('synthetic_lost_response')
    return initial
  })
  const w = await render()
  await review(w)
  await w.get('[data-calendar-confirm]').trigger('click')
  await flushPromises()
  await w.get('[data-calendar-check]').trigger('click')
  await flushPromises()
  const state = w.vm.$.setupState as Record<string, unknown>
  expect(state.intent).toBe(null)
  expect(state.snapshot).toBe(null)
  expect(state.reason).toBe('')
  expect(state.calendars).toEqual([])
  expect(w.emitted('confirmed')).toBeUndefined()
  expect(posts()).toHaveLength(1)
})
