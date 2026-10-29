/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON/fetch doubles in this test file */
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DeliveryDriverApp from '../../app/components/DeliveryDriverApp.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const stop = (id: string, extra = {}) => ({
  id,
  sequenceIndex: id === 's-1' ? 0 : 1,
  recipientName: id === 's-1' ? 'Taller Alfa' : 'Bar Beta',
  streetAddress: id === 's-1' ? 'Calle Mayor 1 & 2' : 'Calle B 2',
  postalCode: '46870',
  city: 'Ontinyent',
  parcelCount: 2,
  weightGrams: 3000,
  timeWindowStart: '09:00',
  timeWindowEnd: '10:00',
  status: 'pending',
  failureReason: null,
  completedAt: null,
  incidentCount: 0,
  pod: null,
  ...extra
})
const manifest = (status = 'planned', stops = [stop('s-1'), stop('s-2')]) => ({
  serverTime: now(),
  routeDate: now().slice(0, 10),
  routes: [
    {
      id: 'r-1',
      routeDate: now().slice(0, 10),
      status,
      version: 1,
      windowStart: '08:00',
      windowEnd: '16:00',
      vehicleName: 'Furgoneta 1',
      totalStops: stops.length,
      totalParcels: 4,
      stops
    }
  ]
})
const httpError = (status: number, code = 'forbidden') =>
  Object.assign(new Error(code), { response: { status }, data: { error: { code } } })
const networkError = () => new TypeError('Failed to fetch')
const mount = async () => {
  const wrapper = await mountSuspended(DeliveryDriverApp)
  await flushPromises()
  return wrapper
}
const sentEvents = () =>
  mocks.request.mock.calls
    .filter(([url]) => url === '/api/delivery/sync')
    .flatMap(([, options]) => options.body.events as Array<Record<string, any>>)

beforeEach(() => {
  mocks.request.mockReset()
  localStorage.clear()
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
})

