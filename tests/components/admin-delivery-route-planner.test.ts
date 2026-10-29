import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import AdminDeliveryRoutePlanner from '../../app/components/AdminDeliveryRoutePlanner.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn()
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)

const sampleRoute = {
  id: 'r-101',
  routeDate: '2026-10-30',
  vehicleId: 'v-1',
  driverId: 'd-1',
  status: 'planned',
  windowStart: '08:30',
  windowEnd: '15:00',
  totalStops: 2,
  totalParcels: 4,
  totalWeightGrams: 45000,
  maxWeightGrams: 500000,
  maxParcels: 50,
  version: 2,
  createdAt: '2026-10-29T10:00:00Z',
  updatedAt: '2026-10-29T10:00:00Z',
  vehicle: {
    id: 'v-1',
    name: 'Furgón Neteco 1',
    registrationPlate: '1234-LMN',
    maxWeightGrams: 500000,
    maxParcels: 50,
    status: 'active'
  },
  driver: {
    id: 'd-1',
    name: 'Carlos Reparto',
    phone: '+34600111222',
    licenseNumber: 'B-12345',
    status: 'active'
  },
  stops: [
    {
      id: 's-1',
      routeId: 'r-101',
      sequenceIndex: 0,
      recipientName: 'Taller Alfa',
      streetAddress: 'Polígono El Plá 12',
      postalCode: '46870',
      city: 'Ontinyent',
      parcelCount: 2,
      weightGrams: 20000,
      timeWindowStart: '09:00',
      timeWindowEnd: '10:00',
      status: 'pending'
    },
    {
      id: 's-2',
      routeId: 'r-101',
      sequenceIndex: 1,
      recipientName: 'Lavandería Sol',
      streetAddress: 'Carrer Major 1',
      postalCode: '46870',
      city: 'Ontinyent',
      parcelCount: 2,
      weightGrams: 25000,
      timeWindowStart: '10:30',
      timeWindowEnd: '11:30',
      status: 'pending'
    }
  ]
}

describe('SHP-026: AdminDeliveryRoutePlanner component', () => {
  it('renders loading state initially', async () => {
    mocks.request.mockImplementation(() => new Promise(() => {}))
    const wrapper = await mountSuspended(AdminDeliveryRoutePlanner, {
      props: { routeId: 'r-101' }
    })

    expect(wrapper.find('[role="status"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Cargando planificación de ruta')
  })

  it('renders vehicle, driver, capacity meter, and sequenced stops', async () => {
    mocks.request.mockResolvedValueOnce({ route: sampleRoute })

    const wrapper = await mountSuspended(AdminDeliveryRoutePlanner, {
      props: { routeId: 'r-101' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Furgón Neteco 1')
    expect(wrapper.text()).toContain('Carlos Reparto')
    expect(wrapper.text()).toContain('08:30 - 15:00')
    expect(wrapper.text()).toContain('Taller Alfa')
    expect(wrapper.text()).toContain('Lavandería Sol')
    expect(wrapper.find('[data-test="capacity-meter"]').exists()).toBe(true)
  })

  it('executes controlled reoptimization when clicking reoptimize button', async () => {
    mocks.request.mockResolvedValueOnce({ route: sampleRoute })
    mocks.request.mockResolvedValueOnce({
      routeId: 'r-101',
      newVersion: 3,
      resequencedStopsCount: 2,
      totalStops: 2,
      totalWeightGrams: 45000,
      totalParcels: 4,
      capacityOk: true,
      route: {
        ...sampleRoute,
        version: 3
      }
    })

    const wrapper = await mountSuspended(AdminDeliveryRoutePlanner, {
      props: { routeId: 'r-101' }
    })
    await flushPromises()

    const reoptBtn = wrapper.find('[data-test="reoptimize-btn"]')
    expect(reoptBtn.exists()).toBe(true)
    await reoptBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Ruta reoptimizada correctamente')
  })

  it('handles error state when route load fails', async () => {
    mocks.request.mockRejectedValueOnce(new Error('Fetch failed'))

    const wrapper = await mountSuspended(AdminDeliveryRoutePlanner, {
      props: { routeId: 'r-101' }
    })
    await flushPromises()

    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('No se ha podido cargar la ruta')
  })
})
