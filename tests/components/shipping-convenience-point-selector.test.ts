import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ShippingConveniencePointSelector from '../../app/components/ShippingConveniencePointSelector.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn()
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)

const samplePoints = [
  {
    id: 'pt-1',
    network: 'inpost',
    code: 'INP-01',
    name: 'Locker Gasolinera',
    streetAddress: 'Av. Textil 12',
    postalCode: '46870',
    city: 'Ontinyent',
    province: 'Valencia',
    countryCode: 'ES',
    latitude: 38.82,
    longitude: -0.6,
    openingHours: { monday: { open: '00:00', close: '23:59' } },
    operatingStatus: 'active',
    maxWeightGrams: 20000,
    acceptsReturns: true,
    hasLocker: true,
    createdAt: '2026-10-29T10:00:00Z',
    updatedAt: '2026-10-29T10:00:00Z'
  },
  {
    id: 'pt-2',
    network: 'correos',
    code: 'COR-01',
    name: 'CityPaq Consum',
    streetAddress: 'Carrer Major 45',
    postalCode: '46870',
    city: 'Ontinyent',
    province: 'Valencia',
    countryCode: 'ES',
    latitude: 38.825,
    longitude: -0.601,
    openingHours: { monday: { open: '09:00', close: '21:00' } },
    operatingStatus: 'active',
    maxWeightGrams: 15000,
    acceptsReturns: true,
    hasLocker: true,
    createdAt: '2026-10-29T10:00:00Z',
    updatedAt: '2026-10-29T10:00:00Z'
  }
]

describe('SHP-023: ShippingConveniencePointSelector accessible component', () => {
  it('renders loading state initially while fetching convenience points', async () => {
    mocks.request.mockImplementation(() => new Promise(() => {})) // never resolves immediately
    const wrapper = await mountSuspended(ShippingConveniencePointSelector, {
      props: {
        postalCode: '46870'
      }
    })

    expect(wrapper.find('[role="status"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Buscando puntos de conveniencia')
  })

  it('renders list of convenience points with proper accessibility roles and labels', async () => {
    mocks.request.mockResolvedValueOnce({
      points: samplePoints,
      total: 2,
      postalCode: '46870'
    })

    const wrapper = await mountSuspended(ShippingConveniencePointSelector, {
      props: {
        postalCode: '46870'
      }
    })
    await flushPromises()

    const radiogroup = wrapper.find('[role="radiogroup"]')
    expect(radiogroup.exists()).toBe(true)
    expect(radiogroup.attributes('aria-label')).toBe('Puntos de recogida y lockers disponibles')

    const items = wrapper.findAll('[role="radio"]')
    expect(items.length).toBe(2)
    expect(wrapper.text()).toContain('Locker Gasolinera')
    expect(wrapper.text()).toContain('CityPaq Consum')
  })

  it('emits selection when user clicks a convenience point radio item', async () => {
    mocks.request.mockResolvedValueOnce({
      points: samplePoints,
      total: 2,
      postalCode: '46870'
    })

    const wrapper = await mountSuspended(ShippingConveniencePointSelector, {
      props: {
        postalCode: '46870'
      }
    })
    await flushPromises()

    const radioItems = wrapper.findAll('[role="radio"]')
    await radioItems[0]?.trigger('click')

    expect(wrapper.emitted('select')).toBeDefined()
    expect(wrapper.emitted('select')?.[0]?.[0]).toMatchObject({
      id: 'pt-1',
      code: 'INP-01'
    })
  })

  it('renders empty message when no points are found for postal code', async () => {
    mocks.request.mockResolvedValueOnce({
      points: [],
      total: 0,
      postalCode: '00000'
    })

    const wrapper = await mountSuspended(ShippingConveniencePointSelector, {
      props: {
        postalCode: '00000'
      }
    })
    await flushPromises()

    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('No hemos encontrado puntos de conveniencia')
  })

  it('renders error message when API call fails', async () => {
    mocks.request.mockRejectedValueOnce(new Error('Network error'))

    const wrapper = await mountSuspended(ShippingConveniencePointSelector, {
      props: {
        postalCode: '46870'
      }
    })
    await flushPromises()

    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('No se han podido cargar los puntos de conveniencia')
  })
})
