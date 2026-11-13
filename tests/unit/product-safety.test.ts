import { describe, expect, it } from 'vitest'
import { productSafety, statementList, type SafetyDocument } from '../../shared/product-safety'

const sds: SafetyDocument = { role: 'sds', url: '/media/synthetic/document', name: 'FDS', version: '2', language: 'es' }

describe('published product safety', () => {
  it.each([null, undefined, {}, { productType: 'menaje_no_peligroso', requiresSds: false }])(
    'never invents chemical hazards for household goods (%j)',
    (regulatory) => {
      expect(productSafety(regulatory)).toMatchObject({ chemical: false, hazardous: false, pictograms: [], sds: null })
    }
  )
  it('keeps a chemical without classification distinct from a hazardous product', () => {
    expect(productSafety({ requiresSds: true })).toMatchObject({ chemical: true, hazardous: false, sds: null })
    expect(productSafety({}, [sds])).toMatchObject({ chemical: true, hazardous: false, sds })
  })
  it('uses published classification, deduplicates and rejects invalid pictograms', () => {
    expect(
      productSafety({ signalWord: ' Peligro ', pictograms: ['GHS05', 'ghs07', 'GHS05', 'GHS99', null] })
    ).toMatchObject({ chemical: true, hazardous: true, signalWord: 'Peligro', pictograms: ['GHS05', 'GHS07'] })
  })
  it('accepts phrases as text or arrays without inventing statements', () => {
    expect(statementList('H314 Provoca quemaduras; H318 Lesiones oculares\nH314 Provoca quemaduras')).toEqual([
      'H314 Provoca quemaduras',
      'H318 Lesiones oculares'
    ])
    expect(statementList([' P280 Usar guantes ', null, 7, 'NONE', 'P280 Usar guantes'])).toEqual(['P280 Usar guantes'])
  })
  it('separates safety data sheets from other published documents', () => {
    const technical = { ...sds, role: 'datasheet' as const, name: 'Ficha técnica' }
    expect(productSafety({}, [technical, sds])).toMatchObject({ sds, otherDocuments: [technical] })
  })
})
