import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import ProductCompareTable from '../../app/components/ProductCompareTable.vue'
import ProductCard from '../../app/components/ProductCard.vue'
import type { ProductCompareResponse } from '../../workers/catalog/product-compare'
import type { ProductCardData } from '../../shared/types/catalog'
import '#app/nuxt-vitest-app-entry'

const { runtimeMock } = vi.hoisted(() => ({
  runtimeMock: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { priceDisplayMode: 'gross-only', appEnv: 'test' }
  }))
}))
mockNuxtImport('useRuntimeConfig', () => runtimeMock)

const sampleComparisonFixture: ProductCompareResponse = {
  products: [
    {
      id: 1,
      uuid: 'uuid-prod-1',
      name: 'Desengrasante Industrial Super',
      slug: 'desengrasante-industrial-super',
      brand: 'NETECO',
      image: '/media/img-1/image',
      imageAlt: 'Desengrasante Industrial 5L',
      minPrice: 1550,
      minNetPrice: 1281,
      formats: ['Garrafa 5L', 'Bidón 25L'],
      primaryFormat: 'Garrafa 5L',
      availability: 'in_stock',
      stockTotal: 42,
      regulatory: {
        pictograms: ['GHS05', 'GHS07'],
        hazardStatements: ['H314 Provoca quemaduras graves', 'H318 Lesiones oculares'],
        signalWord: 'Peligro',
        ufi: 'UFI-1234-ABCD',
        requiresSds: true
      }
    },
    {
      id: 2,
      uuid: 'uuid-prod-2',
      name: 'Limpiador Multiusos Neutro',
      slug: 'limpiador-multiusos-neutro',
      brand: 'NETECO',
      image: null,
      imageAlt: null,
      minPrice: 850,
      minNetPrice: 702,
      formats: ['Botella 1L'],
      primaryFormat: 'Botella 1L',
      availability: 'backorder',
      stockTotal: 0,
      regulatory: {
        pictograms: [],
        hazardStatements: [],
        signalWord: null,
        ufi: null,
        requiresSds: false
      }
    }
  ],
  rows: [
    {
      definitionId: 'def-ph',
      code: 'ph',
      label: 'Nivel de pH',
      kind: 'number',
      group: 'technical',
      comparable: true,
      hasDifference: true,
      hasWinner: false,
      values: [
        {
          productSlug: 'desengrasante-industrial-super',
          present: true,
          rawValue: 13.0,
          displayValue: '13',
          canonicalQuantity: 13.0,
          canonicalUnit: null,
          isDifferent: true
        },
        {
          productSlug: 'limpiador-multiusos-neutro',
          present: true,
          rawValue: 7.0,
          displayValue: '7',
          canonicalQuantity: 7.0,
          canonicalUnit: null,
          isDifferent: true
        }
      ]
    },
    {
      definitionId: 'def-vol',
      code: 'capacidad_envase',
      label: 'Capacidad unitaria',
      kind: 'unit',
      group: 'technical',
      comparable: true,
      hasDifference: false,
      hasWinner: false,
      values: [
        {
          productSlug: 'desengrasante-industrial-super',
          present: true,
          rawValue: { quantity: 1000, unit: 'ml' },
          displayValue: '1000 Mililitros',
          canonicalQuantity: 1,
          canonicalUnit: 'l',
          isDifferent: false
        },
        {
          productSlug: 'limpiador-multiusos-neutro',
          present: true,
          rawValue: { quantity: 1, unit: 'l' },
          displayValue: '1 Litros',
          canonicalQuantity: 1,
          canonicalUnit: 'l',
          isDifferent: false
        }
      ]
    },
    {
      definitionId: 'def-incomp',
      code: 'rendimiento',
      label: 'Rendimiento o Cobertura',
      kind: 'unit',
      group: 'technical',
      comparable: false,
      hasDifference: false,
      hasWinner: false,
      values: [
        {
          productSlug: 'desengrasante-industrial-super',
          present: true,
          rawValue: { quantity: 50, unit: 'm2' },
          displayValue: '50 Metros cuadrados',
          canonicalQuantity: 50,
          canonicalUnit: 'm2',
          isDifferent: false
        },
        {
          productSlug: 'limpiador-multiusos-neutro',
          present: true,
          rawValue: { quantity: 10, unit: 'l' },
          displayValue: '10 Litros',
          canonicalQuantity: 10,
          canonicalUnit: 'l',
          isDifferent: false
        }
      ]
    },
    {
      definitionId: 'def-ausente',
      code: 'dilucion',
      label: 'Dilución recomendada',
      kind: 'text',
      group: 'technical',
      comparable: true,
      hasDifference: false,
      hasWinner: false,
      values: [
        {
          productSlug: 'desengrasante-industrial-super',
          present: true,
          rawValue: '1:10 en agua tibia',
          displayValue: '1:10 en agua tibia',
          canonicalQuantity: null,
          canonicalUnit: null,
          isDifferent: false
        },
        {
          productSlug: 'limpiador-multiusos-neutro',
          present: false,
          rawValue: null,
          displayValue: 'no indicado',
          canonicalQuantity: null,
          canonicalUnit: null,
          isDifferent: false
        }
      ]
    },
    {
      definitionId: 'reg-pictograms',
      code: 'clp_pictograms',
      label: 'Pictogramas CLP',
      kind: 'regulatory',
      group: 'regulatory',
      comparable: false,
      hasDifference: false,
      hasWinner: false,
      values: [
        {
          productSlug: 'desengrasante-industrial-super',
          present: true,
          rawValue: ['GHS05', 'GHS07'],
          displayValue: 'GHS05, GHS07',
          canonicalQuantity: null,
          canonicalUnit: null,
          isDifferent: false
        },
        {
          productSlug: 'limpiador-multiusos-neutro',
          present: false,
          rawValue: [],
          displayValue: 'no indicado',
          canonicalQuantity: null,
          canonicalUnit: null,
          isDifferent: false
        }
      ]
    },
    {
      definitionId: 'reg-hazard',
      code: 'hazard_statements',
      label: 'Indicaciones de peligro (frases H)',
      kind: 'regulatory',
      group: 'regulatory',
      comparable: false,
      hasDifference: false,
      hasWinner: false,
      values: [
        {
          productSlug: 'desengrasante-industrial-super',
          present: true,
          rawValue: ['H314 Provoca quemaduras graves', 'H318 Lesiones oculares'],
          displayValue: 'H314 Provoca quemaduras graves; H318 Lesiones oculares',
          canonicalQuantity: null,
          canonicalUnit: null,
          isDifferent: false
        },
        {
          productSlug: 'limpiador-multiusos-neutro',
          present: false,
          rawValue: [],
          displayValue: 'no indicado',
          canonicalQuantity: null,
          canonicalUnit: null,
          isDifferent: false
        }
      ]
    }
  ]
}

