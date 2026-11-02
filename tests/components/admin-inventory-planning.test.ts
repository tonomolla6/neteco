import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminInventoryPlanning from '../../app/components/AdminInventoryPlanning.vue'
import '#app/nuxt-vitest-app-entry'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => fetchMock)

const suggestion = {
  id: 's1',
  sku: 'DES-100',
  status: 'pending',
  positionQuantity: 4,
  reorderPoint: 9,
  suggestedQuantity: 12,
  dailyDemand: 1,
  leadTimeDays: 7,
  version: 1
}
const task = {
  id: 't1',
  stage: 'receiving',
  reference: 'ALB-1',
  status: 'open',
  expectedQuantity: 3,
  scannedQuantity: 0
}
const plan = { id: 'p1', name: 'Conteo A', status: 'review', version: 3, blind: 1, lines: 1 }
const planDetail = {
  ...plan,
  lines: [
    {
      variantId: 'v1',
      sku: 'DES-100',
      status: 'counted',
      version: 3,
      countedQuantity: 18,
      expectedQuantity: 20,
      discrepancy: -2
    }
  ]
}

function respond(overrides: Record<string, unknown> = {}) {
  fetchMock.mockImplementation(async (rawUrl: string, init?: { method?: string }) => {
    const url = String(rawUrl ?? '')
    if (url in overrides) {
      const value = overrides[url]
      if (value instanceof Error) throw value
      return value
    }
    if (init?.method === 'POST') return { ok: true, evaluated: 1, created: [] }
    if (url.includes('reorder/suggestions')) return { suggestions: [suggestion] }
    if (url.endsWith('/barcode-tasks/t1'))
      return { ...task, lines: [{ variantId: 'v1', sku: 'DES-100', expectedQuantity: 3, scannedQuantity: 0 }] }
    if (url.includes('barcode-tasks')) return { tasks: [task] }
    if (url.endsWith('/cycle-counts/p1')) return planDetail
    if (url.includes('cycle-counts')) return { plans: [plan] }
    return {}
  })
}

