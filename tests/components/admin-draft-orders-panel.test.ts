import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminDraftOrdersPanel from '../../app/components/AdminDraftOrdersPanel.vue'
import '#app/nuxt-vitest-app-entry'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => fetchMock)
mockNuxtImport('$fetch', () => fetchMock)

const sampleDrafts = [
  {
    id: 'draft-101',
    draftNumber: 'DFT-2026-10001',
    customerId: 'cust-hosp-01',
    companyName: 'Hospital Virgen del Mar SL',
    contactEmail: 'compras@virgendelmar.es',
    status: 'pending_approval',
    totalCents: 45000,
    subtotalCents: 36000,
    taxCents: 7560,
    shippingCents: 1440,
    currency: 'EUR',
    items: [
      {
        variantId: 'var-cloro-25',
        sku: 'CLR-25L',
        name: 'Cloro Hospitalario 25L',
        quantity: 10,
        unitPriceCents: 3600,
        lineTotalCents: 36000
      }
    ],
    inventoryReserved: 0,
    paymentStatus: 'unbilled',
    expiresAt: '2026-10-31T12:00:00Z',
    approvalRequestedAt: '2026-10-29T10:00:00Z',
    approvedAt: null,
    approvedBy: null,
    rejectionReason: null,
    convertedOrderId: null,
    version: 2,
    createdBy: '10000000-0000-4000-8000-000000000022',
    createdAt: '2026-10-29T09:00:00Z',
    updatedAt: '2026-10-29T10:00:00Z',
    timeline: [
      {
        id: 't-1',
        draftOrderId: 'draft-101',
        eventType: 'created',
        fromStatus: null,
        toStatus: 'draft',
        actorType: 'customer',
        actorId: '10000000-0000-4000-8000-000000000022',
        notes: null,
        createdAt: '2026-10-29T09:00:00Z'
      },
      {
        id: 't-2',
        draftOrderId: 'draft-101',
        eventType: 'submitted_for_approval',
        fromStatus: 'draft',
        toStatus: 'pending_approval',
        actorType: 'customer',
        actorId: '10000000-0000-4000-8000-000000000022',
        notes: 'Descuento volumen solicitado',
        createdAt: '2026-10-29T10:00:00Z'
      }
    ]
  }
]

describe('CHK-022: AdminDraftOrdersPanel Component', () => {
  let wrappers: Array<{ unmount(): void }> = []

  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(sampleDrafts)
  })

  afterEach(() => {
    wrappers.forEach((w) => w.unmount())
    wrappers = []
  })

  it('renders header, CHK-022 guardrail alert, and draft list with expiration', async () => {
    const wrapper = await mountSuspended(AdminDraftOrdersPanel)
    wrappers.push(wrapper)
    await flushPromises()

    expect(wrapper.text()).toContain('Pedidos como Borrador Sujetos a Aprobación (CHK-022)')
    expect(wrapper.text()).toContain('Criterio de Aceptación CHK-022')
    expect(wrapper.text()).toContain('No reserva inventario ni cobra de forma indefinida')
    expect(wrapper.text()).toContain('DFT-2026-10001')
    expect(wrapper.text()).toContain('Hospital Virgen del Mar SL')
    expect(wrapper.text()).toContain('Expira: 2026-10-31T12:00:00Z')
  })

  it('approves a pending draft order and updates status', async () => {
    const wrapper = await mountSuspended(AdminDraftOrdersPanel)
    wrappers.push(wrapper)
    await flushPromises()

    fetchMock.mockResolvedValueOnce({
      ...sampleDrafts[0],
      status: 'approved',
      version: 3
    })

    const approveBtn = wrapper.findAll('button').find((b) => b.text() === 'Aprobar')
    expect(approveBtn).toBeDefined()
    await approveBtn?.trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/draft-orders/review',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ decision: 'approved' })
      })
    )
    expect(wrapper.text()).toContain('marcado como approved')
  })

  it('sweeps expired draft orders when clicking sweep button', async () => {
    const wrapper = await mountSuspended(AdminDraftOrdersPanel)
    wrappers.push(wrapper)
    await flushPromises()

    fetchMock.mockResolvedValueOnce({ expiredCount: 3 })
    fetchMock.mockResolvedValueOnce([]) // reload list

    const sweepBtn = wrapper.findAll('button').find((b) => b.text().includes('Barrer Expirados'))
    expect(sweepBtn).toBeDefined()
    await sweepBtn?.trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/admin/draft-orders/sweep', expect.objectContaining({ method: 'POST' }))
    expect(wrapper.text()).toContain("Barrido ejecutado: 3 borradores vencidos actualizados a 'expired'")
  })

  it('displays error state when list fetch fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Fallo al cargar borradores'))
    const wrapper = await mountSuspended(AdminDraftOrdersPanel)
    wrappers.push(wrapper)
    await flushPromises()

    expect(wrapper.text()).toContain('Fallo al cargar borradores')
  })
})
