import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COMMERCIAL_TERM_KEYS,
  commercialPromises,
  deferredPaymentPromise,
  ownDeliveryPromise,
  parcelPromise,
  contactAction,
  contactPhones,
  parseCommercialTerms,
  primaryContactPhone
} from '../../shared/commercial-terms'

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(vue|ts)$/.test(path) ? [path] : []
  })
}

describe('commercial terms: a single configurable source', () => {
  it('starts empty: no business figure is invented by default', () => {
    const terms = parseCommercialTerms({})
    expect(terms).toEqual({
      ownDeliveryDays: '',
      orderCutoffTime: '',
      ownDeliveryCostCents: null,
      ownDeliveryFreeFromCents: null,
      ownDeliveryMinimumOrderCents: null,
      parcelLeadTime: '',
      parcelCostCents: null,
      parcelFreeFromCents: null,
      deferredPaymentDays: null,
      deferredPaymentConditions: '',
      supportHours: '',
      whatsappNumber: '',
      foundedYear: null,
      ecoRangeBrand: '',
      companyTaxId: '',
      companyAddress: '',
      certificationsPublished: false,
      contactEmail: 'tienda@neteco.es',
      contactPhone: '',
      supportPhoneAi: ''
    })
    expect(Object.keys(terms).sort()).toEqual([...COMMERCIAL_TERM_KEYS].sort())
  })

  it('accepts only well-formed values and drops the rest instead of guessing', () => {
    const terms = parseCommercialTerms({
      ownDeliveryDays: '  martes y jueves ',
      orderCutoffTime: '25:99',
      ownDeliveryCostCents: '0',
      ownDeliveryFreeFromCents: '-5',
      parcelLeadTime: '24-48 h',
      parcelFreeFromCents: 15000,
      deferredPaymentDays: '30',
      foundedYear: '1800',
      whatsappNumber: '600 861 334',
      certificationsPublished: 'true'
    })
    expect(terms.ownDeliveryDays).toBe('martes y jueves')
    expect(terms.orderCutoffTime).toBe('')
    expect(terms.ownDeliveryCostCents).toBe(0)
    expect(terms.ownDeliveryFreeFromCents).toBeNull()
    expect(terms.parcelLeadTime).toBe('24-48 h')
    expect(terms.parcelFreeFromCents).toBe(15000)
    expect(terms.deferredPaymentDays).toBe(30)
    expect(terms.foundedYear).toBeNull()
    expect(terms.whatsappNumber).toBe('600861334')
    expect(terms.certificationsPublished).toBe(true)
  })

  it('an empty string never becomes a zero amount', () => {
    const terms = parseCommercialTerms({ ownDeliveryCostCents: '', parcelCostCents: '  ', parcelFreeFromCents: 0 })
    expect(terms.ownDeliveryCostCents).toBeNull()
    expect(terms.parcelCostCents).toBeNull()
    // A zero threshold means "not configured", as FREE_SHIPPING_THRESHOLD_CENTS does.
    expect(terms.parcelFreeFromCents).toBeNull()
  })
})