describe('ProductCompareTable Component', () => {
  it('renders an accessible table element with proper th scopes and horizontal scroll container', async () => {
    const wrapper = await mountSuspended(ProductCompareTable, {
      props: {
        comparison: sampleComparisonFixture
      }
    })

    // Container has overflow-x-auto for responsive scroll
    expect(wrapper.classes()).toContain('overflow-x-auto')

    // Has table element
    const table = wrapper.find('table')
    expect(table.exists()).toBe(true)
    expect(table.attributes('aria-label')).toBe('Tabla comparativa de productos')

    // Has column headers with scope="col"
    const colHeaders = wrapper.findAll('thead th[scope="col"]')
    expect(colHeaders.length).toBe(3) // 1 label column + 2 products

    // First column is sticky
    expect(colHeaders[0]!.classes()).toContain('sticky')
    expect(colHeaders[0]!.classes()).toContain('left-0')

    // Has row headers with scope="row"
    const rowHeaders = wrapper.findAll('tbody th[scope="row"]')
    expect(rowHeaders.length).toBe(sampleComparisonFixture.rows.length)
    expect(rowHeaders[0]!.classes()).toContain('sticky')
    expect(rowHeaders[0]!.classes()).toContain('left-0')
  })

  it('highlights differences with visual styling AND non-color indicators (WCAG accessibility)', async () => {
    const wrapper = await mountSuspended(ProductCompareTable, {
      props: {
        comparison: sampleComparisonFixture
      }
    })

    const text = wrapper.text()
    // Row header indicates difference with badge text
    expect(text).toContain('Diferencia')

    // Accessible hidden text for screen readers
    expect(wrapper.html()).toContain('Diferencia respecto a otros productos:')

    // Row without difference (capacidad_envase) does not have difference badge
    const rows = wrapper.findAll('tbody tr')
    const capRow = rows.find((r) => r.text().includes('Capacidad unitaria'))
    expect(capRow).toBeDefined()
    expect(capRow!.find('.bg-amber-100').exists()).toBe(false)
  })

  it('marks absent attributes as "no indicado" with proper accessible label and muted style', async () => {
    const wrapper = await mountSuspended(ProductCompareTable, {
      props: {
        comparison: sampleComparisonFixture
      }
    })

    const absentCells = wrapper.findAll('[aria-label="No indicado"]')
    expect(absentCells.length).toBeGreaterThan(0)
    for (const cell of absentCells) {
      expect(cell.text()).toBe('no indicado')
    }
  })

  it('displays incomparable unit values without difference highlight', async () => {
    const wrapper = await mountSuspended(ProductCompareTable, {
      props: {
        comparison: sampleComparisonFixture
      }
    })

    const rows = wrapper.findAll('tbody tr')
    const incompRow = rows.find((r) => r.text().includes('Rendimiento o Cobertura'))
    expect(incompRow).toBeDefined()
    // Has no difference badge
    expect(incompRow!.find('.bg-amber-100').exists()).toBe(false)
    expect(incompRow!.text()).toContain('50 Metros cuadrados')
    expect(incompRow!.text()).toContain('10 Litros')
  })

  it('displays regulatory information without declaring a winner or recommendation', async () => {
    const wrapper = await mountSuspended(ProductCompareTable, {
      props: {
        comparison: sampleComparisonFixture
      }
    })

    const html = wrapper.html()
    // CLP pictograms
    expect(html).toContain('GHS05')
    expect(html).toContain('GHS07')

    // H statements
    expect(html).toContain('H314 Provoca quemaduras graves')

    // Check that there is NO "ganador", "mejor", "recomendado"
    expect(html.toLowerCase()).not.toContain('ganador')
    expect(html.toLowerCase()).not.toContain('mejor producto')
    expect(html.toLowerCase()).not.toContain('recomendamos')
  })

  it('emits remove event when the remove button is clicked', async () => {
    const wrapper = await mountSuspended(ProductCompareTable, {
      props: {
        comparison: sampleComparisonFixture
      }
    })

    const removeButton = wrapper.find('button[aria-label="Quitar Desengrasante Industrial Super de la comparativa"]')
    expect(removeButton.exists()).toBe(true)
    await removeButton.trigger('click')

    expect(wrapper.emitted('remove')).toBeTruthy()
    expect(wrapper.emitted('remove')![0]).toEqual(['desengrasante-industrial-super'])
  })
})

