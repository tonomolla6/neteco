// @vitest-environment nuxt
import { readFileSync } from 'node:fs'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import LegalNoticePage from '../../app/pages/aviso-legal.vue'
import PrivacyPage from '../../app/pages/privacidad.vue'
import CookiesPage from '../../app/pages/cookies.vue'
import SalesTermsPage from '../../app/pages/condiciones-generales.vue'
import ReturnsPage from '../../app/pages/devoluciones.vue'
import { LEGAL_PAGES } from '../../shared/legal-pages'

const config = vi.hoisted(() => ({
  appEnv: 'local',
  serverRuntime: 'node',
  bankTransferEnabled: false,
  freeShippingThresholdCents: 0,
  commercial: {} as Record<string, unknown>
}))
const nuxtRuntime = vi.hoisted(() => ({ original: null as null | (() => { public: Record<string, unknown> }) }))
mockNuxtImport('useRuntimeConfig', (original) => {
  nuxtRuntime.original = original as never
  return () => {
    const base = nuxtRuntime.original!()
    return { ...base, public: { ...base.public, ...config } }
  }
})

const PAGES = [
  ['/aviso-legal', LegalNoticePage],
  ['/privacidad', PrivacyPage],
  ['/cookies', CookiesPage],
  ['/condiciones-generales', SalesTermsPage]
] as const

const PROVISIONAL = {
  companyLegalName: 'Titular Provisional de Pruebas',
  companyTaxId: '00000000T',
  companyAddress: 'Calle de Prueba 1, 46870 Ontinyent (Valencia)',
  companyRegistry: 'Inscripción provisional de pruebas',
  contactEmail: 'pruebas@example.com',
  contactPhone: '+34 600 000 000',
  dpoEmail: 'dpd-pruebas@example.com',
  disputeResolutionEntity: 'Entidad provisional de pruebas'
}

beforeEach(() => {
  config.appEnv = 'local'
  config.serverRuntime = 'node'
  config.commercial = {}
})

describe('legal pages: routes and structure', () => {
  it('declares the four legal routes once, with title and description', () => {
    expect(LEGAL_PAGES.map((page) => page.path)).toEqual([
      '/aviso-legal',
      '/privacidad',
      '/cookies',
      '/condiciones-generales'
    ])
    for (const page of LEGAL_PAGES) {
      expect(page.title.length).toBeGreaterThan(5)
      expect(page.description.length).toBeGreaterThan(60)
      expect(page.description.length).toBeLessThanOrEqual(155)
    }
  })

  it.each(PAGES)(
    '%s has one h1, an index whose anchors all resolve, and links to the other legal pages',
    async (path, page) => {
      const wrapper = await mountSuspended(page)
      expect(wrapper.findAll('h1')).toHaveLength(1)
      const anchors = wrapper.findAll('[data-legal-toc] a').map((link) => link.attributes('href')!)
      expect(anchors.length).toBeGreaterThanOrEqual(4)
      for (const anchor of anchors) {
        expect(anchor).toMatch(/^#[a-z0-9-]+$/)
        expect(wrapper.find(anchor).exists(), `${path} ${anchor}`).toBe(true)
      }
      const hrefs = wrapper.findAll('a').map((link) => link.attributes('href'))
      for (const other of LEGAL_PAGES.filter((entry) => entry.path !== path)) expect(hrefs).toContain(other.path)
    }
  )
})

describe('legal pages: company data comes only from configuration', () => {
  it.each(PAGES)('%s shows visible pending markers outside production when data is missing', async (path, page) => {
    const wrapper = await mountSuspended(page)
    const text = wrapper.text()
    if (path === '/cookies') {
      expect(text).toContain('[pendiente: razón social]')
      return
    }
    expect(text).toContain('[pendiente: razón social]')
    expect(text).toContain('[pendiente: NIF]')
    expect(text).toContain('[pendiente: domicilio]')
  })

  it.each(PAGES)('%s never shows markers or invented identity data in production', async (_path, page) => {
    config.appEnv = 'production'
    const text = (await mountSuspended(page)).text()
    expect(text).not.toContain('[pendiente')
    // No tax id, postal code or personal/company name typed by hand.
    expect(text).not.toMatch(/\b[0-9XYZ]\d{7}[A-Z]\b|\b[A-HJ-NP-SUVW]\d{7}[0-9A-J]\b/)
    expect(text).not.toMatch(/\b46\d{3}\b/)
    expect(text).not.toMatch(/Gonz[aá]lez|Nacher|\bS\.L\.|\bS\.A\./)
    expect(text).not.toMatch(/Tomo \d|Folio \d|Hoja [A-Z]-?\d/i)
  })

  it.each(PAGES)('%s prints the configured values and no markers once they are set', async (path, page) => {
    config.commercial = { ...PROVISIONAL }
    const text = (await mountSuspended(page)).text()
    expect(text).not.toContain('[pendiente')
    expect(text).toContain(PROVISIONAL.companyLegalName)
    if (path === '/cookies') return
    expect(text).toContain(PROVISIONAL.companyTaxId)
    expect(text).toContain(PROVISIONAL.companyAddress)
  })

  it.each(['aviso-legal', 'privacidad', 'cookies', 'condiciones-generales'])(
    'app/pages/%s.vue types no company data by hand',
    (name) => {
      const source = readFileSync(`app/pages/${name}.vue`, 'utf8')
      expect(source).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i)
      expect(source).not.toMatch(/\+34|\b[6-9]\d{2} ?\d{3} ?\d{3}\b/)
      expect(source).not.toMatch(/\b[0-9XYZ]\d{7}[A-Z]\b|\b[A-HJ-NP-SUVW]\d{7}[0-9A-J]\b/)
      expect(source).not.toMatch(/Gonz[aá]lez|Nacher/)
    }
  )
})