describe('commercial promises: concrete only when configured', () => {
  it('without data the own-delivery promise states only the fact', () => {
    const promise = ownDeliveryPromise(parseCommercialTerms({}))
    expect(promise.text).toBe("En Ontinyent y la Vall d'Albaida te lo llevamos nosotros.")
    expect(promise.concrete).toBe(false)
  })

  it('with route days, cut-off and cost it states them', () => {
    const promise = ownDeliveryPromise(
      parseCommercialTerms({
        ownDeliveryDays: 'martes y jueves',
        orderCutoffTime: '13:00',
        ownDeliveryCostCents: 0
      })
    )
    expect(promise.text).toBe(
      "Reparto propio en Ontinyent y la Vall d'Albaida: martes y jueves. Pide antes de las 13:00. Sin coste de reparto."
    )
    expect(promise.concrete).toBe(true)
  })

  it('states a paid delivery, its free threshold and its minimum order', () => {
    const promise = ownDeliveryPromise(
      parseCommercialTerms({
        ownDeliveryCostCents: 350,
        ownDeliveryFreeFromCents: 6000,
        ownDeliveryMinimumOrderCents: 3000
      })
    )
    expect(promise.text).toBe(
      "En Ontinyent y la Vall d'Albaida te lo llevamos nosotros. Reparto: 3,50 €, gratis desde 60 €. Pedido mínimo: 30 €."
    )
  })

  it('omits the parcel promise entirely when nothing is known', () => {
    expect(parcelPromise(parseCommercialTerms({}))).toBeNull()
    expect(parcelPromise(parseCommercialTerms({ parcelLeadTime: '24-48 h', parcelFreeFromCents: 15000 }))?.text).toBe(
      'Resto de península en 24-48 h. Gratis desde 150 € en paquetería estándar.'
    )
    expect(parcelPromise(parseCommercialTerms({ parcelFreeFromCents: 15000 }))?.text).toBe(
      'Envío por agencia al resto de península. Gratis desde 150 € en paquetería estándar.'
    )
  })

  it('mentions deferred payment only with a real term', () => {
    expect(deferredPaymentPromise(parseCommercialTerms({}))).toBeNull()
    expect(deferredPaymentPromise(parseCommercialTerms({ deferredPaymentDays: 30 }))).toBe(
      'Empresas con cuenta aprobada: pago a 30 días.'
    )
  })

  it('the home strip shows three or four items, never an orphan fifth', () => {
    const empty = commercialPromises(parseCommercialTerms({}), { bankTransfer: false })
    expect(empty.map((item) => item.key)).toEqual(['own-delivery', 'support', 'payment'])
    expect(empty.find((item) => item.key === 'support')?.text).toBe('Escríbenos a tienda@neteco.es.')
    expect(empty.find((item) => item.key === 'payment')?.text).toBe('Tarjeta o Bizum.')

    const full = commercialPromises(
      parseCommercialTerms({
        parcelFreeFromCents: 15000,
        supportHours: 'de lunes a viernes de 9:00 a 18:00',
        deferredPaymentDays: 30,
        contactPhone: '600 861 334'
      }),
      { bankTransfer: true }
    )
    expect(full.map((item) => item.key)).toEqual(['own-delivery', 'parcel', 'support', 'payment'])
    expect(full.find((item) => item.key === 'support')?.text).toBe(
      'Te atiende una persona: 600 861 334, de lunes a viernes de 9:00 a 18:00.'
    )
    expect(full.find((item) => item.key === 'payment')?.text).toBe(
      'Tarjeta, Bizum o transferencia. Empresas con cuenta aprobada: pago a 30 días.'
    )
  })
})

describe('contact channels: one configurable email and phones', () => {
  it('uses tienda@neteco.es unless a valid address is configured', () => {
    expect(parseCommercialTerms({}).contactEmail).toBe('tienda@neteco.es')
    expect(parseCommercialTerms({ contactEmail: 'no es un correo' }).contactEmail).toBe('tienda@neteco.es')
    expect(parseCommercialTerms({ contactEmail: ' pedidos@neteco.es ' }).contactEmail).toBe('pedidos@neteco.es')
  })

  it('shows no phone when none is configured, and a tel: link for each configured one', () => {
    expect(contactPhones(parseCommercialTerms({}))).toEqual([])
    expect(primaryContactPhone(parseCommercialTerms({}))).toBeNull()
    expect(parseCommercialTerms({ contactPhone: 'llámanos' }).contactPhone).toBe('')
    const terms = parseCommercialTerms({ contactPhone: '600 861 334', supportPhoneAi: '+34 960 000 000' })
    expect(contactPhones(terms)).toEqual([
      { kind: 'contact', display: '600 861 334', href: 'tel:600861334' },
      { kind: 'ai', display: '+34 960 000 000', href: 'tel:+34960000000' }
    ])
    expect(primaryContactPhone(parseCommercialTerms({ supportPhoneAi: '960 000 000' }))?.href).toBe('tel:960000000')
  })

  it('says how to reach the shop with whatever channel exists', () => {
    expect(contactAction(parseCommercialTerms({}))).toBe('escríbenos a tienda@neteco.es')
    expect(contactAction(parseCommercialTerms({ contactPhone: '600 861 334' }))).toBe('llámanos al 600 861 334')
  })

  it('only promises a person on the phone for the contact number, not for the AI line', () => {
    const ai = commercialPromises(parseCommercialTerms({ supportPhoneAi: '960 000 000' }), { bankTransfer: false })
    expect(ai.find((item) => item.key === 'support')?.text).toBe(
      'Llámanos al 960 000 000 o escríbenos a tienda@neteco.es.'
    )
  })

  it('no contact literal is scattered through app/: everything comes from the configuration', () => {
    const offenders = sources('app').filter((file) =>
      /administracion@neteco\.es|tienda@neteco\.es|600 ?861 ?334|600861334|637 ?442 ?546|637442546/.test(
        readFileSync(file, 'utf8')
      )
    )
    expect(offenders).toEqual([])
  })
})

describe('shop copy without non-committal promises', () => {
  const FORBIDDEN = [
    'dependen de la cotización',
    'cuando el destino y la ruta estén habilitados',
    'Consulta los canales',
    'ujeto a cotización',
    'Se calcula al tramitar',
    'catálogo de demostración'
  ]
  it.each(FORBIDDEN)('app/ never says "%s"', (phrase) => {
    expect(sources('app').filter((file) => readFileSync(file, 'utf8').includes(phrase))).toEqual([])
  })
})