describe('SHP-027 DeliveryDriverApp', () => {
  it('shows a loading state, then the manifest with navigation links and no private identifiers', async () => {
    mocks.request.mockImplementation(() => new Promise(() => {}))
    const loading = await mountSuspended(DeliveryDriverApp)
    expect(loading.find('[role="status"]').text()).toContain('Cargando')
    mocks.request.mockReset()
    mocks.request.mockResolvedValueOnce(manifest())
    const wrapper = await mount()
    expect(wrapper.text()).toContain('Taller Alfa')
    expect(wrapper.text()).toContain('Bar Beta')
    expect(wrapper.text()).toContain('Furgoneta 1')
    const link = new URL(wrapper.find('[data-test="nav-s-1"]').attributes('href')!)
    expect(link.searchParams.get('destination')).toBe('Calle Mayor 1 & 2, 46870 Ontinyent')
    expect(wrapper.find('[data-test="nav-s-1"]').attributes('rel')).toContain('noopener')
    expect(mocks.request).toHaveBeenCalledWith('/api/delivery/manifest', expect.anything())
  })

  it('renders an empty state when there are no routes today', async () => {
    mocks.request.mockResolvedValueOnce({ serverTime: now(), routeDate: now().slice(0, 10), routes: [] })
    expect((await mount()).text()).toContain('No tienes rutas asignadas')
  })

  it('shows an actionable error on authorisation failures and does not use stale data', async () => {
    mocks.request.mockRejectedValueOnce(httpError(403))
    const wrapper = await mount()
    expect(wrapper.find('[role="alert"]').text()).toContain('No tienes acceso')
    mocks.request.mockReset()
    mocks.request.mockRejectedValueOnce(httpError(401, 'unauthorized'))
    expect((await mount()).find('[role="alert"]').text()).toContain('sesión')
  })

  it('falls back to a fresh cached manifest when offline, and refuses an expired cache', async () => {
    mocks.request.mockResolvedValueOnce(manifest())
    await mount()
    mocks.request.mockReset()
    mocks.request.mockRejectedValueOnce(networkError())
    const offline = await mount()
    expect(offline.find('[data-test="offline-banner"]').text()).toContain('Sin conexión')
    expect(offline.text()).toContain('Taller Alfa')
    const key = Object.keys(localStorage).find((k) => k.includes('manifest'))!
    const cached = JSON.parse(localStorage.getItem(key)!)
    cached.savedAt = '2020-01-01T00:00:00Z'
    localStorage.setItem(key, JSON.stringify(cached))
    mocks.request.mockReset()
    mocks.request.mockRejectedValueOnce(networkError())
    const expired = await mount()
    expect(expired.find('[role="alert"]').exists()).toBe(true)
    expect(expired.text()).not.toContain('Taller Alfa')
  })

  it('starts the route through the sync endpoint and reflects the new state', async () => {
    mocks.request.mockResolvedValueOnce(manifest())
    const wrapper = await mount()
    mocks.request.mockImplementation(async (url: string, options: any) =>
      url === '/api/delivery/sync'
        ? { results: options.body.events.map((e: any) => ({ commandId: e.commandId, outcome: 'applied' })) }
        : manifest('in_progress')
    )
    await wrapper.find('[data-test="start-route"]').trigger('click')
    await flushPromises()
    expect(sentEvents()).toHaveLength(1)
    expect(sentEvents()[0]).toMatchObject({ kind: 'start_route', routeId: 'r-1' })
    expect(sentEvents()[0]!.commandId).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(wrapper.find('[data-test="start-route"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="pending-count"]').exists()).toBe(false)
  })

  it('queues events while offline, shows them as pending, and syncs when back online', async () => {
    mocks.request.mockResolvedValueOnce(manifest('in_progress'))
    const wrapper = await mount()
    mocks.request.mockRejectedValue(networkError())
    await wrapper.find('[data-test="fail-open-s-1"]').trigger('click')
    await wrapper.find('[data-test="fail-reason"]').setValue('customer_absent')
    await wrapper.find('[data-test="fail-submit"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="pending-count"]').text()).toContain('1')
    expect(wrapper.find('[data-test="offline-banner"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="stop-s-1"]').text()).toContain('No entregado')
    expect(Object.keys(localStorage).some((k) => k.includes('queue'))).toBe(true)
    mocks.request.mockReset()
    mocks.request.mockImplementation(async (url: string, options: any) =>
      url === '/api/delivery/sync'
        ? { results: options.body.events.map((e: any) => ({ commandId: e.commandId, outcome: 'applied' })) }
        : manifest('in_progress', [stop('s-1', { status: 'failed' }), stop('s-2')])
    )
    window.dispatchEvent(new Event('online'))
    await flushPromises()
    expect(sentEvents()).toHaveLength(1)
    expect(sentEvents()[0]).toMatchObject({ kind: 'fail', stopId: 's-1', reason: 'customer_absent' })
    expect(wrapper.find('[data-test="pending-count"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="offline-banner"]').exists()).toBe(false)
  })

  it('keeps events when the server answers with an authorisation failure', async () => {
    mocks.request.mockResolvedValueOnce(manifest('in_progress'))
    const wrapper = await mount()
    mocks.request.mockRejectedValue(httpError(401, 'unauthorized'))
    await wrapper.find('[data-test="fail-open-s-1"]').trigger('click')
    await wrapper.find('[data-test="fail-submit"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="pending-count"]').text()).toContain('1')
    expect(wrapper.find('[role="alert"]').text()).toContain('sesión')
  })

  it('reports permanently rejected events once and drops them from the queue', async () => {
    mocks.request.mockResolvedValueOnce(manifest('in_progress'))
    const wrapper = await mount()
    mocks.request.mockImplementation(async (url: string, options: any) =>
      url === '/api/delivery/sync'
        ? {
            results: options.body.events.map((e: any) => ({
              commandId: e.commandId,
              outcome: 'rejected',
              error: { code: 'invalid_transition' }
            }))
          }
        : manifest('in_progress')
    )
    await wrapper.find('[data-test="incident-open-s-2"]').trigger('click')
    await wrapper.find('[data-test="incident-category"]').setValue('damaged_parcel')
    await wrapper.find('[data-test="incident-note"]').setValue('Caja golpeada')
    await wrapper.find('[data-test="incident-submit"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="rejected-notice"]').text()).toContain('invalid_transition')
    expect(wrapper.find('[data-test="pending-count"]').exists()).toBe(false)
    expect(sentEvents()[0]).toMatchObject({
      kind: 'incident',
      stopId: 's-2',
      category: 'damaged_parcel',
      note: 'Caja golpeada'
    })
  })

  it('validates the delivery form and sends a neighbour proof of delivery', async () => {
    mocks.request.mockResolvedValueOnce(manifest('in_progress'))
    const wrapper = await mount()
    await wrapper.find('[data-test="deliver-open-s-1"]').trigger('click')
    await wrapper.find('[data-test="pod-method"]').setValue('neighbour')
    const before = mocks.request.mock.calls.length
    await wrapper.find('[data-test="deliver-submit"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="deliver-error"]').text()).toContain('nombre')
    expect(mocks.request.mock.calls.length).toBe(before)
    mocks.request.mockImplementation(async (url: string, options: any) =>
      url === '/api/delivery/sync'
        ? { results: options.body.events.map((e: any) => ({ commandId: e.commandId, outcome: 'applied' })) }
        : manifest('in_progress', [stop('s-1', { status: 'delivered' }), stop('s-2')])
    )
    await wrapper.find('[data-test="received-by"]').setValue('Vecina Maria')
    await wrapper.find('[data-test="deliver-submit"]').trigger('click')
    await flushPromises()
    expect(sentEvents()[0]).toMatchObject({
      kind: 'deliver',
      stopId: 's-1',
      pod: { method: 'neighbour', receivedBy: 'Vecina Maria' }
    })
    expect(wrapper.find('[data-test="stop-s-1"]').text()).toContain('Entregado')
  })

  it('requires a drawn signature or photo before sending those methods', async () => {
    mocks.request.mockResolvedValueOnce(manifest('in_progress'))
    const wrapper = await mount()
    await wrapper.find('[data-test="deliver-open-s-1"]').trigger('click')
    await wrapper.find('[data-test="pod-method"]').setValue('signature')
    await wrapper.find('[data-test="received-by"]').setValue('Ana')
    const before = mocks.request.mock.calls.length
    await wrapper.find('[data-test="deliver-submit"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="deliver-error"]').text()).toMatch(/firma/i)
    expect(mocks.request.mock.calls.length).toBe(before)
  })

  it('wipes cached manifest and queue on demand', async () => {
    mocks.request.mockResolvedValueOnce(manifest('in_progress'))
    const wrapper = await mount()
    mocks.request.mockRejectedValue(networkError())
    await wrapper.find('[data-test="fail-open-s-1"]').trigger('click')
    await wrapper.find('[data-test="fail-submit"]').trigger('click')
    await flushPromises()
    expect(Object.keys(localStorage).length).toBeGreaterThan(0)
    await wrapper.find('[data-test="clear-local"]').trigger('click')
    await flushPromises()
    expect(Object.keys(localStorage).filter((k) => k.includes('delivery'))).toEqual([])
  })
})
