import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminRecentActivity from '../../app/components/AdminRecentActivity.vue'
import { ADMIN_ACTIVITY_ACTIONS, ADMIN_ACTIVITY_DESTINATIONS } from '../../shared/admin-activity'
import '#app/nuxt-vitest-app-entry'

// UI003 audited activity: only fresh server audit metadata, bounded five-event
// read, no writes/polling/pagination or invented audited actions. Loading/error/
// empty states differ; GET retry is explicit and singleflight. Root authority
// props gate reads and DOM, scope/pending/revocation invalidate late responses.
// Strict server DTO, canonical links, server timestamps, native keyboard links
// and mobile wrapping; no actor/entity identifiers/reasons/payloads are rendered.
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
const empty = () => ({ source: 'cloudflare', items: [], nextCursor: null })
const event = (index = 1) => ({
  id: `support:10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  kind: 'support',
  action: 'reply',
  createdAt: '2026-10-08T12:00:00Z',
  to: '/admin/soporte'
})
const list = (items = [event()], nextCursor: string | null = null) => ({ source: 'cloudflare', items, nextCursor })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const mounted: Wrapper[] = []
async function render(props = {}) {
  const wrapper = await mountSuspended(AdminRecentActivity, {
    props: { scopeKey: 'identity/session/version', enabled: true, pending: false, ...props },
    global: { stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } }
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
beforeEach(() => {
  mocks.request.mockReset().mockResolvedValue(empty())
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
})

describe('server-audited recent administrative activity', () => {
  it('shows confirmed audit labels, canonical keyboard links and actual server UTC times without exposing event IDs', async () => {
    mocks.request.mockResolvedValueOnce(list())
    const wrapper = await render()
    expect(wrapper.get('section').attributes('aria-labelledby')).toBeTruthy()
    expect(wrapper.text()).toContain('Actividad auditada reciente')
    expect(wrapper.text()).toContain('Respuesta registrada')
    const link = wrapper.get('[data-activity-item] a')
    expect(link.attributes('href')).toBe('/admin/soporte')
    expect(link.element.tagName).toBe('A')
    expect(link.attributes('tabindex')).not.toBe('-1')
    await link.trigger('keydown', { key: 'Enter' })
    expect(wrapper.get('time').attributes('datetime')).toBe(event().createdAt)
    expect(wrapper.get('time').text()).toContain('2026-10-08 12:00:00 UTC')
    expect(wrapper.html()).not.toContain(event().id)
    expect(wrapper.get('[data-activity-list]').classes()).toContain('min-w-0')
    expect(wrapper.get('[data-activity-item]').classes()).toContain('break-words')
  })
  it('shows five events only and never follows a cursor automatically', async () => {
    mocks.request.mockResolvedValueOnce(
      list(
        Array.from({ length: 5 }, (_, index) => event(index + 1)),
        'opaque_cursor'
      )
    )
    const wrapper = await render()
    expect(wrapper.findAll('[data-activity-item]')).toHaveLength(5)
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(wrapper.html()).not.toContain('opaque_cursor')
  })
  it.each(Object.keys(ADMIN_ACTIVITY_ACTIONS) as Array<keyof typeof ADMIN_ACTIVITY_ACTIONS>)(
    'renders the canonical server destination for %s without inventing a route',
    async (kind) => {
      mocks.request.mockResolvedValueOnce(
        list([
          {
            ...event(),
            id: `${kind}:10000000-0000-4000-8000-000000000001`,
            kind,
            action: ADMIN_ACTIVITY_ACTIONS[kind][0],
            to: ADMIN_ACTIVITY_DESTINATIONS[kind]
          }
        ])
      )
      const wrapper = await render()
      expect(wrapper.get('[data-activity-item] a').attributes('href')).toBe(ADMIN_ACTIVITY_DESTINATIONS[kind])
      expect(wrapper.find('[data-activity-error]').exists()).toBe(false)
    }
  )
  it.each(['destination', 'action', 'time', 'private', 'id', 'overflow', 'duplicate'])(
    'rejects invalid or privacy-breaking event %s without rendering any links',
    async (kind) => {
      const item: Record<string, unknown> = event()
      if (kind === 'destination') item.to = '/admin/soporte/customer-private?token=secret'
      if (kind === 'action') item.action = 'guessed_action'
      if (kind === 'time') item.createdAt = '2026-02-31T12:00:00Z'
      if (kind === 'private') item.reason = 'customer@example.invalid'
      if (kind === 'id') item.id = 'customer-name'
      const items =
        kind === 'overflow'
          ? Array.from({ length: 6 }, (_, index) => event(index + 1))
          : kind === 'duplicate'
            ? [item, item]
            : [item]
      mocks.request.mockResolvedValueOnce({ ...empty(), items })
      const wrapper = await render()
      expect(wrapper.find('[data-activity-error]').exists()).toBe(true)
      expect(wrapper.find('a').exists()).toBe(false)
      expect(wrapper.text()).not.toMatch(/customer|secret|guessed_action/)
    }
  )
  it('purges visible events during verification and rereads rather than reusing old audit data', async () => {
    mocks.request.mockResolvedValueOnce(list())
    const wrapper = await render()
    expect(wrapper.find('a').exists()).toBe(true)
    await wrapper.setProps({ pending: true })
    expect(wrapper.text()).toBe('')
    expect(wrapper.find('a').exists()).toBe(false)
    await wrapper.setProps({ pending: false })
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledTimes(2)
    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.find('[data-activity-empty]').exists()).toBe(true)
  })
  it('reads at most five events with a fresh GET and distinguishes a confirmed empty result', async () => {
    const wrapper = await render()
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(mocks.request).toHaveBeenCalledWith(
      '/api/admin/activity',
      expect.objectContaining({ method: 'GET', query: { limit: 5 }, cache: 'no-store', retry: 0 })
    )
    expect(wrapper.get('[data-activity-empty]').text()).toContain('No hay actividad auditada')
    expect(wrapper.find('[data-activity-error]').exists()).toBe(false)
  })
  it('shows accessible loading without falsely reporting no activity', async () => {
    const pending = deferred<unknown>()
    mocks.request.mockReturnValueOnce(pending.promise)
    const wrapper = await render()
    expect(wrapper.get('[data-activity-loading]').attributes('role')).toBe('status')
    expect(wrapper.get('[data-activity-loading]').attributes('aria-busy')).toBe('true')
    expect(wrapper.find('[data-activity-empty]').exists()).toBe(false)
    pending.resolve(empty())
    await flushPromises()
  })
  it.each([401, 403, 429, 503])(
    'keeps read error %s separate from empty and never displays private provider text',
    async (statusCode) => {
      mocks.request.mockRejectedValueOnce({ statusCode, message: 'private actor customer@example.invalid SQL token' })
      const wrapper = await render()
      expect(wrapper.get('[data-activity-error]').attributes('role')).toBe('alert')
      expect(wrapper.find('[data-activity-empty]').exists()).toBe(false)
      expect(wrapper.text()).not.toMatch(/customer@|SQL|token/)
    }
  )
  it('retries only the GET explicitly and singleflights repeated retry clicks', async () => {
    mocks.request.mockRejectedValueOnce(new Error('offline'))
    const wrapper = await render(),
      pending = deferred<unknown>()
    mocks.request.mockReturnValueOnce(pending.promise)
    const retry = wrapper.get('[data-activity-retry]')
    expect(retry.element.tagName).toBe('BUTTON')
    await retry.trigger('click')
    await retry.trigger('click')
    expect(mocks.request).toHaveBeenCalledTimes(2)
    pending.resolve(empty())
    await flushPromises()
    expect(wrapper.find('[data-activity-empty]').exists()).toBe(true)
    expect(mocks.request.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true)
  })
  it.each([{ enabled: false }, { pending: true }, { scopeKey: '' }])(
    'does not read or expose activity without current root authority %j',
    async (props) => {
      const wrapper = await render(props)
      expect(mocks.request).not.toHaveBeenCalled()
      expect(wrapper.text()).toBe('')
      expect(wrapper.find('a').exists()).toBe(false)
    }
  )
  it('requires a fresh GET after pending verification and ignores the previous response', async () => {
    const previous = deferred<unknown>()
    mocks.request.mockReturnValueOnce(previous.promise)
    const wrapper = await render()
    await wrapper.setProps({ pending: true })
    expect(wrapper.text()).toBe('')
    await wrapper.setProps({ pending: false })
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-activity-empty]').exists()).toBe(true)
    previous.resolve({ actor: 'private-old-response' })
    await flushPromises()
    expect(wrapper.find('[data-activity-error]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('private-old-response')
  })
  it('isolates scope changes and never replaces the new scope read with an old result', async () => {
    const previous = deferred<unknown>()
    mocks.request.mockReturnValueOnce(previous.promise)
    const wrapper = await render()
    mocks.request.mockRejectedValueOnce(new Error('new-session-offline'))
    await wrapper.setProps({ scopeKey: 'new-identity/new-session/2' })
    await flushPromises()
    expect(wrapper.find('[data-activity-error]').exists()).toBe(true)
    previous.resolve(empty())
    await flushPromises()
    expect(wrapper.find('[data-activity-error]').exists()).toBe(true)
    expect(wrapper.find('[data-activity-empty]').exists()).toBe(false)
  })
  it('purges confirmed data when permission is revoked and fetches anew after restoration', async () => {
    const wrapper = await render()
    expect(wrapper.find('[data-activity-empty]').exists()).toBe(true)
    await wrapper.setProps({ enabled: false })
    expect(wrapper.text()).toBe('')
    await wrapper.setProps({ enabled: true })
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledTimes(2)
  })
  it('does not restart reads or accept responses after unmount', async () => {
    const previous = deferred<unknown>()
    mocks.request.mockReturnValueOnce(previous.promise)
    const wrapper = await render()
    wrapper.unmount()
    mounted.splice(mounted.indexOf(wrapper), 1)
    previous.resolve(empty())
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })
  it.each([null, {}, { ...empty(), source: 'node' }, { ...empty(), actor: 'private@example.invalid' }])(
    'rejects malformed/private DTO %# as an error, never empty',
    async (raw) => {
      mocks.request.mockResolvedValueOnce(raw)
      const wrapper = await render()
      expect(wrapper.find('[data-activity-error]').exists()).toBe(true)
      expect(wrapper.find('[data-activity-empty]').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('private@example.invalid')
    }
  )
})
