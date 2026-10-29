import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminCarrierManifests from '../../app/components/AdminCarrierManifests.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const item = (t: string, extra = {}) => ({
  trackingNumber: t,
  shipmentNumber: `S-${t}`,
  orderId: 'ord-1',
  parcelIndex: 0,
  weightGrams: 1000,
  decision: 'included',
  exclusionReason: null,
  scanStatus: 'pending',
  ...extra
})
const view = (extra = {}) => ({
  id: 'm-1',
  carrier: 'correos',
  pickupDate: '2026-10-30',
  status: 'open',
  version: 1,
  includedShipments: 1,
  excludedShipments: 1,
  parcelCount: 1,
  weightGrams: 1000,
  providerManifestId: null,
  closedAt: null,
  createdAt: '2026-10-29T10:00:00Z',
  updatedAt: '2026-10-29T10:00:00Z',
  items: [item('TRK-1'), item('TRK-2', { decision: 'excluded', exclusionReason: 'already_manifested' })],
  documents: [],
  pickup: null,
  reconciliation: {
    candidates: 2,
    included: 1,
    excluded: 1,
    excludedByReason: { already_manifested: 1 },
    balanced: true
  },
  ...extra
})
const summary = {
  id: 'm-1',
  carrier: 'correos',
  pickupDate: '2026-10-30',
  status: 'open',
  version: 1,
  includedShipments: 1,
  excludedShipments: 1,
  parcelCount: 1
}
const apiError = (code: string, details = {}) => Object.assign(new Error(code), { data: { error: { code, details } } })
const mount = async () => {
  const wrapper = await mountSuspended(AdminCarrierManifests)
  await flushPromises()
  return wrapper
}
const open = async (wrapper: Awaited<ReturnType<typeof mount>>) => {
  mocks.request.mockResolvedValueOnce({ manifest: view() })
  await wrapper.find('[data-test="open-m-1"]').trigger('click')
  await flushPromises()
}
const lastBody = () => mocks.request.mock.calls.at(-1)![1].body

beforeEach(() => mocks.request.mockReset())

