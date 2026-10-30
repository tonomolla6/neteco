import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminSupplierSourcingPanel from '../../app/components/AdminSupplierSourcingPanel.vue'
import '#app/nuxt-vitest-app-entry'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => fetchMock)
mockNuxtImport('$fetch', () => fetchMock)

const sampleOfferings = [
  {
    id: 'off-101',
    supplierId: 'sup-alpha',
    productId: 'prod-desengrasante',
    variantId: 'var-desengrasante-5l',
    supplierSku: 'ALPHA-5L',
    costCents: 1200,
    currency: 'EUR',
    leadTimeDays: 4,
    minOrderQuantity: 1,
    isPreferred: 0,
    isActive: 1,
    version: 1,
    createdAt: '2026-10-29T10:00:00Z',
    updatedAt: '2026-10-29T10:00:00Z'
  },
  {
    id: 'off-102',
    supplierId: 'sup-beta',
    productId: 'prod-desengrasante',
    variantId: 'var-desengrasante-5l',
    supplierSku: 'BETA-FAST-5L',
    costCents: 1500,
    currency: 'EUR',
    leadTimeDays: 1,
    minOrderQuantity: 5,
    isPreferred: 1,
    isActive: 1,
    version: 1,
    createdAt: '2026-10-29T10:00:00Z',
    updatedAt: '2026-10-29T10:00:00Z'
  }
]

const sampleDecisions = [
  {
    id: 'dec-101',
    variantId: 'var-desengrasante-5l',
    selectedSupplierId: 'sup-beta',
    selectedOfferingId: 'off-102',
    strategy: 'shortest_lead_time',
    selectionReason: 'Entrega en 24h para pedido urgente',
    retailPriceCents: 2500,
    costCents: 1500,
    marginCents: 1000,
    marginPercent: 40.0,
    leadTimeDays: 1,
    candidateOptions: sampleOfferings,
    actorId: '10000000-0000-4000-8000-000000000021',
    createdAt: '2026-10-29T11:00:00Z'
  }
]

describe('CAT-021: AdminSupplierSourcingPanel Component', () => {
  let wrappers: Array<{ unmount(): void }> = []

  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/offerings')) return Promise.resolve(sampleOfferings)
      if (url.includes('/decisions')) return Promise.resolve(sampleDecisions)
      return Promise.resolve([])
    })
  })

  afterEach(() => {
    wrappers.forEach((w) => w.unmount())
    wrappers = []
  })

  it('renders header, variantId, and offerings table with calculated margins', async () => {
    const wrapper = await mountSuspended(AdminSupplierSourcingPanel, {
      props: {
        variantId: 'var-desengrasante-5l',
        defaultRetailPriceCents: 2500
      }
    })
    wrappers.push(wrapper)
    await flushPromises()

    expect(wrapper.text()).toContain('Multi-Proveedor y Selección de Suministro Trazable (CAT-021)')
    expect(wrapper.text()).toContain('ALPHA-5L')
    expect(wrapper.text()).toContain('BETA-FAST-5L')
    expect(wrapper.text()).toContain('Preferente')
    expect(wrapper.text()).toContain('52.0%') // (2500 - 1200) / 2500 = 52.0%
    expect(wrapper.text()).toContain('40.0%') // (2500 - 1500) / 2500 = 40.0%
  })

  it('displays traceable decision history', async () => {
    const wrapper = await mountSuspended(AdminSupplierSourcingPanel, {
      props: {
        variantId: 'var-desengrasante-5l'
      }
    })
    wrappers.push(wrapper)
    await flushPromises()

    expect(wrapper.text()).toContain('Historial Trazable de Decisiones de Suministro')
    expect(wrapper.text()).toContain('Entrega en 24h para pedido urgente')
  })

  it('records new sourcing selection and displays confirmation', async () => {
    const wrapper = await mountSuspended(AdminSupplierSourcingPanel, {
      props: {
        variantId: 'var-desengrasante-5l'
      }
    })
    wrappers.push(wrapper)
    await flushPromises()

    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/decision')) {
        return Promise.resolve({
          ...sampleDecisions[0],
          id: 'dec-102',
          marginPercent: 52.0
        })
      }
      return Promise.resolve([])
    })

    const recordBtn = wrapper.findAll('button').find((b) => b.text().includes('Registrar Selección Trazable'))
    expect(recordBtn).toBeDefined()
    await recordBtn?.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Decisión de suministro registrada con trazabilidad')
  })

  it('displays error state when API fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Fallo al obtener ofertas de proveedor'))
    const wrapper = await mountSuspended(AdminSupplierSourcingPanel, {
      props: {
        variantId: 'var-error'
      }
    })
    wrappers.push(wrapper)
    await flushPromises()

    expect(wrapper.text()).toContain('Fallo al obtener ofertas de proveedor')
  })
})