describe('privacy policy content', () => {
  it('names purposes, legal bases, retention, recipients, rights and the AEPD', async () => {
    const text = (await mountSuspended(PrivacyPage)).text().toLowerCase()
    for (const fragment of [
      'Ejecución del contrato',
      'Obligación legal',
      'Consentimiento',
      'Interés legítimo',
      'pasarela de pago',
      'facturación',
      'transporte',
      'correo electrónico',
      'chat',
      'Agencia Española de Protección de Datos',
      'portabilidad',
      'oposición'
    ])
      expect(text).toContain(fragment.toLowerCase())
    const links = (await mountSuspended(PrivacyPage)).findAll('a').map((link) => link.attributes('href'))
    expect(links).toContain('https://www.aepd.es')
  })

  it('uses the data protection address for rights only when configured, otherwise the shop email', async () => {
    config.commercial = { contactEmail: 'tienda-pruebas@example.com' }
    let text = (await mountSuspended(PrivacyPage)).text()
    expect(text).toContain('tienda-pruebas@example.com')
    expect(text).not.toMatch(/delegado de protección de datos:/i)
    config.commercial = { contactEmail: 'tienda-pruebas@example.com', dpoEmail: 'dpd-pruebas@example.com' }
    text = (await mountSuspended(PrivacyPage)).text()
    expect(text).toContain('dpd-pruebas@example.com')
  })
})

describe('cookies policy content', () => {
  it('lists exactly the cookies the consent manager governs, by category', async () => {
    const wrapper = await mountSuspended(CookiesPage)
    const text = wrapper.text()
    for (const name of [
      'neteco-session',
      'neteco-cart',
      'neteco-order-access',
      'neteco-consent-v1',
      'neteco-analytics-id'
    ])
      expect(text).toContain(name)
    for (const category of ['Necesarias', 'Medición', 'Marketing']) expect(text).toContain(category)
    expect(text).toContain('180 días')
  })

  it('reopens the consent manager from the page', async () => {
    const wrapper = await mountSuspended(CookiesPage)
    const listener = vi.fn()
    window.addEventListener('neteco-open-consent', listener)
    await wrapper.get('[data-open-consent]').trigger('click')
    window.removeEventListener('neteco-open-consent', listener)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('mentions the external chat provider only when one is configured', async () => {
    expect((await mountSuspended(CookiesPage)).text()).not.toContain('chat.example.com')
    config.commercial = { chatWidgetSrc: 'https://chat.example.com/widget.js' }
    expect((await mountSuspended(CookiesPage)).text()).toContain('chat.example.com')
  })
})

describe('general terms of sale content', () => {
  it('covers withdrawal with the model form, hygiene exceptions, conformity, B2B and disputes', async () => {
    const wrapper = await mountSuspended(SalesTermsPage)
    const text = wrapper.text()
    for (const fragment of [
      '14 días naturales',
      'Formulario de desistimiento',
      'Por la presente le comunico/comunicamos',
      'Táchese lo que no proceda',
      'precintados',
      'tres años',
      'Clientes profesionales',
      'Código de Comercio',
      'IVA',
      'Ley aplicable'
    ])
      expect(text).toContain(fragment)
    for (const id of ['desistimiento', 'formulario-desistimiento', 'garantia', 'profesionales', 'litigios'])
      expect(wrapper.find(`#${id}`).exists()).toBe(true)
  })

  it('states shipping, payment and deferred payment figures only from configuration', async () => {
    let text = (await mountSuspended(SalesTermsPage)).text()
    expect(text).not.toMatch(/pago a \d+ días/)
    config.commercial = { deferredPaymentDays: 30, parcelLeadTime: '24-48 h', ownDeliveryDays: 'martes y jueves' }
    text = (await mountSuspended(SalesTermsPage)).text()
    expect(text).toContain('pago a 30 días')
    expect(text).toContain('24-48 h')
    expect(text).toContain('martes y jueves')
  })
})

describe('returns page integrates the withdrawal terms', () => {
  it('links to the withdrawal section and states the 14 day period for consumers', async () => {
    const wrapper = await mountSuspended(ReturnsPage)
    const hrefs = wrapper.findAll('a').map((link) => link.attributes('href'))
    expect(hrefs).toContain('/condiciones-generales#desistimiento')
    expect(hrefs).toContain('/condiciones-generales#formulario-desistimiento')
    expect(wrapper.text()).toContain('14 días naturales')
  })
})
