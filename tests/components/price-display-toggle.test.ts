// @vitest-environment nuxt
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { useNuxtApp } from '#app'
import { nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PriceModeToggle from '../../app/components/PriceModeToggle.vue'
import PriceBlock from '../../app/components/PriceBlock.vue'
import { resolveInitialPriceMode, usePriceDisplay } from '../../app/composables/usePriceDisplay'

const auth = vi.hoisted(() => ({ user: null as null | { value: { company: string | null } | null } }))
mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(!!auth.user?.value),
  user: auth.user ?? ref(null),
  ready: ref(true),
  session: ref(null),
  clear: vi.fn(),
  fetch: vi.fn()
}))

afterEach(() => {
  document.cookie = 'price_display=; max-age=0; path=/'
  delete useNuxtApp().payload.state['$sprice-display-mode']
  auth.user = null
})

describe('initial price mode', () => {
  it('prefers the visitor choice, then the account type, then the deployment default', () => {
    expect(resolveInitialPriceMode({ saved: 'gross', company: true, fallback: 'net' })).toBe('gross')
    expect(resolveInitialPriceMode({ saved: 'net', company: false, fallback: 'gross' })).toBe('net')
    expect(resolveInitialPriceMode({ saved: null, company: true, fallback: 'gross' })).toBe('net')
    expect(resolveInitialPriceMode({ saved: null, company: false, fallback: 'gross' })).toBe('gross')
    expect(resolveInitialPriceMode({ saved: 'nonsense', company: false, fallback: 'net' })).toBe('net')
  })
})

describe('PriceModeToggle', () => {
  it('is a labelled radio group that switches every price block without reloading and remembers the choice', async () => {
    const toggle = await mountSuspended(PriceModeToggle)
    const block = await mountSuspended(PriceBlock, { props: { grossCents: 1186, netCents: 980 } })
    const group = toggle.get('[role="radiogroup"]')
    expect(group.attributes('aria-label')).toBe('Precios')
    const [net, gross] = toggle.findAll('[role="radio"]')
    expect(net!.text()).toBe('Sin IVA')
    expect(gross!.text()).toBe('Con IVA')
    expect(gross!.attributes('aria-checked')).toBe('true')
    expect(block.text().replace(/\s+/g, ' ')).toContain('11,86 € IVA incluido')

    await net!.trigger('click')
    await nextTick()
    expect(net!.attributes('aria-checked')).toBe('true')
    expect(gross!.attributes('aria-checked')).toBe('false')
    expect(block.text().replace(/\s+/g, ' ')).toContain('9,80 € sin IVA')
    expect(block.text().replace(/\s+/g, ' ')).toContain('11,86 € con IVA')
    expect(document.cookie).toContain('price_display=net')

    await net!.trigger('keydown', { key: 'ArrowRight' })
    await nextTick()
    expect(usePriceDisplay().mode.value).toBe('gross')
    toggle.unmount()
    block.unmount()
  })

  it('PriceBlock shows the unit-of-measure price in the active mode and a real previous price', async () => {
    const block = await mountSuspended(PriceBlock, {
      props: { grossCents: 1186, netCents: 980, units: 5, unitLabel: 'L', from: true, compareAtCents: 1400 }
    })
    const text = () => block.text().replace(/\s+/g, ' ')
    expect(text()).toContain('desde 11,86 €')
    expect(text()).toContain('2,37 €/L')
    expect(block.get('s').text().replace(/\s+/g, ' ')).toBe('14,00 €')
    usePriceDisplay().setMode('net')
    await nextTick()
    expect(text()).toContain('1,96 €/L')
    usePriceDisplay().setMode('gross')
    block.unmount()
  })
})
