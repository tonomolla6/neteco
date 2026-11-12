// @vitest-environment nuxt
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import HomePage from '../../app/pages/index.vue'

const family = (id: number, slug: string, count: number) => ({
  id,
  name: `Familia ${slug}`,
  slug,
  parentId: 1,
  sort: id,
  count,
  children: []
})
registerEndpoint('/api/categories', () => ({
  roots: [
    {
      id: 1,
      name: 'Raíz',
      slug: 'raiz',
      parentId: null,
      sort: 0,
      count: 20,
      children: [family(2, 'guantes-y-proteccion', 20), family(3, 'limpiadores-generales', 0), family(4, 'celulosa', 0)]
    }
  ],
  flat: []
}))
registerEndpoint('/api/products', () => ({ items: [], total: 0, page: 1, pages: 1 }))

describe('home shows only what can be bought', () => {
  it('lists families with products and never an empty one', async () => {
    const page = await mountSuspended(HomePage, {
      global: { stubs: { PromotionalBlocks: true, HeroOfferSlider: true, ProductCard: true, HomeReorder: true } }
    })
    await flushPromises()
    expect(page.find('a[href="/categoria/guantes-y-proteccion"]').exists()).toBe(true)
    expect(page.find('a[href="/categoria/limpiadores-generales"]').exists()).toBe(false)
    expect(page.find('a[href="/categoria/celulosa"]').exists()).toBe(false)
    expect(page.text()).not.toContain('Consúltanos disponibilidad')
    // sector shortcuts only point at families that have products
    const sectors = page.findAll('[data-home-sector]')
    expect(sectors.map((sector) => sector.attributes('href'))).toEqual(['/categoria/guantes-y-proteccion'])
    expect(page.html()).not.toContain('uppercase')
  })
})
