import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminPackingOptimizer from '../../app/components/AdminPackingOptimizer.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const config = {
  boxes: [
    {
      code: 'S',
      name: 'Caja pequena',
      widthMm: 200,
      heightMm: 150,
      depthMm: 150,
      tareGrams: 150,
      maxWeightGrams: 5000,
      hazmatAllowed: true,
      active: true,
      version: 1,
      updatedAt: '2026-10-29T00:00:00Z'
    }
  ],
  profiles: [
    {
      sku: 'SOAP',
      weightGrams: 1100,
      widthMm: 80,
      heightMm: 200,
      depthMm: 80,
      hazardClass: 'none',
      version: 1,
      updatedAt: '2026-10-29T00:00:00Z'
    }
  ],
  incompatibilities: [{ classA: 'corrosive', classB: 'oxidizer', reason: 'Acidos con lejia' }],
  suggestions: []
}
const suggestion = (extra = {}) => ({
  id: 'sug-1',
  orderId: null,
  status: 'suggested',
  version: 1,
  algorithmVersion: 'ffd-box-reselect-1',
  lines: [{ sku: 'SOAP', quantity: 2 }],
  plan: {
    algorithmVersion: 'ffd-box-reselect-1',
    parcels: [
      {
        boxCode: 'S',
        widthMm: 200,
        heightMm: 150,
        depthMm: 150,
        contents: [{ sku: 'SOAP', quantity: 2 }],
        hazardClasses: ['none'],
        netWeightGrams: 2200,
        grossWeightGrams: 2350,
        fillRatioBp: 6000
      }
    ],
    totals: { parcelCount: 1, netWeightGrams: 2200, grossWeightGrams: 2350 }
  },
  orderPackingParcels: null,
  validation: null,
  createdAt: '2026-10-29T10:00:00Z',
  updatedAt: '2026-10-29T10:00:00Z',
  validatedAt: null,
  ...extra
})
const apiError = (code: string, details = {}) => Object.assign(new Error(code), { data: { error: { code, details } } })
const mount = async () => {
  const wrapper = await mountSuspended(AdminPackingOptimizer)
  await flushPromises()
  return wrapper
}
beforeEach(() => mocks.request.mockReset())

describe('SHP-030 AdminPackingOptimizer', () => {
  it('shows loading, error and the configured boxes, profiles and rules', async () => {
    mocks.request.mockImplementation(() => new Promise(() => {}))
    expect((await mountSuspended(AdminPackingOptimizer)).find('[role="status"]').text()).toContain('Cargando')
    mocks.request.mockReset()
    mocks.request.mockRejectedValueOnce(apiError('forbidden'))
    expect((await mount()).find('[role="alert"]').text()).toContain('permisos')
    mocks.request.mockReset()
    mocks.request.mockResolvedValueOnce(config)
    const wrapper = await mount()
    expect(wrapper.text()).toContain('Caja pequena')
    expect(wrapper.text()).toContain('SOAP')
    expect(wrapper.text()).toContain('Acidos con lejia')
  })

  it('parses the lines textarea and requests a suggestion with a command id', async () => {
    mocks.request.mockResolvedValueOnce(config)
    const wrapper = await mount()
    mocks.request.mockResolvedValueOnce({ suggestion: suggestion() }).mockResolvedValueOnce(config)
    await wrapper.find('[data-test="lines"]').setValue('SOAP x 2\nACID-1L x 1\n\n')
    await wrapper.find('[data-test="suggest"]').trigger('click')
    await flushPromises()
    const call = mocks.request.mock.calls.find(([url]) => url === '/api/admin/packing-optimizer/suggestions')!
    expect(call[1].body.lines).toEqual([
      { sku: 'SOAP', quantity: 2 },
      { sku: 'ACID-1L', quantity: 1 }
    ])
    expect(call[1].body.commandId).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(wrapper.find('[data-test="plan"]').text()).toContain('1 bulto')
    expect(wrapper.find('[data-test="plan"]').text()).toContain('Caja S')
  })

  it('rejects malformed lines locally without calling the API', async () => {
    mocks.request.mockResolvedValueOnce(config)
    const wrapper = await mount()
    const before = mocks.request.mock.calls.length
    for (const bad of ['', 'SOAP', 'SOAP x 0', 'SOAP x -1', 'SOAP x 1.5', 'x 3']) {
      await wrapper.find('[data-test="lines"]').setValue(bad)
      await wrapper.find('[data-test="suggest"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-test="lines-error"]').exists()).toBe(true)
    }
    expect(mocks.request.mock.calls.length).toBe(before)
  })

  it('explains missing profiles and unpackable products', async () => {
    mocks.request.mockResolvedValueOnce(config)
    const wrapper = await mount()
    await wrapper.find('[data-test="lines"]').setValue('NOPE x 1')
    mocks.request.mockRejectedValueOnce(apiError('unknown_profile', { skus: ['NOPE'] }))
    await wrapper.find('[data-test="suggest"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').text()).toContain('NOPE')
    mocks.request.mockRejectedValueOnce(apiError('unpackable', { sku: 'HUGE', reason: 'dimensions' }))
    await wrapper.find('[data-test="suggest"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').text()).toContain('HUGE: dimensions')
  })

  it('validates in the warehouse with actual weights prefilled from the plan', async () => {
    mocks.request.mockResolvedValueOnce(config)
    const wrapper = await mount()
    mocks.request.mockResolvedValueOnce({ suggestion: suggestion() }).mockResolvedValueOnce(config)
    await wrapper.find('[data-test="lines"]').setValue('SOAP x 2')
    await wrapper.find('[data-test="suggest"]').trigger('click')
    await flushPromises()
    expect((wrapper.find('[data-test="actual-0"]').element as HTMLInputElement).value).toBe('2350')
    await wrapper.find('[data-test="actual-0"]').setValue('2400')
    mocks.request
      .mockResolvedValueOnce({
        suggestion: suggestion({ status: 'validated', version: 2, validatedAt: '2026-10-29T11:00:00Z' })
      })
      .mockResolvedValueOnce(config)
    await wrapper.find('[data-test="accept"]').trigger('click')
    await flushPromises()
    const call = mocks.request.mock.calls.find(([url]) => String(url).endsWith('/decision'))!
    expect(call[1].body).toMatchObject({
      decision: 'accept',
      expectedVersion: 1,
      actualParcels: [{ parcelIndex: 0, weightGrams: 2400 }]
    })
    expect(wrapper.find('[data-test="plan"]').text()).toContain('Validada')
    expect(wrapper.find('[data-test="accept"]').exists()).toBe(false)
  })

  it('requires a note to reject and shows tolerance errors', async () => {
    mocks.request.mockResolvedValueOnce(config)
    const wrapper = await mount()
    mocks.request.mockResolvedValueOnce({ suggestion: suggestion() }).mockResolvedValueOnce(config)
    await wrapper.find('[data-test="lines"]').setValue('SOAP x 2')
    await wrapper.find('[data-test="suggest"]').trigger('click')
    await flushPromises()
    const before = mocks.request.mock.calls.length
    await wrapper.find('[data-test="reject"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="reject-error"]').exists()).toBe(true)
    expect(mocks.request.mock.calls.length).toBe(before)
    mocks.request.mockRejectedValueOnce(apiError('validation_out_of_tolerance'))
    await wrapper.find('[data-test="accept"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').text()).toContain('se desvía')
  })
})
