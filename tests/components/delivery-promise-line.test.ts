import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { clearNuxtState } from '#app'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DeliveryPromiseLine from '../../app/components/DeliveryPromiseLine.vue'

const configuration = vi.hoisted(() => ({ calendar: true }))

mockNuxtImport('useRuntimeConfig', (original) => () => {
  const config = original()
  return {
    ...config,
    public: {
      ...config.public,
      serverRuntime: 'cloudflare',
      commercial: configuration.calendar
        ? {
            ownDeliveryDays: 'martes y jueves',
            orderCutoffTime: '13:00',
            parcelLeadTime: '24-72 h'
          }
        : {}
    }
  }
})
const roots: Awaited<ReturnType<typeof mountSuspended>>[] = []
beforeEach(() => {
  configuration.calendar = true
  vi.setSystemTime(new Date('2026-11-16T09:00:00Z'))
  clearNuxtState('delivery-destination')
  localStorage.clear()
})
afterEach(() => {
  roots.splice(0).forEach((root) => root.unmount())
  clearNuxtState('delivery-destination')
  localStorage.clear()
  vi.useRealTimers()
})
async function line(preparationDays: number | null = 0) {
  const root = await mountSuspended(DeliveryPromiseLine, {
    props: { preparationDays },
    global: { stubs: { UIcon: true } }
  })
  roots.push(root)
  await flushPromises()
  return root
}

describe('delivery promise in the buy box', () => {
  it('refines the date using only a postal code and shares the remembered destination', async () => {
    const root = await line()
    expect(root.get('[data-delivery-date]').text()).toBe('jueves, 19 de noviembre')
    await root.get('[data-delivery-change]').trigger('click')
    await root.get('input').setValue('46870')
    await root.get('form').trigger('submit')
    expect(root.get('[data-delivery-date]').text()).toBe('martes, 17 de noviembre')
    expect(root.text()).toContain('46870 Valencia')
    expect(JSON.parse(localStorage.getItem('neteco-destination')!)).toEqual({ postalCode: '46870', city: 'Valencia' })
    expect((await line()).text()).toContain('46870 Valencia')
  })
  it('shows a useful validation error without remembering an invalid postal code', async () => {
    const root = await line()
    await root.get('[data-delivery-change]').trigger('click')
    await root.get('input').setValue('abc')
    await root.get('form').trigger('submit')
    expect(root.get('input').attributes('aria-invalid')).toBe('true')
    expect(root.text()).toContain('Escribe un código postal de 5 cifras')
    expect(localStorage.getItem('neteco-destination')).toBeNull()
  })
  it('does not promise a concrete date for backorders with no known preparation time', async () => {
    const root = await line(null)
    expect(root.find('[data-delivery-date]').exists()).toBe(false)
    expect(root.text()).toContain('Te confirmamos la fecha')
  })
  it('still accepts a destination when no calendar is configured, without inventing a delivery day', async () => {
    configuration.calendar = false
    const root = await line()
    expect(root.find('[data-delivery-date]').exists()).toBe(false)
    await root.get('[data-delivery-change]').trigger('click')
    await root.get('input').setValue('46870')
    await root.get('form').trigger('submit')
    expect(JSON.parse(localStorage.getItem('neteco-destination')!)).toEqual({ postalCode: '46870', city: 'Valencia' })
    expect(root.find('[data-delivery-date]').exists()).toBe(false)
  })
  it('gives simultaneous buy-box and shipping-tab forms unique input and error identifiers', async () => {
    const Harness = defineComponent({
      setup: () => () => h('div', [h(DeliveryPromiseLine), h(DeliveryPromiseLine)])
    })
    const root = await mountSuspended(Harness, { global: { stubs: { UIcon: true } } })
    roots.push(root)
    await flushPromises()
    const [first, second] = root.findAllComponents(DeliveryPromiseLine)
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    for (const form of [first!, second!]) {
      await form.get('[data-delivery-change]').trigger('click')
      await form.get('input').setValue('invalid')
      await form.get('form').trigger('submit')
    }
    const ids = [first!, second!].map((form) => form.get('input').attributes('id'))
    expect(new Set(ids).size).toBe(2)
    for (const form of [first!, second!]) {
      expect(form.get('label').attributes('for')).toBe(form.get('input').attributes('id'))
      expect(form.get(`[id="${form.get('input').attributes('aria-describedby')}"]`).exists()).toBe(true)
    }
  })
})
