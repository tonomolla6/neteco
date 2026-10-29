import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminAiopsPanel from '../../app/components/AdminAiopsPanel.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const rec = (over: Record<string, unknown> = {}) => ({
  id: '30000000-0000-4000-8000-000000000001',
  summary: '2 señales correlacionadas',
  runbookId: 'rollback_release',
  steps: ['Paso uno', 'Paso dos'],
  destructive: true,
  confidence: 0.8,
  status: 'proposed',
  decisionReason: null,
  outcome: 'pending',
  version: 1,
  createdAt: '2026-10-29T12:00:00Z',
  ...over
})
const precision = {
  total: 1,
  reviewed: 0,
  truePositives: 0,
  falsePositives: 0,
  pending: 1,
  precision: null,
  sampleSufficient: false
}
function route(recommendations: unknown[]) {
  mocks.request.mockImplementation(async (url?: string, options?: { method?: string }) => {
    if (options?.method === 'POST') return {}
    return String(url ?? '').endsWith('/precision') ? { precision } : { recommendations }
  })
}

describe('panel AIOps', () => {
  beforeEach(() => mocks.request.mockReset())

  it('muestra vacío, y error con reintento', async () => {
    route([])
    let wrapper = await mountSuspended(AdminAiopsPanel)
    await flushPromises()
    expect(wrapper.find('[data-empty]').exists()).toBe(true)
    mocks.request.mockReset()
    mocks.request.mockImplementation(async (url?: string) => {
      if (String(url ?? '').includes('/aiops/')) throw { data: { error: { code: 'forbidden' } } }
      return {}
    })
    wrapper = await mountSuspended(AdminAiopsPanel)
    await flushPromises()
    expect(wrapper.get('[data-error]').text()).toContain('forbidden')
  })

  it('muestra runbook, aviso destructivo y bloquea aprobar sin motivo y confirmación', async () => {
    route([rec()])
    const wrapper = await mountSuspended(AdminAiopsPanel)
    await flushPromises()
    expect(wrapper.find('[data-destructive-badge]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Paso dos')
    const approve = wrapper.get('[data-approve]')
    expect(approve.attributes('disabled')).toBeDefined()
    await wrapper.get('input[type="text"]').setValue('Revisado con el equipo')
    expect(wrapper.get('[data-approve]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-confirm-destructive]').setValue(true)
    expect(wrapper.get('[data-approve]').attributes('disabled')).toBeUndefined()
  })

  it('envía la aprobación con confirmación explícita', async () => {
    route([rec()])
    const wrapper = await mountSuspended(AdminAiopsPanel)
    await flushPromises()
    await wrapper.get('input[type="text"]').setValue('Revisado con el equipo')
    await wrapper.get('[data-confirm-destructive]').setValue(true)
    await wrapper.get('[data-approve]').trigger('click')
    await flushPromises()
    const call = mocks.request.mock.calls.find(([url]) => String(url).endsWith('recommendations/decide'))!
    expect(call[1].body).toMatchObject({ decision: 'approve', confirmDestructive: true, expectedVersion: 1 })
  })

  it('una recomendación no destructiva no pide confirmación y permite etiquetar resultado tras decidir', async () => {
    route([rec({ destructive: false })])
    const wrapper = await mountSuspended(AdminAiopsPanel)
    await flushPromises()
    expect(wrapper.find('[data-confirm-destructive]').exists()).toBe(false)
    route([rec({ destructive: false, status: 'approved', decisionReason: 'Motivo válido', version: 2 })])
    await wrapper.get('[data-correlate]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-label-true]').trigger('click')
    await flushPromises()
    const call = mocks.request.mock.calls.find(([url]) => String(url).endsWith('recommendations/outcome'))!
    expect(call[1].body).toMatchObject({ outcome: 'true_positive', expectedVersion: 2 })
  })
})
