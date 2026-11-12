// @vitest-environment nuxt
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import HomePage from '../../app/pages/index.vue'
import ShippingPage from '../../app/pages/envios.vue'

const commercial = vi.hoisted(() => ({ value: {} as Record<string, unknown>, threshold: 0 as unknown }))
const nuxtRuntime = vi.hoisted(() => ({ original: null as null | (() => Record<string, unknown>) }))
mockNuxtImport('useRuntimeConfig', (original) => {
  nuxtRuntime.original = original as never
  return () => {
    const config = nuxtRuntime.original!() as { public: Record<string, unknown> }
    return {
      ...config,
      public: {
        ...config.public,
        mediaGoverned: true,
        bankTransferEnabled: false,
        freeShippingThresholdCents: commercial.threshold,
        commercial: commercial.value
      }
    }
  }
})

const node = (id: number, slug: string, children: unknown[] = []) => ({
  id,
  name: slug,
  slug,
  parentId: null,
  sort: id,
  count: 3,
  children
})
registerEndpoint('/api/categories', () => ({
  roots: [node(1, 'productos-quimicos', [node(2, 'linea-eco-profesional')])],
  flat: []
}))
registerEndpoint('/api/products', () => ({ items: [], total: 0, page: 1, pages: 1 }))

const stubs = { PromotionalBlocks: true, SearchBox: true, HeroOfferSlider: true, ProductCard: true }

describe('commercial promises on the shop', () => {
  beforeEach(() => {
    commercial.value = {}
    commercial.threshold = 0
  })

  it('home: without business data shows three factual items and no figure', async () => {
    const wrapper = await mountSuspended(HomePage, { global: { stubs } })
    const strip = wrapper.get('[data-commercial-promises]')
    expect(strip.findAll('a')).toHaveLength(3)
    expect(strip.text()).toContain("En Ontinyent y la Vall d'Albaida te lo llevamos nosotros.")
    expect(strip.text()).toContain('Te atiende una persona: 600 861 334.')
    expect(strip.text()).not.toMatch(/Pide antes|Gratis desde|días/)
    expect(wrapper.text()).not.toContain('NETTION')
  })

  it('home: with configured data states route days, cut-off and threshold in four items', async () => {
    commercial.value = { ownDeliveryDays: 'martes y jueves', orderCutoffTime: '13:00', ecoRangeBrand: 'NETTION' }
    commercial.threshold = 15000
    const wrapper = await mountSuspended(HomePage, { global: { stubs } })
    const strip = wrapper.get('[data-commercial-promises]')
    expect(strip.findAll('a')).toHaveLength(4)
    expect(strip.text()).toContain('martes y jueves. Pide antes de las 13:00.')
    expect(strip.text()).toContain('Gratis desde 150 € en paquetería estándar.')
    expect(wrapper.text()).toContain('La gama ecológica NETTION.')
  })

  it('shipping page: no invented figures by default, real ones when configured', async () => {
    let wrapper = await mountSuspended(ShippingPage)
    expect(wrapper.text()).toContain('Llámanos y te decimos el próximo día de ruta')
    expect(wrapper.text()).toContain('Lo ves antes de pagar, al indicar tu código postal')
    expect(wrapper.text()).not.toMatch(/09:00|24-48|150 €/)

    commercial.value = {
      ownDeliveryDays: 'martes y jueves',
      orderCutoffTime: '13:00',
      ownDeliveryCostCents: '0',
      parcelLeadTime: '24-48 h',
      supportHours: 'de lunes a viernes de 9:00 a 18:00'
    }
    commercial.threshold = 15000
    wrapper = await mountSuspended(ShippingPage)
    expect(wrapper.text()).toContain('Martes y jueves. Pide antes de las 13:00')
    expect(wrapper.text()).toContain('24-48 h')
    expect(wrapper.text()).toContain('Gratis desde 150 € en paquetería estándar')
    expect(wrapper.text()).toContain('(de lunes a viernes de 9:00 a 18:00)')
  })
})
