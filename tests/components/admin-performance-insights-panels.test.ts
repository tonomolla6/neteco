import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminThirdPartyValuePanel from '../../app/components/AdminThirdPartyValuePanel.vue'
import AdminB2BCacheStatsPanel from '../../app/components/AdminB2BCacheStatsPanel.vue'
import AdminEdgePersonalizationPanel from '../../app/components/AdminEdgePersonalizationPanel.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
beforeEach(() => mocks.request.mockReset())

const script = (over: Record<string, unknown> = {}) => ({
  id: '30000000-0000-4000-8000-000000000001',
  vendor: 'Meta',
  name: 'Pixel',
  kind: 'pixel',
  monthlyCostCents: 5000,
  loadMsP75: 200,
  status: 'active',
  version: 1,
  latestVerdict: 'remove',
  ...over
})

describe('terceros por valor', () => {
  it('muestra veredicto y exige motivo para eliminar', async () => {
    mocks.request.mockResolvedValue({ scripts: [script()] })
    const wrapper = await mountSuspended(AdminThirdPartyValuePanel)
    await flushPromises()
    expect(wrapper.get('[data-verdict]').text()).toContain('Eliminar')
    expect(wrapper.get('[data-remove]').attributes('disabled')).toBeDefined()
    await wrapper.get('input[placeholder^="Motivo"]').setValue('Sin retorno medido en el A/B')
    await wrapper.get('[data-remove]').trigger('click')
    await flushPromises()
    const call = mocks.request.mock.calls.find(([url]) => String(url).endsWith('/remove'))!
    expect(call[1].body).toMatchObject({ expectedVersion: 1, reason: 'Sin retorno medido en el A/B' })
  })
  it('estado vacío y error con reintento', async () => {
    mocks.request.mockResolvedValueOnce({ scripts: [] })
    let wrapper = await mountSuspended(AdminThirdPartyValuePanel)
    await flushPromises()
    expect(wrapper.find('[data-empty]').exists()).toBe(true)
    mocks.request.mockRejectedValueOnce(new Error('offline'))
    wrapper = await mountSuspended(AdminThirdPartyValuePanel)
    await flushPromises()
    expect(wrapper.find('[data-error]').exists()).toBe(true)
  })
})

describe('caché B2B', () => {
  it('presenta hit rate y rechazos de aislamiento', async () => {
    mocks.request.mockResolvedValue({
      stats: {
        totals: [
          { scope: 'public', hits: 0, misses: 0, isolationRejections: 0, hitRate: null },
          { scope: 'b2b', hits: 9, misses: 1, isolationRejections: 2, hitRate: 0.9 }
        ]
      }
    })
    const wrapper = await mountSuspended(AdminB2BCacheStatsPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('90.0%')
    expect(wrapper.text()).toContain('2 rechazos de aislamiento')
  })
  it('estado vacío sin tráfico', async () => {
    mocks.request.mockResolvedValue({
      stats: { totals: [{ scope: 'public', hits: 0, misses: 0, isolationRejections: 0, hitRate: null }] }
    })
    const wrapper = await mountSuspended(AdminB2BCacheStatsPanel)
    await flushPromises()
    expect(wrapper.find('[data-empty]').exists()).toBe(true)
  })
})

describe('personalización en el borde', () => {
  const rule = (over: Record<string, unknown> = {}) => ({
    id: '30000000-0000-4000-8000-000000000002',
    slot: 'home_hero',
    segment: 'b2b',
    variantKey: 'bulk_offer',
    status: 'draft',
    version: 1,
    ...over
  })
  it('activa con CAS y muestra el motivo si la evidencia no basta', async () => {
    mocks.request.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === 'POST')
        throw { data: { error: { code: 'evidence_insufficient', message: 'insufficient_sample' } } }
      return { rules: [rule()] }
    })
    const wrapper = await mountSuspended(AdminEdgePersonalizationPanel)
    await flushPromises()
    await wrapper.get('[data-enable]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-error]').text()).toContain('insufficient_sample')
    const call = mocks.request.mock.calls.find(([, o]) => o?.method === 'POST')!
    expect(call[1].body).toMatchObject({ expectedVersion: 1 })
  })
  it('una regla activa solo ofrece desactivar', async () => {
    mocks.request.mockResolvedValue({ rules: [rule({ status: 'enabled', version: 2 })] })
    const wrapper = await mountSuspended(AdminEdgePersonalizationPanel)
    await flushPromises()
    expect(wrapper.find('[data-disable]').exists()).toBe(true)
    expect(wrapper.find('[data-enable]').exists()).toBe(false)
  })
  it('estado vacío', async () => {
    mocks.request.mockResolvedValue({ rules: [] })
    const wrapper = await mountSuspended(AdminEdgePersonalizationPanel)
    await flushPromises()
    expect(wrapper.find('[data-empty]').exists()).toBe(true)
  })
})
