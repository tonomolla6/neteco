import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OrderTimelinePanel from '../../app/components/OrderTimelinePanel.vue'
import { encodeOrderTimelineCursor, ORDER_TIMELINE_STATES, type OrderTimelineItem } from '../../shared/order-timeline'
import '#app/nuxt-vitest-app-entry'

// ORD003 read-only real events: scoped customer/admin routes, explicit bounded
// pagination and retry; confirmed chronology only, no projected milestones.
// Authority/order/audience transitions abort and purge current/private data.
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
const ORDER = '10000000-0000-4000-8000-000000000001'
const OTHER = '10000000-0000-4000-8000-000000000002'
const empty = () => ({ source: 'cloudflare', orderId: ORDER, audience: 'customer', items: [], nextCursor: null })
const AS_OF = '2026-10-08T12:05:00Z'
const event = (index = 3): OrderTimelineItem => ({
  id: `checkout:synthetic-${index}`,
  kind: 'checkout',
  state: 'created',
  createdAt: `2026-10-08T12:0${index}:00Z`,
  validationOnly: null
})
function page(items: OrderTimelineItem[] = [event()], next = false, audience: 'customer' | 'admin' = 'customer') {
  const last = items.at(-1)!
  return {
    ...empty(),
    audience,
    items,
    nextCursor: next
      ? encodeOrderTimelineCursor({ v: 1, orderId: ORDER, audience, asOf: AS_OF, at: last.createdAt, id: last.id })
      : null
  }
}
function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const mounted: Wrapper[] = []
async function render(props = {}) {
  const wrapper = await mountSuspended(OrderTimelinePanel, {
    props: {
      orderId: ORDER,
      audience: 'customer',
      scopeKey: 'identity/session/1',
      enabled: true,
      pending: false,
      ...props
    }
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
beforeEach(() => {
  mocks.request.mockReset().mockRejectedValue(new Error('offline'))
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
})

describe('authorized unified order timeline', () => {
  it.each(['customer', 'admin'] as const)(
    'reads only the current %s endpoint with a bounded no-store GET',
    async (audience) => {
      await render({ audience })
      expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
        `/api/${audience === 'admin' ? 'admin/' : ''}orders/${ORDER}/timeline`,
        expect.objectContaining({
          method: 'GET',
          cache: 'no-store',
          retry: 0
        })
      )
    }
  )
  it.each([
    { enabled: false },
    { pending: true },
    { scopeKey: '' },
    { orderId: '' },
    { orderId: '../private?token=x' }
  ])('does not expose or request timeline without confirmed props %j', async (props) => {
    const wrapper = await render(props)
    expect(mocks.request).not.toHaveBeenCalled()
    expect(wrapper.text()).toBe('')
  })
  it('shows accessible loading without claiming no events', async () => {
    const pending = deferred()
    mocks.request.mockReturnValueOnce(pending.promise)
    const wrapper = await render()
    expect(wrapper.get('[data-timeline-loading]').attributes('role')).toBe('status')
    expect(wrapper.get('[data-timeline-loading]').attributes('aria-busy')).toBe('true')
    expect(wrapper.find('[data-timeline-empty]').exists()).toBe(false)
    pending.resolve({ invalid: true })
    await flushPromises()
  })
  it('labels a confirmed empty response separately from loading or failure', async () => {
    mocks.request.mockResolvedValueOnce(empty())
    const wrapper = await render()
    expect(wrapper.get('[data-timeline-empty]').attributes('role')).toBe('status')
    expect(wrapper.get('[data-timeline-empty]').text()).toContain('No hay hitos confirmados')
    expect(wrapper.find('[data-timeline-error]').exists()).toBe(false)
    expect(wrapper.get('section').attributes('aria-labelledby')).toBeTruthy()
  })
  it.each(['order', 'audience', 'source', 'unknown', 'nextCursor'])(
    'rejects an unconfirmed %s envelope before rendering data',
    async (mode) => {
      const dto: Record<string, unknown> = empty()
      if (mode === 'order') dto.orderId = OTHER
      if (mode === 'audience') dto.audience = 'admin'
      if (mode === 'source') dto.source = 'node'
      if (mode === 'unknown') dto.customerEmail = 'private@example.invalid'
      if (mode === 'nextCursor') dto.nextCursor = 'malformed?token=private'
      mocks.request.mockResolvedValueOnce(dto)
      const wrapper = await render()
      expect(wrapper.find('[data-timeline-error]').exists()).toBe(true)
      expect(wrapper.find('[data-timeline-empty]').exists()).toBe(false)
      expect(wrapper.text()).not.toMatch(/private@|token=private/)
    }
  )
  it.each([401, 403, 404, 409, 429, 503])(
    'shows generic error %s separately from confirmed empty',
    async (statusCode) => {
      mocks.request.mockRejectedValueOnce({ statusCode, message: 'SQL actor customer@example.invalid token' })
      const wrapper = await render()
      expect(wrapper.get('[data-timeline-error]').attributes('role')).toBe('alert')
      expect(wrapper.find('[data-timeline-empty]').exists()).toBe(false)
      expect(wrapper.text()).not.toMatch(/SQL|actor|customer@|token/)
    }
  )
  it('retries only the exact read explicitly and singleflights repeated clicks', async () => {
    const wrapper = await render(),
      pending = deferred()
    mocks.request.mockReturnValueOnce(pending.promise)
    const retry = wrapper.get('[data-timeline-retry]')
    await retry.trigger('click')
    await retry.trigger('click')
    expect(mocks.request).toHaveBeenCalledTimes(2)
    expect(mocks.request.mock.calls[1]?.[0]).toEqual(mocks.request.mock.calls[0]?.[0])
    expect(mocks.request.mock.calls[1]?.[1].query).toEqual(mocks.request.mock.calls[0]?.[1].query)
    pending.resolve({ invalid: true })
    await flushPromises()
  })
  it.each(['scope', 'pending', 'enabled', 'order', 'audience', 'unmount'])(
    'aborts and ignores an old response after %s changes',
    async (mode) => {
      const previous = deferred()
      mocks.request.mockReturnValueOnce(previous.promise)
      const wrapper = await render()
      const signal = mocks.request.mock.calls[0]?.[1].signal as AbortSignal
      if (mode === 'unmount') wrapper.unmount()
      else
        await wrapper.setProps(
          mode === 'scope'
            ? { scopeKey: 'new/session/2' }
            : mode === 'pending'
              ? { pending: true }
              : mode === 'enabled'
                ? { enabled: false }
                : mode === 'order'
                  ? { orderId: OTHER }
                  : { audience: 'admin' }
        )
      await flushPromises()
      expect(signal.aborted).toBe(true)
      previous.resolve({ privateReason: 'OLD PRIVATE DATA' })
      await flushPromises()
      expect(wrapper.text()).not.toContain('OLD PRIVATE DATA')
      expect(wrapper.find('[data-timeline-item]').exists()).toBe(false)
    }
  )
  it.each(Object.entries(ORDER_TIMELINE_STATES).flatMap(([kind, states]) => states.map((state) => [kind, state])))(
    'renders confirmed %s / %s as a human event without source identifiers',
    async (kind, state) => {
      mocks.request.mockResolvedValueOnce(
        page([
          {
            id: `${kind}:private-internal-correlation`,
            kind,
            state,
            createdAt: event().createdAt,
            validationOnly: ['refund', 'fiscal', 'credit'].includes(kind!) ? false : null
          } as OrderTimelineItem
        ])
      )
      const wrapper = await render()
      const item = wrapper.get('[data-timeline-item]')
      expect(item.text()).not.toContain(state)
      expect(item.text().length).toBeGreaterThan(20)
      expect(wrapper.html()).not.toContain('private-internal-correlation')
      expect(wrapper.get('time').attributes('datetime')).toBe(event().createdAt)
      expect(wrapper.get('time').text()).toContain('2026-10-08 12:03:00 UTC')
      expect(item.classes()).toContain('break-words')
    }
  )
  it('calls a capture registered, not settled, and never invents future delivery milestones', async () => {
    mocks.request.mockResolvedValueOnce(
      page([{ ...event(), id: 'payment:capture', kind: 'payment', state: 'captured', validationOnly: null }])
    )
    const wrapper = await render()
    expect(wrapper.text()).toContain('Captura registrada')
    expect(wrapper.get('[data-timeline-item]').text()).toContain('Registro interno; no acredita liquidación bancaria.')
    expect(wrapper.text()).not.toMatch(/cobro confirmado|liquidado|entregado|en tránsito/i)
    expect(wrapper.findAll('[data-timeline-item]')).toHaveLength(1)
  })
  it.each(['refund', 'fiscal', 'credit'] as const)(
    'marks %s validation-only events explicitly as non-real financial evidence',
    async (kind) => {
      const state = kind === 'refund' ? 'succeeded' : 'issued'
      mocks.request.mockResolvedValueOnce(
        page([{ ...event(), id: `${kind}:local`, kind, state, validationOnly: true } as OrderTimelineItem])
      )
      const wrapper = await render()
      expect(wrapper.text()).toContain('Validación local, no acredita un cobro/factura real')
      expect(wrapper.text()).not.toContain('private')
    }
  )
  it.each([
    'actor',
    'reason',
    'correlation',
    'unknown-state',
    'invalid-time',
    'validation',
    'overflow',
    'duplicate',
    'order-reversed'
  ])('rejects private or unconfirmed item %s without rendering any history', async (mode) => {
    const dto: Record<string, unknown> = page()
    const item: Record<string, unknown> = { ...event() }
    if (mode === 'actor') item.actorId = 'private-actor'
    if (mode === 'reason') item.reason = 'private reason'
    if (mode === 'correlation') item.correlationId = 'private-correlation'
    if (mode === 'unknown-state') item.state = 'future_delivery'
    if (mode === 'invalid-time') item.createdAt = '2026-02-31T12:00:00Z'
    if (mode === 'validation') item.validationOnly = true
    dto.items =
      mode === 'overflow'
        ? Array.from({ length: 11 }, (_, i) => ({ ...event(), id: `checkout:row-${i}` }))
        : mode === 'duplicate'
          ? [item, item]
          : mode === 'order-reversed'
            ? [event(1), event(3)]
            : [item]
    mocks.request.mockResolvedValueOnce(dto)
    const wrapper = await render()
    expect(wrapper.find('[data-timeline-error]').exists()).toBe(true)
    expect(wrapper.find('[data-timeline-item]').exists()).toBe(false)
    expect(wrapper.text()).not.toMatch(/private|future_delivery/)
  })
  it('only reads the next snapshot page explicitly and singleflights the exact cursor GET', async () => {
    const first = page([event(3), event(2)], true)
    mocks.request.mockResolvedValueOnce(first)
    const wrapper = await render()
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(mocks.request.mock.calls[0]?.[1].query).toEqual({ limit: 10 })
    const pending = deferred(),
      more = wrapper.get('[data-timeline-more]')
    mocks.request.mockReturnValueOnce(pending.promise)
    await more.trigger('click')
    await more.trigger('click')
    expect(mocks.request).toHaveBeenCalledTimes(2)
    expect(mocks.request.mock.calls[1]?.[1].query).toEqual({ limit: 10, cursor: first.nextCursor })
    pending.resolve(page([event(1)]))
    await flushPromises()
    expect(wrapper.findAll('time').map((time) => time.attributes('datetime'))).toEqual([
      event(3).createdAt,
      event(2).createdAt,
      event(1).createdAt
    ])
    expect(wrapper.find('[data-timeline-more]').exists()).toBe(false)
  })
  it.each(['duplicate', 'newer', 'snapshot', 'foreign-cursor'] as const)(
    'rejects a paginated %s snapshot rather than blending histories',
    async (mode) => {
      mocks.request.mockResolvedValueOnce(page([event(3), event(2)], true))
      const wrapper = await render()
      const second = page([event(1)], mode === 'snapshot' || mode === 'foreign-cursor')
      if (mode === 'duplicate') second.items = [event(2)]
      if (mode === 'newer') second.items = [event(3)]
      if (mode === 'snapshot' || mode === 'foreign-cursor')
        second.nextCursor = encodeOrderTimelineCursor({
          v: 1,
          orderId: mode === 'foreign-cursor' ? OTHER : ORDER,
          audience: 'customer',
          asOf: mode === 'snapshot' ? '2026-10-08T12:06:00Z' : AS_OF,
          at: event(1).createdAt,
          id: event(1).id
        })
      mocks.request.mockResolvedValueOnce(second)
      await wrapper.get('[data-timeline-more]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-timeline-error]').exists()).toBe(true)
      expect(wrapper.find('[data-timeline-item]').exists()).toBe(false)
    }
  )
  it('retries an interrupted page with the same cursor and restores only its confirmed prefix', async () => {
    const first = page([event(3), event(2)], true)
    mocks.request.mockResolvedValueOnce(first)
    const wrapper = await render()
    mocks.request.mockRejectedValueOnce(new Error('offline'))
    await wrapper.get('[data-timeline-more]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-timeline-item]').exists()).toBe(false)
    mocks.request.mockResolvedValueOnce(page([event(1)]))
    await wrapper.get('[data-timeline-retry]').trigger('click')
    await flushPromises()
    expect(mocks.request.mock.calls[2]?.[1].query).toEqual({ limit: 10, cursor: first.nextCursor })
    expect(wrapper.findAll('[data-timeline-item]')).toHaveLength(3)
  })
  it('refreshes from the first page explicitly rather than mixing new events into the older snapshot', async () => {
    mocks.request.mockResolvedValueOnce(page([event(2)], true))
    const wrapper = await render()
    mocks.request.mockResolvedValueOnce(page([event(3)]))
    await wrapper.get('[data-timeline-refresh]').trigger('click')
    await flushPromises()
    expect(mocks.request.mock.calls[1]?.[1].query).toEqual({ limit: 10 })
    expect(wrapper.findAll('[data-timeline-item]')).toHaveLength(1)
    expect(wrapper.get('time').attributes('datetime')).toBe(event(3).createdAt)
  })
  it('purges visible history during permission verification and rereads only when current authority returns', async () => {
    mocks.request.mockResolvedValueOnce(page())
    const wrapper = await render()
    expect(wrapper.find('[data-timeline-item]').exists()).toBe(true)
    await wrapper.setProps({ pending: true })
    expect(wrapper.text()).toBe('')
    expect(mocks.request).toHaveBeenCalledTimes(1)
    mocks.request.mockResolvedValueOnce(empty())
    await wrapper.setProps({ pending: false })
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-timeline-item]').exists()).toBe(false)
    expect(wrapper.find('[data-timeline-empty]').exists()).toBe(true)
  })
})
