import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminDeliveryAppReport from '../../app/components/AdminDeliveryAppReport.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
const apiError = (code: string) => Object.assign(new Error(code), { data: { error: { code } } })
const report = {
  route: { id: 'r-1', status: 'completed', version: 4, routeDate: '2026-10-29' },
  events: [
    {
      commandId: 'c1',
      kind: 'deliver',
      stopId: 's-1',
      driverId: 'd-1',
      occurredAt: '2026-10-29T09:30:00Z',
      receivedAt: '2026-10-29T10:00:00Z'
    }
  ],
  incidents: [
    { id: 'i1', stopId: 's-2', category: 'damaged_parcel', note: 'Caja golpeada', occurredAt: '2026-10-29T09:40:00Z' }
  ],
  pods: [
    {
      stopId: 's-1',
      method: 'signature',
      receivedBy: 'Ana',
      capturedAt: '2026-10-29T09:30:00Z',
      hasEvidence: true,
      evidenceSha256: 'a'.repeat(64),
      evidenceBytes: 80
    }
  ]
}
const load = async (id = 'r-1') => {
  const wrapper = await mountSuspended(AdminDeliveryAppReport)
  await wrapper.find('[data-test="route-id"]').setValue(id)
  await wrapper.find('form').trigger('submit')
  await flushPromises()
  return wrapper
}
beforeEach(() => mocks.request.mockReset())

describe('SHP-027 AdminDeliveryAppReport', () => {
  it('asks for a route id before calling the API', async () => {
    const wrapper = await mountSuspended(AdminDeliveryAppReport)
    expect(wrapper.text()).toContain('Introduce el identificador de una ruta')
    await wrapper.find('form').trigger('submit')
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('shows loading, then events, incidents and PODs with an evidence link', async () => {
    mocks.request.mockImplementation(() => new Promise(() => {}))
    const loading = await mountSuspended(AdminDeliveryAppReport)
    await loading.find('[data-test="route-id"]').setValue('r-1')
    await loading.find('form').trigger('submit')
    expect(loading.find('[role="status"]').text()).toContain('Cargando')
    mocks.request.mockReset()
    mocks.request.mockResolvedValueOnce(report)
    const wrapper = await load()
    expect(mocks.request.mock.calls[0]![0]).toBe('/api/admin/delivery-app/routes/r-1/report')
    expect(wrapper.text()).toContain('Caja golpeada')
    expect(wrapper.text()).toContain('Ana')
    expect(wrapper.find('[data-test="evidence-s-1"]').attributes('href')).toBe(
      '/api/admin/delivery-app/stops/s-1/evidence'
    )
  })

  it('shows empty sections and maps errors', async () => {
    mocks.request.mockResolvedValueOnce({ ...report, events: [], incidents: [], pods: [] })
    expect((await load()).text()).toContain('Sin incidencias')
    mocks.request.mockReset()
    mocks.request.mockRejectedValueOnce(apiError('not_found'))
    expect((await load('zzz')).find('[role="alert"]').text()).toContain('No se ha encontrado')
  })

  it('encodes the route id in the URL', async () => {
    mocks.request.mockResolvedValueOnce(report)
    await load('r 1/../x')
    expect(mocks.request.mock.calls[0]![0]).toBe('/api/admin/delivery-app/routes/r%201%2F..%2Fx/report')
  })
})
