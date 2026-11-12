// @vitest-environment nuxt
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AppFooter from '../../app/components/AppFooter.vue'

const config = vi.hoisted(() => ({ appEnv: 'local', commercial: {} as Record<string, unknown> }))
const nuxtRuntime = vi.hoisted(() => ({ original: null as null | (() => { public: Record<string, unknown> }) }))
mockNuxtImport('useRuntimeConfig', (original) => {
  nuxtRuntime.original = original as never
  return () => {
    const base = nuxtRuntime.original!()
    return { ...base, public: { ...base.public, ...config } }
  }
})

beforeEach(() => {
  config.appEnv = 'local'
  config.commercial = {}
})

describe('shop footer', () => {
  it('leads with shop and help links, without cart/account duplicates or empty sections', async () => {
    const footer = await mountSuspended(AppFooter)
    const hrefs = footer.findAll('a').map((link) => link.attributes('href'))
    expect(hrefs).toContain('/pedido-rapido')
    expect(hrefs).toContain('/envios')
    expect(hrefs).not.toContain('/carrito')
    expect(hrefs).not.toContain('/cuenta')
    expect(hrefs).not.toContain('/categoria/productos-quimicos')
    expect(footer.html()).not.toContain('uppercase')
    // the newsletter is the last block, not the first
    const html = footer.html()
    expect(html.indexOf('footer-newsletter-email')).toBeGreaterThan(html.indexOf('href="/envios"'))
  })

  it('links the four legal pages inside the shop and keeps the cookie settings button', async () => {
    const footer = await mountSuspended(AppFooter)
    const hrefs = footer.findAll('a').map((link) => link.attributes('href'))
    for (const path of ['/aviso-legal', '/privacidad', '/cookies', '/condiciones-generales'])
      expect(hrefs).toContain(path)
    expect(hrefs.some((href) => href?.startsWith('https://neteco.es/legal'))).toBe(false)
    expect(footer.text()).toContain('Configurar cookies')
  })

  it('collapses the link groups on mobile behind buttons that say their state', async () => {
    const footer = await mountSuspended(AppFooter)
    const toggles = footer.findAll('[data-footer-toggle]')
    expect(toggles.map((toggle) => toggle.text())).toEqual(['Tienda', 'Ayuda', 'Contacto'])
    expect(toggles[0]!.attributes('aria-expanded')).toBe('false')
    const panel = footer.get(`#${toggles[0]!.attributes('aria-controls')}`)
    expect(panel.classes()).toContain('hidden')
    expect(panel.classes()).toContain('sm:block')
    await toggles[0]!.trigger('click')
    expect(toggles[0]!.attributes('aria-expanded')).toBe('true')
    expect(panel.classes()).not.toContain('hidden')
  })

  it('identifies the owner with tax id and address only when configured', async () => {
    let footer = await mountSuspended(AppFooter)
    expect(footer.find('[data-footer-legal]').text()).not.toMatch(/NIF|domicilio/i)
    config.commercial = {
      companyTaxId: '00000000T',
      companyAddress: 'C/ Mayor 1, 46870 Ontinyent',
      supportHours: 'de lunes a viernes de 9:00 a 18:00'
    }
    footer = await mountSuspended(AppFooter)
    expect(footer.get('[data-footer-legal]').text()).toContain('NIF 00000000T')
    expect(footer.get('[data-footer-legal]').text()).toContain('C/ Mayor 1, 46870 Ontinyent')
    expect(footer.text()).toContain('de lunes a viernes de 9:00 a 18:00')
  })

  it('states how long the shop has been supplying only with the configured founding year', async () => {
    let footer = await mountSuspended(AppFooter)
    expect(footer.text()).not.toMatch(/\d+ años|Desde \d{4}/)
    config.commercial = { foundedYear: 1998 }
    footer = await mountSuspended(AppFooter)
    expect(footer.text()).toContain('Desde 1998')
  })

  it('never shows the internal demo notice in production', async () => {
    expect((await mountSuspended(AppFooter)).text()).toContain('Demo interna')
    config.appEnv = 'production'
    expect((await mountSuspended(AppFooter)).text()).not.toContain('Demo interna')
  })
})
