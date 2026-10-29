import { describe, expect, it } from 'vitest'
import {
  LEAD_FORM_DEFAULTS,
  LEAD_MAGNETS,
  LEAD_MAGNET_CONSENT_VERSION,
  dilutionPlan,
  findLeadMagnet,
  leadRequestSchema,
  normalizeLeadEmail,
  renderLeadMagnetEmail
} from '../../shared/lead-magnets'

describe('MKT-029 catalogue gives real value without any form', () => {
  it('offers a checklist, a calculator and a guide', () => {
    expect(new Set(LEAD_MAGNETS.map((m) => m.kind))).toEqual(new Set(['checklist', 'calculator', 'guide']))
  })
  it('never gates the content: it is public and the form only requests an e-mailed copy', () => {
    for (const magnet of LEAD_MAGNETS) {
      expect(magnet.gated).toBe(false)
      expect(magnet.slug).toMatch(/^[a-z0-9-]+$/)
      expect(magnet.title.length).toBeGreaterThan(10)
    }
  })
  it('has unique slugs and finds them by slug only', () => {
    expect(new Set(LEAD_MAGNETS.map((m) => m.slug)).size).toBe(LEAD_MAGNETS.length)
    expect(findLeadMagnet(LEAD_MAGNETS[0]!.slug)).toBe(LEAD_MAGNETS[0])
    expect(findLeadMagnet('nope')).toBeNull()
    expect(findLeadMagnet('__proto__')).toBeNull()
  })
  it('checklist items are actionable and each explains why it matters', () => {
    const checklist = LEAD_MAGNETS.find((m) => m.kind === 'checklist')!
    if (checklist.kind !== 'checklist') throw new Error('unreachable')
    expect(checklist.items.length).toBeGreaterThanOrEqual(8)
    expect(new Set(checklist.items.map((i) => i.id)).size).toBe(checklist.items.length)
    for (const item of checklist.items) {
      expect(item.action.length).toBeGreaterThan(15)
      expect(item.why.length).toBeGreaterThan(15)
    }
    expect(checklist.items.some((i) => /ficha de datos de seguridad/i.test(i.action))).toBe(true)
  })
  it('guide has several sections with a safety reminder and no price claims', () => {
    const guide = LEAD_MAGNETS.find((m) => m.kind === 'guide')!
    if (guide.kind !== 'guide') throw new Error('unreachable')
    expect(guide.sections.length).toBeGreaterThanOrEqual(4)
    const text = JSON.stringify(guide.sections)
    expect(text).toMatch(/etiqueta|ficha técnica/i)
    expect(text).not.toMatch(/€|oferta|descuento/i)
  })
  it('the calculator declares its inputs and the calculation reference', () => {
    const calc = LEAD_MAGNETS.find((m) => m.kind === 'calculator')!
    expect(calc.slug).toBe('calculadora-dilucion')
  })
})

describe('MKT-029 dilution calculator', () => {
  it('computes a 1:20 ratio (1 part product + 20 parts water) for 5 L', () => {
    const r = dilutionPlan({ mode: 'ratio', waterParts: 20, finalVolumeMl: 5000 })
    expect(r.productMl).toBe(238.1)
    expect(r.waterMl).toBe(4761.9)
    expect(r.productMl + r.waterMl).toBeCloseTo(5000, 1)
  })
  it('computes a percentage v/v', () => {
    const r = dilutionPlan({ mode: 'percent', percent: 2.5, finalVolumeMl: 10000 })
    expect(r.productMl).toBe(250)
    expect(r.waterMl).toBe(9750)
  })
  it('accepts 100 % (no water) and the minimum 0.1 %', () => {
    expect(dilutionPlan({ mode: 'percent', percent: 100, finalVolumeMl: 1000 }).waterMl).toBe(0)
    expect(dilutionPlan({ mode: 'percent', percent: 0.1, finalVolumeMl: 1000 }).productMl).toBe(1)
  })
  it('computes cost per batch and per litre from the concentrate price', () => {
    const r = dilutionPlan({ mode: 'percent', percent: 5, finalVolumeMl: 10000, productPricePerLiterCents: 800 })
    expect(r.productCostCents).toBe(400)
    expect(r.costPerLiterCents).toBe(40)
  })
  it('omits cost when no price is given', () => {
    expect(dilutionPlan({ mode: 'percent', percent: 5, finalVolumeMl: 1000 }).productCostCents).toBeNull()
  })
  it('flags the always-follow-the-label reminder', () => {
    expect(dilutionPlan({ mode: 'percent', percent: 5, finalVolumeMl: 1000 }).notice).toMatch(/etiqueta/i)
  })
  it.each([
    ['zero volume', { mode: 'percent', percent: 5, finalVolumeMl: 0 }],
    ['excessive volume', { mode: 'percent', percent: 5, finalVolumeMl: 1_000_001 }],
    ['percent above 100', { mode: 'percent', percent: 101, finalVolumeMl: 1000 }],
    ['percent below 0.1', { mode: 'percent', percent: 0.05, finalVolumeMl: 1000 }],
    ['NaN percent', { mode: 'percent', percent: Number.NaN, finalVolumeMl: 1000 }],
    ['zero water parts', { mode: 'ratio', waterParts: 0, finalVolumeMl: 1000 }],
    ['absurd ratio', { mode: 'ratio', waterParts: 1001, finalVolumeMl: 1000 }],
    ['negative price', { mode: 'percent', percent: 5, finalVolumeMl: 1000, productPricePerLiterCents: -1 }],
    ['unknown mode', { mode: 'magic', finalVolumeMl: 1000 }]
  ])('rejects %s', (_l, input) => {
    expect(() => dilutionPlan(input as never)).toThrow('invalid_dilution_input')
  })
})

