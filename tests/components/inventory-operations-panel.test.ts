import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import InventoryOperationsPanel from '../../app/components/InventoryOperationsPanel.vue'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('$fetch', () => mocks.request)

const VARIANT = '40000000-0000-4000-8000-000000000041'
const PO = '70000000-0000-4000-8000-000000000001'
const BIN = '71000000-0000-4000-8000-000000000001'
const COMMITMENT = '72000000-0000-4000-8000-000000000001'
const props = { scopeKey: 's', enabled: true, pending: false, selectedVariantUuid: VARIANT }
const mounted: Array<{ unmount(): void }> = []
let failList = false

beforeEach(() => {
  failList = false
  mocks.request.mockReset()
  mocks.request.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (options?.method === 'POST') return { source: 'cloudflare', data: {} }
    if (failList) throw new Error('boom')
    if (path.startsWith('/api/admin/inventory/commitments'))
      return {
        items: [
          {
            id: COMMITMENT,
            contractRef: 'CONTRATO-2026-001',
            customerId: null,
            quantity: 5,
            expiresAt: '2026-12-01T00:00:00Z',
            status: 'active',
            overdue: false,
            expiringSoon: true,
            renewalCount: 0,
            maxRenewals: 1,
            renewalsRemaining: 1,
            version: 3
          }
        ]
      }
    if (path.startsWith('/api/admin/inventory/pick-locations/stock'))
      return { items: [{ pickLocationId: BIN, code: 'A-01', zone: 'A', kind: 'pick', quantity: 6, version: 2 }] }
    if (path.startsWith('/api/admin/inventory/pick-locations/consistency'))
      return {
        items: [
          {
            physicalQuantity: 20,
            reservedQuantity: 5,
            sellableQuantity: 12,
            locatedQuantity: 6,
            unlocatedQuantity: 14,
            consistent: true
          }
        ]
      }
    if (path.startsWith('/api/admin/inventory/pick-locations'))
      return {
        items: [
          {
            id: BIN,
            code: 'A-01',
            zone: 'A',
            kind: 'pick',
            pickSequence: 1,
            capacityUnits: null,
            active: true,
            stockUnits: 6,
            version: 1
          }
        ]
      }
    if (path === `/api/admin/inventory/purchase-orders/${PO}`)
      return {
        id: PO,
        poNumber: 'PO-2026-001',
        supplierName: 'Proveedor Uno',
        status: 'partially_received',
        currency: 'EUR',
        version: 3,
        totalCostCents: 2500,
        receivedCostCents: 1500,
        lines: [
          {
            lineIndex: 0,
            variantId: VARIANT,
            sku: 'SKU-1',
            expectedQuantity: 10,
            receivedQuantity: 6,
            rejectedQuantity: 1,
            unitCostCents: 250,
            discrepancy: 'rejected',
            openQuantity: 4
          }
        ],
        receipts: [{ id: 'r1', receiptNumber: 'REC-001', receivedAt: '2026-10-29T12:00:00Z', lines: [] }],
        documents: [{ id: 'd1', kind: 'delivery_note', reference: 'ALB-77', sha256: 'a'.repeat(64), receiptId: 'r1' }],
        summary: { expectedUnits: 10, receivedUnits: 6, rejectedUnits: 1, openUnits: 4, hasDiscrepancy: true }
      }
    if (path.startsWith('/api/admin/inventory/purchase-orders'))
      return {
        items: [
          {
            id: PO,
            poNumber: 'PO-2026-001',
            supplierName: 'Proveedor Uno',
            status: 'partially_received',
            currency: 'EUR',
            totalCostCents: 2500,
            expectedUnits: 10,
            receivedUnits: 6,
            hasDiscrepancy: true,
            version: 3
          }
        ]
      }
    return {}
  })
})
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})
const mountPanel = async (extra: Record<string, unknown> = {}) => {
  const wrapper = await mountSuspended(InventoryOperationsPanel, { props: { ...props, ...extra } })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
const posts = () => mocks.request.mock.calls.filter((call) => call[1]?.method === 'POST')

describe('InventoryOperationsPanel', () => {
  it('exposes three accessible tabs', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.find('[role="tablist"]').exists()).toBe(true)
    const tabs = wrapper.findAll('[role="tab"]')
    expect(tabs.map((t) => t.text())).toEqual([
      expect.stringContaining('Compromisos de contrato'),
      expect.stringContaining('Ubicaciones de picking'),
      expect.stringContaining('Compras y recepciones')
    ])
    expect(tabs[0]!.attributes('aria-selected')).toBe('true')
    expect(wrapper.find('[role="tabpanel"]').exists()).toBe(true)
  })

  it('shows contract commitments with status, expiry and renewals', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.text()).toContain('CONTRATO-2026-001')
    expect(wrapper.text()).toContain('2026-12-01')
    expect(wrapper.text()).toContain('Caduca pronto')
    expect(wrapper.text()).toContain('1 renovación')
  })

  it('shows an empty state and an error state', async () => {
    mocks.request.mockImplementation(async () => ({ items: [] }))
    const empty = await mountPanel()
    expect(empty.text()).toContain('No hay compromisos de contrato')
    failList = true
    mocks.request.mockImplementation(async () => {
      throw new Error('boom')
    })
    const failed = await mountPanel()
    expect(failed.find('[role="alert"]').exists()).toBe(true)
  })

  it('creates a commitment with an idempotency key and strict payload', async () => {
    const wrapper = await mountPanel()
    await wrapper.find('input[name="contractRef"]').setValue('CONTRATO-NUEVO')
    await wrapper.find('input[name="quantity"]').setValue('4')
    await wrapper.find('input[name="expiresOn"]').setValue('2026-12-31')
    await wrapper.find('input[name="reason"]').setValue('Contrato marco anual')
    await wrapper.find('form[aria-label="Nuevo compromiso"]').trigger('submit')
    await flushPromises()
    const call = posts()[0]!
    expect(call[0]).toBe('/api/admin/inventory/operations/commands')
    expect(call[1].headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
    expect(call[1].body).toMatchObject({
      action: 'create_commitment',
      input: {
        variantId: VARIANT,
        contractRef: 'CONTRATO-NUEVO',
        quantity: 4,
        expiresAt: '2026-12-31T23:59:59Z',
        reason: 'Contrato marco anual'
      }
    })
  })

  it('releases a commitment sending the expected version', async () => {
    vi.stubGlobal('confirm', () => true)
    const wrapper = await mountPanel()
    await wrapper.find('button[data-action="release-commitment"]').trigger('click')
    await flushPromises()
    expect(posts()[0]![1].body).toMatchObject({
      action: 'release_commitment',
      targetId: COMMITMENT,
      input: { expectedVersion: 3 }
    })
    vi.unstubAllGlobals()
  })

  it('does not call the API when disabled or pending', async () => {
    await mountPanel({ enabled: false })
    expect(mocks.request).not.toHaveBeenCalled()
    const wrapper = await mountPanel({ pending: true })
    expect(wrapper.find('button[data-action="release-commitment"]').attributes('disabled')).toBeDefined()
  })

  it('picking tab lists bins, consistency and puts stock away with stock version', async () => {
    const wrapper = await mountPanel()
    await wrapper.findAll('[role="tab"]')[1]!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('A-01')
    expect(wrapper.text()).toContain('Sin ubicar')
    expect(wrapper.text()).toContain('Consistente')
    await wrapper.find('select[name="pickLocationId"]').setValue(BIN)
    await wrapper.find('input[name="putawayQuantity"]').setValue('3')
    await wrapper.find('form[aria-label="Ubicar stock"]').trigger('submit')
    await flushPromises()
    expect(posts()[0]![1].body).toMatchObject({
      action: 'putaway',
      input: { variantId: VARIANT, pickLocationId: BIN, quantity: 3, expectedVersion: 2 }
    })
  })

  it('purchasing tab lists orders and shows discrepancy detail with documents', async () => {
    const wrapper = await mountPanel()
    await wrapper.findAll('[role="tab"]')[2]!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('PO-2026-001')
    expect(wrapper.text()).toContain('Proveedor Uno')
    await wrapper.find('button[data-action="open-po"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Esperado')
    expect(wrapper.text()).toContain('Recibido')
    expect(wrapper.text()).toContain('Discrepancia')
    expect(wrapper.text()).toContain('ALB-77')
  })

  it('records a receipt with CAS version from the loaded order', async () => {
    const wrapper = await mountPanel()
    await wrapper.findAll('[role="tab"]')[2]!.trigger('click')
    await flushPromises()
    await wrapper.find('button[data-action="open-po"]').trigger('click')
    await flushPromises()
    await wrapper.find('input[name="receiptNumber"]').setValue('REC-002')
    await wrapper.find('input[name="received-0"]').setValue('4')
    await wrapper.find('form[aria-label="Registrar recepción"]').trigger('submit')
    await flushPromises()
    const body = posts()[0]![1].body
    expect(body.action).toBe('record_receipt')
    expect(body.input).toMatchObject({
      purchaseOrderId: PO,
      expectedVersion: 3,
      receiptNumber: 'REC-002',
      lines: [{ lineIndex: 0, receivedQuantity: 4, rejectedQuantity: 0 }]
    })
  })

  it('surfaces a stable API error code as an operator message', async () => {
    vi.stubGlobal('confirm', () => true)
    const wrapper = await mountPanel()
    mocks.request.mockImplementation(async (_path: string, options?: { method?: string }) => {
      if (options?.method === 'POST') throw { data: { error: { code: 'concurrency_conflict' } } }
      return { items: [] }
    })
    await wrapper.find('button[data-action="release-commitment"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').text()).toContain('Conflicto de versión')
    vi.unstubAllGlobals()
  })
})
