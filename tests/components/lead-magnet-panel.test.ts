import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Panel from '../../app/components/LeadMagnetPanel.vue'
import { LEAD_MAGNETS } from '../../shared/lead-magnets'
import '#app/nuxt-vitest-app-entry'

const { write } = vi.hoisted(() => ({ write: vi.fn() }))
mockNuxtImport('$fetch', () => write)

const wrappers: Array<{ unmount: () => void }> = []
const bySlug = (slug: string) => LEAD_MAGNETS.find((m) => m.slug === slug)!
beforeEach(() => {
  write.mockReset()
})
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount()
})
async function render(slug: string, loader?: () => Promise<unknown>) {
  write.mockImplementation(async (url: string, options?: { method?: string }) => {
    if (options?.method === 'POST') return { accepted: true }
    return loader ? loader() : bySlug(slug)
  })
  const w = await mountSuspended(Panel, { props: { slug } })
  wrappers.push(w)
  await flushPromises()
  return w
}
const posts = () => write.mock.calls.filter((call) => call[1]?.method === 'POST')

it('shows the full checklist without any form gate and counts progress locally', async () => {
  const w = await render('checklist-seguridad-productos-quimicos')
  expect(w.findAll('li').length).toBeGreaterThanOrEqual(8)
  expect(w.get('[data-testid="progress"]').text()).toContain('0 de')
  await w.findAll('input[type="checkbox"]')[0]!.setValue(true)
  expect(w.get('[data-testid="progress"]').text()).toContain('1 de')
  expect(posts()).toHaveLength(0)
})

it('shows loading first and an accessible retryable error when the resource fails', async () => {
  let fail = true
  const w = await render('guia-limpieza-desinfeccion-hosteleria', async () => {
    if (fail) throw new Error('offline')
    return bySlug('guia-limpieza-desinfeccion-hosteleria')
  })
  expect(w.get('[role="alert"]').text()).toContain('No hemos podido cargar')
  fail = false
  await w.get('[role="alert"] button').trigger('click')
  await flushPromises()
  expect(w.findAll('article').length).toBeGreaterThanOrEqual(4)
})

it('calculates a dilution and shows the label reminder', async () => {
  const w = await render('calculadora-dilucion')
  await w.get('#calc-value').setValue('2,5')
  await w.get('#calc-liters').setValue('10')
  await w.get('#calc-price').setValue('8')
  await w.get('form').trigger('submit')
  const result = w.get('[data-testid="calc-result"]').text()
  expect(result).toContain('Producto: 250 ml')
  expect(result).toContain('Agua: 9750 ml')
  expect(result).toContain('2.00 €')
  expect(result).toMatch(/etiqueta/i)
})

it('reports invalid calculator input instead of a number', async () => {
  const w = await render('calculadora-dilucion')
  await w.get('#calc-value').setValue('500')
  await w.get('#calc-liters').setValue('10')
  await w.get('form').trigger('submit')
  expect(w.find('[data-testid="calc-result"]').exists()).toBe(false)
  expect(w.get('[role="alert"]').text()).toContain('Revisa los valores')
})

it('requests a copy with only the e-mail and an unchecked, optional consent', async () => {
  const w = await render('checklist-seguridad-productos-quimicos')
  const consent = w
    .get('#copy-title')
    .element.closest('form')!
    .querySelector('input[type="checkbox"]') as HTMLInputElement
  expect(consent.checked).toBe(false)
  expect(consent.required).toBe(false)
  await w.get('#copy-email').setValue('ana@example.com')
  await w.get('#copy-title').element.closest('form')!.dispatchEvent(new Event('submit'))
  await flushPromises()
  expect(posts()).toHaveLength(1)
  expect(posts()[0]![0]).toBe('/api/lead-magnets/checklist-seguridad-productos-quimicos/request-copy')
  expect(posts()[0]![1].body).toEqual({ email: 'ana@example.com', marketingConsent: false })
  expect(w.text()).toContain('recibirás la copia')
})

it('sends the consent only when the visitor ticks it', async () => {
  const w = await render('checklist-seguridad-productos-quimicos')
  await w.get('#copy-email').setValue('ana@example.com')
  await w.findAll('input[type="checkbox"]').at(-1)!.setValue(true)
  w.get('#copy-title').element.closest('form')!.dispatchEvent(new Event('submit'))
  await flushPromises()
  expect(posts()[0]![1].body.marketingConsent).toBe(true)
})

it('keeps the honeypot hidden from assistive technology and out of the payload when empty', async () => {
  const w = await render('checklist-seguridad-productos-quimicos')
  const trap = w.get('#copy-website').element.closest('div')!
  expect(trap.getAttribute('aria-hidden')).toBe('true')
  expect(w.get('#copy-website').attributes('tabindex')).toBe('-1')
})

it('tells the visitor when they are rate limited and allows trying again', async () => {
  const w = await render('checklist-seguridad-productos-quimicos')
  write.mockImplementation(async (_url: string, options?: { method?: string }) => {
    if (options?.method === 'POST') throw Object.assign(new Error('429'), { statusCode: 429 })
    return bySlug('checklist-seguridad-productos-quimicos')
  })
  await w.get('#copy-email').setValue('ana@example.com')
  w.get('#copy-title').element.closest('form')!.dispatchEvent(new Event('submit'))
  await flushPromises()
  expect(w.text()).toContain('demasiadas solicitudes')
  expect(
    w.get('#copy-title').element.closest('form')!.querySelector('button[type="submit"]')!.hasAttribute('disabled')
  ).toBe(false)
})

it('shows a generic error for any other failure without exposing details', async () => {
  const w = await render('checklist-seguridad-productos-quimicos')
  write.mockImplementation(async (_url: string, options?: { method?: string }) => {
    if (options?.method === 'POST') throw Object.assign(new Error('SQL secret'), { statusCode: 500 })
    return bySlug('checklist-seguridad-productos-quimicos')
  })
  await w.get('#copy-email').setValue('ana@example.com')
  w.get('#copy-title').element.closest('form')!.dispatchEvent(new Event('submit'))
  await flushPromises()
  expect(w.text()).toContain('No hemos podido enviar la copia')
  expect(w.text()).not.toContain('SQL secret')
})
