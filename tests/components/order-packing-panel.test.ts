import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { computed, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OrderFulfillmentSection from '../../app/components/OrderFulfillmentSection.vue'
import { orderPackingIntentHash } from '../../shared/order-packing'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn(), read: vi.fn(), session: vi.fn(), navigation: vi.fn() }))
mockNuxtImport('$fetch', () => mocks.request)
mockNuxtImport('useRequestFetch', () => () => mocks.read)
mockNuxtImport('useUserSession', () => mocks.session)
vi.mock('../../app/composables/useAdminNavigation', () => ({ useAdminNavigation: mocks.navigation }))
const ORDER = '30000000-0000-4000-8000-000000000069'
const ACTOR = '10000000-0000-4000-8000-000000000069'
const SESSION = '20000000-0000-4000-8000-000000000069'
const TIME = '2026-10-09T12:00:00Z'
const parcel = () => ({
  weightGrams: 1500,
  widthMm: 300,
  heightMm: 200,
  depthMm: 100,
  contents: [{ lineIndex: 0, quantity: 2 }]
})
function packing(version = 0) {
  return {
    source: 'cloudflare',
    orderId: ORDER,
    version,
    state: version ? 'packed' : 'unpacked',
    fulfillmentVersion: 2,
    fulfillmentState: 'packed',
    shippingMethod: 'parcel',
    lines: [{ lineIndex: 0, sku: 'SYN-PACK-69', name: 'Producto sintético', quantity: 2 }],
    parcels: version ? [parcel()] : [],
    dispatch: null,
    quotedGrossCents: 800,
    readiness: { ready: true, blockers: [] },
    capabilities: { packingWrite: true, manualDispatch: version > 0 },
    evaluatedAt: TIME
  }
}
function fulfillment() {
  return {
    source: 'cloudflare',
    orderId: ORDER,
    warehouse: { id: 'main', code: 'MAIN', name: 'Almacén sintético' },
    shippingMethod: 'parcel',
    state: 'packed',
    interruptedState: null,
    version: 2,
    readiness: { ready: true, blockers: [] },
    capabilities: { fulfillmentRead: true, fulfillmentTransitions: true, allowedActions: ['in_transit', 'exception'] },
    inventoryPolicy: 'allocated_on_payment_no_fulfillment_decrement',
    timeline: { items: [], pagination: { page: 1, perPage: 25, total: 2, pages: 1 } },
    evaluatedAt: TIME
  }
}
let auth: {
  ready: ReturnType<typeof ref<boolean>>
  loggedIn: ReturnType<typeof ref<boolean>>
  user: ReturnType<typeof ref>
  session: ReturnType<typeof ref>
}
const permission = ref(true)
const mounted: Array<{ unmount(): void }> = []
beforeEach(() => {
  auth = {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: ACTOR, emailVerified: true, mfaVerified: true }),
    session: ref({ sessionId: SESSION, sessionVersion: 1 })
  }
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
  mocks.read
    .mockReset()
    .mockImplementation((path, options) =>
      path.includes('/packing') ? mocks.request(path, options) : Promise.resolve(fulfillment())
    )
  mocks.request.mockReset().mockResolvedValue(packing())
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
})
async function render(runtime = 'cloudflare') {
  const wrapper = await mountSuspended(OrderFulfillmentSection, { props: { orderId: ORDER, runtime } })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
type Wrapper = Awaited<ReturnType<typeof render>>
const region = (wrapper: Wrapper) => wrapper.get('[aria-label="Embalaje y expedición manual"]')
async function fill(wrapper: Wrapper, quantity = '2') {
  for (const [field, value] of Object.entries({ weight: '1500', width: '300', height: '200', depth: '100', quantity }))
    await region(wrapper)
      .get(`[data-testid="packing-${field}-0${field === 'quantity' ? '-0' : ''}"]`)
      .setValue(value)
  await region(wrapper).get('[data-testid="packing-reason"]').setValue('Medidas verificadas del bulto sintético')
}
async function review(wrapper: Wrapper) {
  await fill(wrapper)
  await region(wrapper).get('[data-testid="packing-review"]').trigger('click')
  await flushPromises()
  await vi.waitFor(() => expect(region(wrapper).find('[data-testid="packing-confirm"]').exists()).toBe(true))
}
async function receipt(body: unknown, key: string) {
  return {
    source: 'cloudflare',
    orderId: ORDER,
    commandId: key,
    action: 'pack',
    version: 1,
    fulfillmentVersion: 2,
    payloadHash: await orderPackingIntentHash(ORDER, body),
    parcelCount: 1,
    recordedAt: TIME,
    inventoryEffect: 'none',
    economicEffect: 'none',
    providerEffect: 'none'
  }
}
function defer<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
describe('packing integrated with confirmed fulfillment', () => {
  it('mounts an authorized packing workflow alongside the existing fulfillment controls', async () => {
    const wrapper = await render()
    expect(region(wrapper).text()).toContain('SYN-PACK-69')
    expect(wrapper.find('[data-testid="fulfillment-action"]').exists()).toBe(true)
    expect(mocks.request).toHaveBeenCalledWith(
      `/api/admin/orders/${ORDER}/packing`,
      expect.objectContaining({ retry: 0, cache: 'no-store' })
    )
    expect(mocks.request.mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true)
  })
  it('keeps Node untouched without any native packing reads', async () => {
    const wrapper = await render('node')
    expect(wrapper.find('[aria-label="Embalaje y expedición manual"]').exists()).toBe(false)
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('starts real measurements empty and cannot review invented dimensions', async () => {
    const wrapper = await render()
    expect((region(wrapper).get('[data-testid="packing-weight-0"]').element as HTMLInputElement).value).toBe('')
    await region(wrapper).get('[data-testid="packing-review"]').trigger('click')
    expect(region(wrapper).find('[data-testid="packing-confirm"]').exists()).toBe(false)
    expect(mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
  })
  it.each(['1', '3'])('rejects contents that do not exactly match contractual quantity: %s', async (quantity) => {
    const wrapper = await render()
    await fill(wrapper, quantity)
    await region(wrapper).get('[data-testid="packing-review"]').trigger('click')
    await flushPromises()
    expect(region(wrapper).find('[data-testid="packing-confirm"]').exists()).toBe(false)
  })
  it('allows adding and removing real empty parcels without automatically writing', async () => {
    const wrapper = await render()
    await region(wrapper).get('[data-testid="packing-add-parcel"]').trigger('click')
    expect(region(wrapper).find('[data-testid="packing-weight-1"]').exists()).toBe(true)
    expect((region(wrapper).get('[data-testid="packing-weight-1"]').element as HTMLInputElement).value).toBe('')
    await region(wrapper).get('[data-testid="packing-remove-parcel-1"]').trigger('click')
    expect(region(wrapper).find('[data-testid="packing-weight-1"]').exists()).toBe(false)
  })
  it('freezes review and blocks competing fulfillment without sending until explicit confirmation', async () => {
    const wrapper = await render()
    await review(wrapper)
    expect(region(wrapper).find('[data-testid="packing-confirm"]').exists()).toBe(true)
    expect(
      (wrapper.get('[data-testid="fulfillment-action"]').element.closest('fieldset') as HTMLFieldSetElement).disabled
    ).toBe(true)
    await wrapper.get('[data-testid="fulfillment-action"]').setValue('in_transit')
    await wrapper.get('[data-testid="fulfillment-reason"]').setValue('No debe competir con una revisión de embalaje')
    await wrapper.get('[data-testid="fulfillment-evidence"]').setValue('Referencia sintética no enviada')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.find('[data-testid="fulfillment-confirm"]').exists()).toBe(false)
    expect(mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
    await region(wrapper).get('[data-testid="packing-cancel-review"]').trigger('click')
    expect(
      (wrapper.get('[data-testid="fulfillment-action"]').element.closest('fieldset') as HTMLFieldSetElement).disabled
    ).toBe(false)
  })
  it('blocks preparing packing while fulfillment already has a reviewed intention', async () => {
    const wrapper = await render()
    await wrapper.get('[data-testid="fulfillment-action"]').setValue('in_transit')
    await wrapper.get('[data-testid="fulfillment-reason"]').setValue('Salida de almacén confirmada manualmente')
    await wrapper.get('[data-testid="fulfillment-evidence"]').setValue('Referencia operativa sintética 69')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[data-testid="fulfillment-confirm"]').exists()).toBe(true)
    expect((region(wrapper).get('[data-testid="packing-review"]').element as HTMLButtonElement).disabled).toBe(true)
  })
  it('requires receipt and a matching fresh projection before releasing a successful command', async () => {
    const wrapper = await render()
    await review(wrapper)
    mocks.request.mockImplementation(async (_path, options) =>
      options?.method === 'POST' ? receipt(options.body, options.headers['Idempotency-Key']) : packing(1)
    )
    await region(wrapper).get('[data-testid="packing-confirm"]').trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(region(wrapper).text()).toContain('Registro confirmado'))
    expect(mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    expect(region(wrapper).text()).toContain('Registro confirmado')
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([false])
  })
  it('retains uncertainty after response loss and recovers only through exact receipt plus fresh read', async () => {
    const wrapper = await render()
    await review(wrapper)
    let original: { body: unknown; headers: Record<string, string> } | undefined
    mocks.request.mockImplementation(async (_path, options) => {
      if (options?.method === 'POST') {
        original = options
        throw new Error('lost response')
      }
      if (_path.includes('/commands/'))
        return {
          source: 'cloudflare',
          outcome: 'applied',
          receipt: await receipt(original!.body, original!.headers['Idempotency-Key']!)
        }
      return packing(1)
    })
    await region(wrapper).get('[data-testid="packing-confirm"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([true])
    await region(wrapper).get('[data-testid="packing-recover"]').trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(wrapper.emitted('pending')?.at(-1)).toEqual([false]))
    expect(mocks.request).toHaveBeenCalledWith(
      `/api/admin/orders/${ORDER}/packing/commands/${original!.headers['Idempotency-Key']}`,
      expect.objectContaining({
        headers: { 'X-Neteco-Command-Payload-Hash': await orderPackingIntentHash(ORDER, original!.body) }
      })
    )
    expect(mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([false])
  })
  it('unknown is not absence and never enables a second POST or a new command', async () => {
    const wrapper = await render()
    await review(wrapper)
    mocks.request.mockRejectedValueOnce(new Error('lost'))
    await region(wrapper).get('[data-testid="packing-confirm"]').trigger('click')
    await flushPromises()
    mocks.request.mockResolvedValueOnce({ source: 'cloudflare', outcome: 'unknown' })
    await region(wrapper).get('[data-testid="packing-recover"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([true])
    expect(region(wrapper).find('[data-testid="packing-confirm"]').exists()).toBe(false)
    expect(region(wrapper).find('[data-testid="packing-cancel-review"]').exists()).toBe(false)
  })
  it.each(['version_conflict', 'fulfillment_version_conflict'])(
    'releases only a canonical first POST CAS rejection: %s',
    async (code) => {
      const wrapper = await render()
      await review(wrapper)
      mocks.request.mockRejectedValueOnce({ statusCode: 409, data: { error: { code } } })
      await region(wrapper).get('[data-testid="packing-confirm"]').trigger('click')
      await flushPromises()
      expect(wrapper.emitted('pending')?.at(-1)).toEqual([false])
      expect(region(wrapper).text()).not.toContain('SYN-PACK-69')
      expect(region(wrapper).find('[data-testid="packing-recover"]').exists()).toBe(false)
      expect(mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
      mocks.request.mockResolvedValueOnce(packing())
      await region(wrapper)
        .findAll('button')
        .find((button) => button.text() === 'Actualizar embalaje')!
        .trigger('click')
      await flushPromises()
      expect(region(wrapper).text()).toContain('SYN-PACK-69')
      expect(mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    }
  )
  it.each([401, 403])(
    'purges private facts and intentions on confirmed %s even with unchanged session props',
    async (statusCode) => {
      const wrapper = await render()
      await review(wrapper)
      mocks.request.mockRejectedValueOnce({ statusCode })
      await region(wrapper).get('[data-testid="packing-confirm"]').trigger('click')
      await flushPromises()
      expect(region(wrapper).text()).not.toContain('SYN-PACK-69')
      expect(region(wrapper).find('[data-testid="packing-recover"]').exists()).toBe(false)
      expect(wrapper.emitted('pending')?.at(-1)).toEqual([false])
    }
  )
  it('purges immediately on live capability revocation and ignores an old read', async () => {
    const pending = defer<ReturnType<typeof packing>>()
    mocks.request.mockReturnValueOnce(pending.promise)
    const wrapper = await render()
    permission.value = false
    await flushPromises()
    pending.resolve(packing())
    await flushPromises()
    expect(wrapper.text()).not.toContain('SYN-PACK-69')
    expect(wrapper.find('[data-testid="packing-review"]').exists()).toBe(false)
  })
  it('does not turn malformed private data into an empty writable packing', async () => {
    mocks.request.mockResolvedValueOnce({ ...packing(), orderId: ACTOR })
    const wrapper = await render()
    expect(region(wrapper).find('[role="alert"]').exists()).toBe(true)
    expect(region(wrapper).find('[data-testid="packing-review"]').exists()).toBe(false)
  })
  it('explains manual shipment references are not labels or carrier confirmation', async () => {
    mocks.request.mockResolvedValueOnce(packing(1))
    const wrapper = await render()
    await region(wrapper).get('[data-testid="packing-dispatch-mode"]').trigger('click')
    expect(region(wrapper).text()).toContain('no confirma al transportista')
    expect(region(wrapper).text()).toContain('no genera etiquetas')
    expect((region(wrapper).get('[data-testid="packing-carrier-0"]').element as HTMLInputElement).value).toBe('')
    expect((region(wrapper).get('[data-testid="packing-actual-net"]').element as HTMLInputElement).value).toBe('')
    expect(region(wrapper).text()).toContain('8,00')
  })
  it('reviews per-parcel manual references and actual cost without changing historical quote or auto-dispatching', async () => {
    mocks.request.mockResolvedValueOnce(packing(1))
    const wrapper = await render()
    await region(wrapper).get('[data-testid="packing-dispatch-mode"]').trigger('click')
    for (const [field, value] of Object.entries({
      carrier: 'Operador externo',
      shipment: 'EXP-69',
      tracking: 'TRACK-69',
      label: 'LABEL-69'
    }))
      await region(wrapper).get(`[data-testid="packing-${field}-0"]`).setValue(value)
    await region(wrapper).get('[data-testid="packing-actual-net"]').setValue('1000')
    await region(wrapper).get('[data-testid="packing-tax"]').setValue('2100')
    await region(wrapper).get('[data-testid="packing-reason"]').setValue('Referencia externa verificada de expedición')
    await region(wrapper).get('[data-testid="packing-review"]').trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(region(wrapper).find('[data-testid="packing-confirm"]').exists()).toBe(true))
    expect(region(wrapper).find('[data-testid="packing-confirm"]').exists()).toBe(true)
    expect(region(wrapper).text()).toContain('12,10')
    expect(region(wrapper).text()).toContain('8,00')
    expect(mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
  })
  it('does not confirm a receipt followed by an older packing snapshot', async () => {
    const wrapper = await render()
    await review(wrapper)
    mocks.request.mockImplementation(async (_path, options) =>
      options?.method === 'POST' ? receipt(options.body, options.headers['Idempotency-Key']) : packing()
    )
    await region(wrapper).get('[data-testid="packing-confirm"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([true])
    expect(region(wrapper).find('[data-testid="packing-recover"]').exists()).toBe(true)
    expect(region(wrapper).text()).not.toContain('Registro confirmado')
  })
  it('records manual dispatch with exact per-bulto references only after receipt and the actual matching projection', async () => {
    mocks.request.mockResolvedValueOnce(packing(1))
    const wrapper = await render()
    await region(wrapper).get('[data-testid="packing-dispatch-mode"]').trigger('click')
    for (const [field, value] of Object.entries({
      carrier: 'Operador externo',
      shipment: 'EXP-69',
      tracking: 'TRACK-69',
      label: 'LABEL-69'
    }))
      await region(wrapper).get(`[data-testid="packing-${field}-0"]`).setValue(value)
    await region(wrapper).get('[data-testid="packing-actual-net"]').setValue('1000')
    await region(wrapper).get('[data-testid="packing-tax"]').setValue('2100')
    await region(wrapper).get('[data-testid="packing-reason"]').setValue('Referencia externa verificada de expedición')
    await region(wrapper).get('[data-testid="packing-review"]').trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(region(wrapper).find('[data-testid="packing-confirm"]').exists()).toBe(true))
    let fresh: unknown
    mocks.request.mockImplementation(async (_path, options) => {
      if (options?.method !== 'POST') return fresh
      const result = {
        ...(await receipt(
          {
            action: 'pack',
            expectedVersion: 0,
            expectedFulfillmentVersion: 2,
            reason: 'Motivo sintético real',
            parcels: [parcel()]
          },
          options.headers['Idempotency-Key']
        )),
        action: 'manual_dispatch',
        version: 2,
        payloadHash: await orderPackingIntentHash(ORDER, options.body)
      }
      fresh = {
        ...packing(2),
        state: 'manual_dispatch_recorded',
        capabilities: { packingWrite: false, manualDispatch: false },
        dispatch: {
          commandId: result.commandId,
          packingVersion: 1,
          shipments: options.body.shipments,
          actualNetCents: 1000,
          taxBps: 2100,
          actualTaxCents: 210,
          actualGrossCents: 1210,
          quotedGrossCents: 800,
          varianceGrossCents: 410,
          recordedAt: TIME,
          labelVerification: 'unverified_reference_only'
        }
      }
      return result
    })
    await region(wrapper).get('[data-testid="packing-confirm"]').trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(region(wrapper).text()).toContain('Registro confirmado'))
    expect(region(wrapper).text()).toContain('Registro confirmado')
    expect(region(wrapper).text()).toContain('LABEL-69')
    expect(mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([false])
  })
  it('coalesces a double confirmation into one POST and keeps its frozen body', async () => {
    const wrapper = await render()
    await review(wrapper)
    const pending = defer<unknown>()
    mocks.request.mockReturnValueOnce(pending.promise)
    const button = region(wrapper).get('[data-testid="packing-confirm"]')
    await button.trigger('click')
    await button.trigger('click')
    await flushPromises()
    const posts = mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]![1].body).toEqual({
      action: 'pack',
      expectedVersion: 0,
      expectedFulfillmentVersion: 2,
      reason: 'Medidas verificadas del bulto sintético',
      parcels: [parcel()]
    })
    expect(posts[0]![1].headers['Idempotency-Key']).toMatch(/^[a-f0-9-]{36}$/)
    pending.resolve(await receipt(posts[0]![1].body, posts[0]![1].headers['Idempotency-Key']))
    await flushPromises()
  })
})
