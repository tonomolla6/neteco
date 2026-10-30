import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminSupplierFeedComparison from '../../app/components/AdminSupplierFeedComparison.vue'
import '#app/nuxt-vitest-app-entry'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => fetchMock)
mockNuxtImport('$fetch', () => fetchMock)

const sampleItems = [
  {
    id: '30000000-0000-4000-8000-000000000101',
    importId: 'feed-import-001',
    supplierId: 'SUP-QUIM-01',
    supplierSku: 'QUIM-ALTA-10',
    diffType: 'alta',
    productId: null,
    variantId: null,
    status: 'pending_review',
    isPublished: 0,
    beforePayload: null,
    afterPayload: { name: 'Desengrasante Alcalino 10L', priceCents: 1850 },
    diffDetails: { reason: 'new_item_in_feed' },
    version: 1,
    createdAt: '2026-10-29T10:00:00Z',
    updatedAt: '2026-10-29T10:00:00Z'
  },
  {
    id: '30000000-0000-4000-8000-000000000102',
    importId: 'feed-import-001',
    supplierId: 'SUP-QUIM-01',
    supplierSku: 'QUIM-CAMBIO-20',
    diffType: 'cambio',
    productId: 'prod-20',
    variantId: 'var-20',
    status: 'approved',
    isPublished: 0,
    beforePayload: { priceCents: 1200 },
    afterPayload: { priceCents: 1450 },
    diffDetails: { changedFields: [{ field: 'priceCents', before: 1200, after: 1450 }] },
    version: 2,
    createdAt: '2026-10-29T10:00:00Z',
    updatedAt: '2026-10-29T10:05:00Z'
  }
]

describe('CAT-018: AdminSupplierFeedComparison Component', () => {
  let wrappers: Array<{ unmount(): void }> = []

  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(sampleItems)
  })

  afterEach(() => {
    wrappers.forEach((w) => w.unmount())
    wrappers = []
  })

  it('renders header, acceptance guardrail banner, and counters', async () => {
    const wrapper = await mountSuspended(AdminSupplierFeedComparison, {
      props: {
        importId: 'feed-import-001',
        supplierId: 'SUP-QUIM-01'
      }
    })
    wrappers.push(wrapper)
    await flushPromises()

    expect(wrapper.text()).toContain('Comparación de Feed de Proveedor (CAT-018)')
    expect(wrapper.text()).toContain('Guardrail de Aceptación')
    expect(wrapper.text()).toContain('Altas, cambios y bajas quedan en revisión obligatoria')
    expect(wrapper.text()).toContain('QUIM-ALTA-10')
    expect(wrapper.text()).toContain('QUIM-CAMBIO-20')
  })

  it('filters by diffType when selector changes', async () => {
    const wrapper = await mountSuspended(AdminSupplierFeedComparison, {
      props: {
        importId: 'feed-import-001',
        supplierId: 'SUP-QUIM-01'
      }
    })
    wrappers.push(wrapper)
    await flushPromises()

    const select = wrapper.find('select#diff-filter')
    await select.setValue('alta')
    await flushPromises()

    expect(wrapper.text()).toContain('QUIM-ALTA-10')
    expect(wrapper.text()).not.toContain('QUIM-CAMBIO-20')
  })

  it('approves an item and updates its state and counters', async () => {
    const wrapper = await mountSuspended(AdminSupplierFeedComparison, {
      props: {
        importId: 'feed-import-001',
        supplierId: 'SUP-QUIM-01'
      }
    })
    wrappers.push(wrapper)
    await flushPromises()

    fetchMock.mockResolvedValueOnce({ success: true })
    const approveBtn = wrapper.findAll('button').find((b) => b.text().includes('Aprobar'))
    expect(approveBtn).toBeDefined()
    await approveBtn?.trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/supplier-feed/review',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ decision: 'approved' })
      })
    )
  })

  it('displays error state when API load fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Error de conexión con base de datos'))
    const wrapper = await mountSuspended(AdminSupplierFeedComparison, {
      props: {
        importId: 'feed-import-error'
      }
    })
    wrappers.push(wrapper)
    await flushPromises()

    expect(wrapper.text()).toContain('Error de conexión con base de datos')
  })
})