describe('ProductCard Compare Button', () => {
  const cardData: ProductCardData = {
    id: 10,
    name: 'Detergente Alcalino Clorado',
    slug: 'detergente-alcalino-clorado',
    brand: 'NETECO',
    badges: [],
    minPrice: 1200,
    minNetPrice: 992,
    formats: 2,
    visual: { type: 'garrafa', color: '#334155' }
  }

  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('renders compare button with accessible attributes and updates localStorage on click', async () => {
    const wrapper = await mountSuspended(ProductCard, {
      props: {
        product: cardData
      }
    })

    const button = wrapper.find('button[aria-label="Comparar Detergente Alcalino Clorado"]')
    expect(button.exists()).toBe(true)
    expect(button.attributes('aria-pressed')).toBe('false')

    await button.trigger('click')

    const stored = JSON.parse(localStorage.getItem('neteco_compare_slugs') || '[]')
    expect(stored).toContain('detergente-alcalino-clorado')
    expect(button.attributes('aria-pressed')).toBe('true')
  })

  it('enforces maximum 4 products in localStorage', async () => {
    localStorage.setItem('neteco_compare_slugs', JSON.stringify(['p1', 'p2', 'p3', 'p4']))
    const wrapper = await mountSuspended(ProductCard, {
      props: {
        product: cardData
      }
    })

    const button = wrapper.find('button')
    await button.trigger('click')

    // Did not add 5th product
    const stored = JSON.parse(localStorage.getItem('neteco_compare_slugs') || '[]')
    expect(stored).toHaveLength(4)
    expect(stored).not.toContain('detergente-alcalino-clorado')
  })
})