describe('SHP-028 AdminCarrierManifests', () => {
  it('shows loading, empty and error states', async () => {
    mocks.request.mockImplementation(() => new Promise(() => {}))
    expect((await mountSuspended(AdminCarrierManifests)).find('[role="status"]').text()).toContain('Cargando')
    mocks.request.mockReset()
    mocks.request.mockResolvedValueOnce({ manifests: [] })
    expect((await mount()).text()).toContain('Todavía no hay manifiestos')
    mocks.request.mockReset()
    mocks.request.mockRejectedValueOnce(apiError('forbidden'))
    expect((await mount()).find('[role="alert"]').text()).toContain('permisos')
  })

  it('lists manifests and shows reconciliation with per-reason exclusions', async () => {
    mocks.request.mockResolvedValueOnce({ manifests: [summary] })
    const wrapper = await mount()
    expect(wrapper.text()).toContain('correos')
    await open(wrapper)
    expect(wrapper.find('[data-test="reconciliation"]').text()).toContain('2 expediciones: 1 incluidas')
    expect(wrapper.find('[data-test="reconciliation"]').text()).toContain('Ya manifestada: 1')
    expect(wrapper.text()).toContain('TRK-2')
  })

  it('flags an unbalanced reconciliation', async () => {
    mocks.request.mockResolvedValueOnce({ manifests: [summary] })
    const wrapper = await mount()
    mocks.request.mockResolvedValueOnce({
      manifest: view({
        reconciliation: { candidates: 2, included: 1, excluded: 1, excludedByReason: {}, balanced: false }
      })
    })
    await wrapper.find('[data-test="open-m-1"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="reconciliation"]').text()).toContain('Descuadre')
  })

  it('creates a manifest with a command id and refreshes the list', async () => {
    mocks.request.mockResolvedValueOnce({ manifests: [] })
    const wrapper = await mount()
    mocks.request.mockResolvedValueOnce({ manifest: view() }).mockResolvedValueOnce({ manifests: [summary] })
    await wrapper.find('[data-test="carrier"]').setValue(' correos ')
    await wrapper.find('[data-test="pickup-date"]').setValue('2026-10-30')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    const [url, options] = mocks.request.mock.calls[1]!
    expect(url).toBe('/api/admin/carrier-manifests')
    expect(options.method).toBe('POST')
    expect(options.body).toMatchObject({ carrier: 'correos', pickupDate: '2026-10-30' })
    expect(options.body.commandId).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(wrapper.text()).toContain('Manifiesto creado')
  })

  it('holds a shipment with the current version and maps conflicts to a message', async () => {
    mocks.request.mockResolvedValueOnce({ manifests: [summary] })
    const wrapper = await mount()
    await open(wrapper)
    mocks.request.mockRejectedValueOnce(apiError('version_conflict'))
    await wrapper.find('[data-test="hold-TRK-1"]').trigger('click')
    await flushPromises()
    expect(lastBody()).toMatchObject({ trackingNumber: 'TRK-1', decision: 'excluded', expectedVersion: 1 })
    expect(wrapper.find('[role="alert"]').text()).toContain('Otro usuario')
  })

  it('closes, then exposes archived document links', async () => {
    mocks.request.mockResolvedValueOnce({ manifests: [summary] })
    const wrapper = await mount()
    await open(wrapper)
    mocks.request
      .mockResolvedValueOnce({
        manifest: view({
          status: 'closed',
          version: 2,
          documents: [
            { kind: 'manifest_csv', sha256: 'a'.repeat(64), byteLength: 10, createdAt: '2026-10-29T10:00:00Z' }
          ]
        })
      })
      .mockResolvedValueOnce({ manifests: [] })
    await wrapper.find('[data-test="close"]').trigger('click')
    await flushPromises()
    expect(mocks.request.mock.calls.at(-2)![0]).toBe('/api/admin/carrier-manifests/m-1/close')
    expect(wrapper.find('[data-test="doc-manifest_csv"]').attributes('href')).toBe(
      '/api/admin/carrier-manifests/m-1/documents/manifest_csv'
    )
    expect(wrapper.find('[data-test="schedule"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="close"]').exists()).toBe(false)
  })

  it('sends parsed scans when conciliating a scheduled pickup', async () => {
    mocks.request.mockResolvedValueOnce({ manifests: [summary] })
    const wrapper = await mount()
    mocks.request.mockResolvedValueOnce({
      manifest: view({
        status: 'closed',
        version: 3,
        pickup: {
          providerPickupId: 'PUP-1',
          scheduledDate: '2026-10-30',
          parcelCount: 1,
          status: 'scheduled',
          scannedCount: null,
          missingCount: null,
          unexpectedTrackings: [],
          confirmedAt: null
        }
      })
    })
    await wrapper.find('[data-test="open-m-1"]').trigger('click')
    await flushPromises()
    mocks.request
      .mockResolvedValueOnce({
        manifest: view({
          status: 'discrepancy',
          version: 4,
          pickup: {
            providerPickupId: 'PUP-1',
            scheduledDate: '2026-10-30',
            parcelCount: 1,
            status: 'discrepancy',
            scannedCount: 0,
            missingCount: 1,
            unexpectedTrackings: ['X-9'],
            confirmedAt: '2026-10-30T10:00:00Z'
          }
        })
      })
      .mockResolvedValueOnce({ manifests: [] })
    await wrapper.find('[data-test="scans"]').setValue('X-9\n  TRK-9  \n\n')
    await wrapper.findAll('form')[1]!.trigger('submit')
    await flushPromises()
    const call = mocks.request.mock.calls.find(([url]) => String(url).endsWith('/pickup/confirm'))!
    expect(call[1].body.scannedTrackingNumbers).toEqual(['X-9', 'TRK-9'])
    expect(call[1].body.expectedVersion).toBe(3)
    expect(wrapper.find('[data-test="pickup"]').text()).toContain('faltan 1')
  })
})