describe('INV-017/018/020 AdminInventoryPlanning', () => {
  let wrappers: Array<{ unmount(): void }> = []
  beforeEach(() => fetchMock.mockReset())
  afterEach(() => {
    wrappers.forEach((w) => w.unmount())
    wrappers = []
  })
  const mount = async () => {
    const w = await mountSuspended(AdminInventoryPlanning)
    wrappers.push(w)
    await flushPromises()
    return w
  }

  it('shows pending purchase suggestions and sends an approval with idempotency key, quantity and note', async () => {
    respond()
    const w = await mount()
    expect(w.text()).toContain('DES-100')
    await w.find('[data-testid="qty-s1"]').setValue(24)
    await w.find('[data-testid="note-s1"]').setValue('Aprobado por compras')
    await w.find('[data-testid="approve-s1"]').trigger('click')
    await flushPromises()
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/suggestions/s1/decision'))!
    expect(call[1]).toMatchObject({
      method: 'POST',
      body: { decision: 'approve', expectedVersion: 1, approvedQuantity: 24, note: 'Aprobado por compras' }
    })
    expect(call[1].headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('renders empty and error states', async () => {
    respond({ '/api/admin/inventory/reorder/suggestions?status=pending': { suggestions: [] } })
    const empty = await mount()
    expect(empty.find('[data-testid="reorder-empty"]').exists()).toBe(true)
    respond({
      '/api/admin/inventory/cycle-counts': Object.assign(new Error('x'), { data: { error: { code: 'forbidden' } } })
    })
    const failed = await mount()
    expect(failed.find('[data-testid="planning-error"]').text()).toContain('forbidden')
  })

  it('validates scans through the API and reports rejections, with an exception mode', async () => {
    respond()
    const w = await mount()
    await w.find('[data-testid="tab-scan"]').trigger('click')
    await w.find('[data-testid="task-t1"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="scan-lines"]').text()).toContain('DES-100: 0/3')
    respond({
      '/api/admin/warehouse/barcode-tasks/t1/scan': Object.assign(new Error('x'), {
        data: { error: { code: 'barcode_unknown' } }
      })
    })
    await w.find('[data-testid="scan-input"]').setValue('999')
    await w.find('[data-testid="scan-form"]').trigger('submit')
    await flushPromises()
    expect(w.find('[data-testid="scan-feedback"]').text()).toContain('barcode_unknown')
    respond()
    await w.find('[data-testid="scan-exception-toggle"]').setValue(true)
    await w.find('[data-testid="scan-exception-note"]').setValue('Etiqueta rota en palet')
    await w.find('[data-testid="scan-input"]').setValue('DES-100')
    await w.find('[data-testid="scan-form"]').trigger('submit')
    await flushPromises()
    const call = fetchMock.mock.calls
      .filter(([url, init]) => String(url).endsWith('/t1/scan') && init?.method === 'POST')
      .at(-1)!
    expect(call[1].body).toMatchObject({
      barcode: 'DES-100',
      exception: { reason: 'barcode_unreadable', note: 'Etiqueta rota en palet' }
    })
  })

  it('shows the variance in review and requires choosing a root cause before approving', async () => {
    respond()
    const w = await mount()
    await w.find('[data-testid="tab-counts"]').trigger('click')
    await w.find('[data-testid="plan-p1"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="line-v1"]').text()).toContain('-2')
    await w.find('[data-testid="cause-v1"]').setValue('picking_error')
    await w.find('[data-testid="line-note-v1"]').setValue('Error de picking confirmado')
    await w.find('[data-testid="approve-line-v1"]').trigger('click')
    await flushPromises()
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/p1/decide'))!
    expect(call[1].body).toMatchObject({
      variantId: 'v1',
      decision: 'approve',
      rootCause: 'picking_error',
      expectedLineVersion: 3
    })
  })

  it('blind plans in counting state hide the book quantity column', async () => {
    respond({
      '/api/admin/inventory/cycle-counts/p1': {
        ...plan,
        status: 'counting',
        lines: [{ variantId: 'v1', sku: 'DES-100', status: 'pending', version: 2, countedQuantity: null }]
      }
    })
    const w = await mount()
    await w.find('[data-testid="tab-counts"]').trigger('click')
    await w.find('[data-testid="plan-p1"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="plan-detail"]').text()).not.toContain('Teórico')
    await w.find('[data-testid="count-v1"]').setValue(7)
    await w.find('[data-testid="send-count-v1"]').trigger('click')
    await flushPromises()
    expect(fetchMock.mock.calls.find(([url]) => String(url).endsWith('/p1/count'))![1].body).toMatchObject({
      countedQuantity: 7,
      expectedLineVersion: 2
    })
  })

  it('provides forms to create replenishment policies, cycle count plans and scan tasks', async () => {
    respond()
    const w = await mount()

    // 1. Reorder policy creation form
    await w.find('[data-testid="policy-variant-id"]').setValue('11111111-1111-4111-8111-111111111111')
    await w.find('[data-testid="policy-lead-time"]').setValue(14)
    await w.find('[data-testid="policy-min-order"]').setValue(50)
    await w.find('[data-testid="save-policy-btn"]').trigger('click')
    await flushPromises()

    const policyCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/reorder/policies'))!
    expect(policyCall[1]).toMatchObject({
      method: 'POST',
      body: {
        variantId: '11111111-1111-4111-8111-111111111111',
        leadTimeDays: 14,
        minOrderQuantity: 50
      }
    })

    // 2. Count plan creation form
    await w.find('[data-testid="tab-counts"]').trigger('click')
    await w.find('[data-testid="new-plan-name"]').setValue('Conteo Pasillo Químicos')
    await w.find('[data-testid="new-plan-variants"]').setValue('11111111-1111-4111-8111-111111111111')
    await w.find('[data-testid="save-plan-btn"]').trigger('click')
    await flushPromises()

    const planCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith('/cycle-counts') && init?.method === 'POST'
    )!
    expect(planCall[1]).toMatchObject({
      method: 'POST',
      body: {
        name: 'Conteo Pasillo Químicos',
        variantIds: ['11111111-1111-4111-8111-111111111111']
      }
    })

    // 3. Scan task creation form
    await w.find('[data-testid="tab-scan"]').trigger('click')
    await w.find('[data-testid="new-task-reference"]').setValue('ALB-2026-99')
    await w.find('[data-testid="new-task-variant"]').setValue('11111111-1111-4111-8111-111111111111')
    await w.find('[data-testid="new-task-quantity"]').setValue(10)
    await w.find('[data-testid="save-task-btn"]').trigger('click')
    await flushPromises()

    const taskCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith('/barcode-tasks') && init?.method === 'POST'
    )!
    expect(taskCall[1]).toMatchObject({
      method: 'POST',
      body: {
        reference: 'ALB-2026-99',
        lines: [{ variantId: '11111111-1111-4111-8111-111111111111', expectedQuantity: 10 }]
      }
    })
  })
})
