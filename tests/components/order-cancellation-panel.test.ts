import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OrderCancellationPanel from '../../app/components/OrderCancellationPanel.vue'
import '#app/nuxt-vitest-app-entry'

// Matrix: authoritative eligibility; explicit valid reason+confirmation; frozen
// POST identity; no automatic replay; manual receipt lookup; strict receipts;
// singleflight/late/unmount/revocation; distinct private accessible states.
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
const ORDER = '10000000-0000-4000-8000-000000000001',
  OTHER = '10000000-0000-4000-8000-000000000002'
const eligibility = () => ({
  source: 'cloudflare',
  orderId: ORDER,
  eligible: true,
  blocker: null,
  orderStatus: 'awaiting_payment',
  paymentStatus: null,
  reservationStatus: 'reserved'
})
const receipt = (key: string) => ({
  source: 'cloudflare',
  orderId: ORDER,
  commandId: key,
  outcome: 'cancelled',
  orderStatus: 'cancelled',
  inventoryEffect: 'released',
  updatedAt: '2026-10-08T12:00:00Z'
})
const cancelledEligibility = () => ({
  ...eligibility(),
  eligible: false,
  blocker: 'order_not_awaiting_payment',
  orderStatus: 'cancelled',
  reservationStatus: 'released'
})
const reason = 'Solicitud expresa del cliente sin pago iniciado.'
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
  const wrapper = await mountSuspended(OrderCancellationPanel, {
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
async function fill(wrapper: Wrapper) {
  await wrapper.get('[data-cancel-reason]').setValue(reason)
  await wrapper.get('[data-cancel-confirm]').setValue(true)
}
async function submit(wrapper: Wrapper) {
  await fill(wrapper)
  await wrapper.get('form').trigger('submit')
  await flushPromises()
}
const posts = () => mocks.request.mock.calls.filter((call) => call[1]?.method === 'POST')
beforeEach(() => {
  mocks.request.mockReset().mockResolvedValue(eligibility())
})
afterEach(() => mounted.splice(0).forEach((wrapper) => wrapper.unmount()))
describe('server-authorized unpaid cancellation panel', () => {
  it.each(['customer', 'admin'] as const)('reads %s eligibility without auto mutation', async (audience) => {
    const wrapper = await render({ audience })
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
      `/api/${audience === 'admin' ? 'admin/' : ''}orders/${ORDER}/cancellation`,
      expect.objectContaining({ method: 'GET', cache: 'no-store', retry: 0 })
    )
    expect(wrapper.get('[data-cancel-submit]').attributes('disabled')).toBeDefined()
    expect(posts()).toHaveLength(0)
  })
  it.each([{ enabled: false }, { pending: true }, { scopeKey: '' }, { orderId: '../private' }])(
    'hides and makes no request for %j',
    async (props) => {
      const wrapper = await render(props)
      expect(wrapper.text()).toBe('')
      expect(mocks.request).not.toHaveBeenCalled()
    }
  )
  it('separates accessible loading and failed eligibility from a confirmed blocker', async () => {
    const waiting = deferred()
    mocks.request.mockReturnValueOnce(waiting.promise)
    const wrapper = await render()
    expect(wrapper.get('[data-cancel-loading]').attributes('role')).toBe('status')
    expect(wrapper.find('[data-cancel-blocker]').exists()).toBe(false)
    waiting.resolve({})
    await flushPromises()
    expect(wrapper.get('[data-cancel-error]').attributes('role')).toBe('alert')
    expect(wrapper.find('form').exists()).toBe(false)
  })
  it.each([
    'order_not_awaiting_payment',
    'payment_history',
    'preparation_history',
    'fiscal_history',
    'reservation_unavailable'
  ])('explains authoritative blocker %s without allowing cancellation', async (blocker) => {
    mocks.request.mockResolvedValueOnce({ ...eligibility(), eligible: false, blocker })
    const wrapper = await render()
    expect(wrapper.get('[data-cancel-blocker]').text().length).toBeGreaterThan(20)
    expect(wrapper.find('form').exists()).toBe(false)
    expect(posts()).toHaveLength(0)
  })
  it.each(['wrong-order', 'private-field', 'cancelled-eligible'])(
    'rejects contradictory/private eligibility %s',
    async (mode) => {
      mocks.request.mockResolvedValueOnce({
        ...eligibility(),
        ...(mode === 'wrong-order'
          ? { orderId: OTHER }
          : mode === 'private-field'
            ? { actorId: 'secret' }
            : { orderStatus: 'cancelled' })
      })
      const wrapper = await render()
      expect(wrapper.find('[data-cancel-error]').exists()).toBe(true)
      expect(wrapper.find('form').exists()).toBe(false)
    }
  )
  it('requires valid reason and explicit checkbox even for forged submit events', async () => {
    const wrapper = await render()
    await wrapper.get('form').trigger('submit')
    await wrapper.get('[data-cancel-reason]').setValue('corto')
    await wrapper.get('[data-cancel-confirm]').setValue(true)
    await wrapper.get('form').trigger('submit')
    expect(posts()).toHaveLength(0)
  })
  it('submits frozen expectedStatus/reason/key once and accepts only matching durable receipt', async () => {
    const wrapper = await render()
    mocks.request.mockImplementationOnce(async (_path: string, options: Record<string, unknown>) =>
      receipt((options.headers as Record<string, string>)['Idempotency-Key']!)
    )
    mocks.request.mockResolvedValueOnce(cancelledEligibility())
    await submit(wrapper)
    expect(posts()).toHaveLength(1)
    const options = posts()[0]![1]
    expect(options.body).toEqual({ expectedStatus: 'awaiting_payment', reason })
    expect(options.headers['Idempotency-Key']).toMatch(/^[a-f0-9-]{36}$/)
    expect(wrapper.get('[data-cancel-receipt]').text()).toContain('Cancelación confirmada')
    expect(wrapper.text()).not.toMatch(/reembolso confirmado|banco|pago devuelto/i)
    expect(wrapper.emitted('pending')).toEqual([[true], [false]])
    expect(wrapper.emitted('confirmed')).toEqual([[receipt(options.headers['Idempotency-Key'])]])
  })
  it('singleflights a double submit and disables editable intent while POST is pending', async () => {
    const wrapper = await render(),
      waiting = deferred()
    mocks.request.mockReturnValueOnce(waiting.promise)
    await fill(wrapper)
    await wrapper.get('form').trigger('submit')
    await wrapper.get('form').trigger('submit')
    expect(posts()).toHaveLength(1)
    expect(wrapper.get('[data-cancel-reason]').attributes('disabled')).toBeDefined()
    waiting.resolve({})
    await flushPromises()
    expect(wrapper.find('[data-cancel-unknown]').exists()).toBe(true)
  })
  it.each([401, 403, 404, 409, 429, 503])(
    'keeps rejected POST %s uncertain, with no automatic retry or success',
    async (statusCode) => {
      const wrapper = await render()
      mocks.request.mockRejectedValueOnce({ statusCode, message: 'SQL secret customer@example.invalid' })
      await submit(wrapper)
      expect(wrapper.find('[data-cancel-unknown]').exists()).toBe(true)
      expect(wrapper.find('[data-cancel-receipt]').exists()).toBe(false)
      expect(wrapper.text()).not.toMatch(/SQL|secret|customer@/)
      expect(posts()).toHaveLength(1)
      expect(wrapper.emitted('pending')).toEqual([[true]])
      expect(wrapper.emitted('confirmed')).toBeUndefined()
      expect(wrapper.get('[data-cancel-replay]').attributes('disabled')).toBeDefined()
    }
  )
  it('requires manual GET before explicit exact replay, never creates a new key or body', async () => {
    const wrapper = await render()
    mocks.request.mockRejectedValueOnce(new Error('lost response'))
    await submit(wrapper)
    const first = posts()[0]!,
      key = first[1].headers['Idempotency-Key']
    mocks.request.mockResolvedValueOnce({ source: 'cloudflare', orderId: ORDER, commandId: key, outcome: 'unknown' })
    await wrapper.get('[data-cancel-check]').trigger('click')
    await flushPromises()
    expect(mocks.request).toHaveBeenLastCalledWith(
      `/api/orders/${ORDER}/cancellation/commands/${key}`,
      expect.objectContaining({ method: 'GET', cache: 'no-store', retry: 0 })
    )
    expect(posts()).toHaveLength(1)
    expect(wrapper.text()).toContain('no confirma')
    mocks.request.mockResolvedValueOnce(receipt(key)).mockResolvedValueOnce(cancelledEligibility())
    await wrapper.get('[data-cancel-replay]').trigger('click')
    await flushPromises()
    expect(posts()).toHaveLength(2)
    expect(posts()[1]![0]).toEqual(first[0])
    expect(posts()[1]![1].body).toEqual(first[1].body)
    expect(posts()[1]![1].headers).toEqual(first[1].headers)
    expect(wrapper.find('[data-cancel-receipt]').exists()).toBe(true)
  })
  it('keeps uncertainty until both matching receipt and current cancelled order are confirmed', async () => {
    const wrapper = await render()
    mocks.request.mockImplementationOnce(async (_path: string, options: Record<string, unknown>) =>
      receipt((options.headers as Record<string, string>)['Idempotency-Key']!)
    )
    mocks.request.mockResolvedValueOnce(eligibility())
    await submit(wrapper)
    expect(wrapper.find('[data-cancel-unknown]').exists()).toBe(true)
    expect(wrapper.find('[data-cancel-receipt]').exists()).toBe(false)
    expect(wrapper.emitted('pending')).toEqual([[true]])
    const key = posts()[0]![1].headers['Idempotency-Key']
    mocks.request.mockResolvedValueOnce(receipt(key)).mockResolvedValueOnce(cancelledEligibility())
    await wrapper.get('[data-cancel-check]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-cancel-receipt]').exists()).toBe(true)
    expect(posts()).toHaveLength(1)
    expect(wrapper.emitted('pending')).toEqual([[true], [false]])
  })
  it.each(['wrong-key', 'wrong-order', 'private-field', 'lookup404'])(
    'does not clear unknown command on %s recovery',
    async (mode) => {
      const wrapper = await render()
      mocks.request.mockRejectedValueOnce(new Error('offline'))
      await submit(wrapper)
      const key = posts()[0]![1].headers['Idempotency-Key']
      if (mode === 'lookup404') mocks.request.mockRejectedValueOnce({ statusCode: 404 })
      else
        mocks.request.mockResolvedValueOnce({
          ...receipt(key),
          ...(mode === 'wrong-key'
            ? { commandId: OTHER }
            : mode === 'wrong-order'
              ? { orderId: OTHER }
              : { actorId: 'secret' })
        })
      await wrapper.get('[data-cancel-check]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-cancel-unknown]').exists()).toBe(true)
      expect(wrapper.find('[data-cancel-receipt]').exists()).toBe(false)
      expect(wrapper.emitted('pending')).toEqual([[true]])
    }
  )
  it.each(['scope', 'order', 'audience', 'enabled', 'pending', 'unmount'])(
    'aborts and purges a late command on %s',
    async (mode) => {
      const wrapper = await render(),
        waiting = deferred()
      mocks.request.mockReturnValueOnce(waiting.promise)
      await fill(wrapper)
      await wrapper.get('form').trigger('submit')
      const call = posts()[0]!,
        signal = call[1].signal as AbortSignal,
        key = call[1].headers['Idempotency-Key']
      if (mode === 'unmount') wrapper.unmount()
      else
        await wrapper.setProps(
          mode === 'scope'
            ? { scopeKey: 'new/session/2' }
            : mode === 'order'
              ? { orderId: OTHER }
              : mode === 'audience'
                ? { audience: 'admin' }
                : mode === 'enabled'
                  ? { enabled: false }
                  : { pending: true }
        )
      expect(signal.aborted).toBe(true)
      waiting.resolve(receipt(key))
      await flushPromises()
      expect(wrapper.find('[data-cancel-receipt]').exists()).toBe(false)
      expect(wrapper.emitted('pending')?.at(-1)).toEqual([false])
    }
  )
  it('provides labeled native keyboard controls and wrapping layout', async () => {
    const wrapper = await render()
    expect(wrapper.get('textarea').attributes('id')).toBeTruthy()
    expect(wrapper.findAll('label').length).toBeGreaterThanOrEqual(2)
    expect(wrapper.get('[data-cancel-submit]').attributes('type')).toBe('submit')
    expect(wrapper.get('section').classes()).toContain('min-w-0')
  })
})