describe('MKT-029 minimal form and non-conditioned consent', () => {
  it('requires only an e-mail; consent defaults to unchecked', () => {
    expect(LEAD_FORM_DEFAULTS).toEqual({ marketingConsent: false })
    const parsed = leadRequestSchema.parse({ magnetSlug: 'calculadora-dilucion', email: ' Ana@Example.COM ' })
    expect(parsed.marketingConsent).toBe(false)
    expect(parsed.email).toBe('ana@example.com')
  })
  it('accepts a refusal of marketing consent', () => {
    expect(
      leadRequestSchema.safeParse({ magnetSlug: 'calculadora-dilucion', email: 'a@b.es', marketingConsent: false })
        .success
    ).toBe(true)
  })
  it('does not accept extra personal fields (data minimisation)', () => {
    for (const extra of [{ name: 'Ana' }, { phone: '600' }, { company: 'X' }, { nif: 'B123' }]) {
      expect(
        leadRequestSchema.safeParse({ magnetSlug: 'calculadora-dilucion', email: 'a@b.es', ...extra }).success
      ).toBe(false)
    }
  })
  it('rejects malformed e-mails', () => {
    for (const bad of [
      '',
      'a',
      'a@b',
      'a@@b.es',
      'a b@c.es',
      'a..b@c.es',
      `${'x'.repeat(250)}@b.es`,
      'a@b.es\nbcc:x@y.es'
    ]) {
      expect(normalizeLeadEmail(bad)).toBeNull()
    }
  })
  it('rejects a non-boolean consent value', () => {
    expect(
      leadRequestSchema.safeParse({ magnetSlug: 'calculadora-dilucion', email: 'a@b.es', marketingConsent: 'yes' })
        .success
    ).toBe(false)
  })
  it('exposes a consent text version for evidence', () => {
    expect(LEAD_MAGNET_CONSENT_VERSION).toMatch(/^lead-magnet-\d{4}-\d{2}$/)
  })
})

describe('MKT-029 e-mailed copy', () => {
  it('renders every magnet as plain text with the requested resource and the reason for the e-mail', () => {
    for (const magnet of LEAD_MAGNETS) {
      const mail = renderLeadMagnetEmail(magnet, 'https://shop.neteco.test')
      expect(mail.subject).toContain(magnet.title)
      expect(mail.text).toMatch(/lo solicitaste/i)
      expect(mail.text.length).toBeGreaterThan(200)
    }
  })
  it('includes checklist actions, guide sections and the calculator link', () => {
    const checklist = renderLeadMagnetEmail(
      LEAD_MAGNETS.find((m) => m.kind === 'checklist')!,
      'https://shop.neteco.test'
    )
    expect(checklist.text).toMatch(/ficha de datos de seguridad/i)
    const guide = renderLeadMagnetEmail(
      LEAD_MAGNETS.find((m) => m.kind === 'guide')!,
      'https://shop.neteco.test'
    )
    expect(guide.text).toMatch(/Orden correcto de trabajo/)
    const calc = renderLeadMagnetEmail(
      LEAD_MAGNETS.find((m) => m.kind === 'calculator')!,
      'https://shop.neteco.test'
    )
    expect(calc.text).toContain('https://shop.neteco.test/herramientas/calculadora-dilucion')
  })
  it('contains no promotional content or tracking, whatever the consent', () => {
    for (const magnet of LEAD_MAGNETS) {
      const mail = renderLeadMagnetEmail(magnet, 'https://shop.neteco.test')
      expect(mail.text).not.toMatch(/descuento|oferta|utm_|suscr[ií]be/i)
    }
  })
})
