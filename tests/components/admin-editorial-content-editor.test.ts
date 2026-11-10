import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminEditorialContentEditor from '../../app/components/AdminEditorialContentEditor.vue'
import '#app/nuxt-vitest-app-entry'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => fetchMock)
mockNuxtImport('$fetch', () => fetchMock)

const sampleArticle = {
  id: '30000000-0000-4000-8000-000000000201',
  targetType: 'product',
  targetId: 'prod-desengrasante-100',
  title: 'Protocolo de Limpieza y Desengrase Pesado en Cocinas Colectivas',
  summary: 'Manual técnico de aplicación profesional del desengrasante alcalino.',
  bodyMarkdown:
    'Protocolo de desengrase para campanas extractoras, freidoras industriales y filtros de cocina. Formulación con tensioactivos biodegradables y álcalis libres que emulsifican grasa polimerizada.',
  applicationScope: 'Hostelería, restauración colectiva y catering',
  surfaceCompatibility: {
    compatible: ['Acero inoxidable', 'Gres porcelánico'],
    incompatible: ['Aluminio']
  },
  dilutionDosageGuide: 'Uso directo sobre grasa carbonizada; dilución al 10% (1:10) para limpieza diaria.',
  safetyAndPpe: {
    requiredPpe: ['Guantes de nitrilo', 'Gafas de protección química'],
    hazardWarnings: ['Líquido corrosivo']
  },
  technicalStandards: ['UNE-EN 13697'],
  supplierReferenceText: 'Desengrasante para cocinas.',
  supplierSimilarityScore: 0.12,
  status: 'draft',
  authorIdentityId: '10000000-0000-4000-8000-000000000019',
  version: 1,
  createdAt: '2026-10-29T10:00:00Z',
  updatedAt: '2026-10-29T10:00:00Z'
}

describe('CAT-019: AdminEditorialContentEditor Component', () => {
  let wrappers: Array<{ unmount(): void }> = []

  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(sampleArticle)
  })

  afterEach(() => {
    wrappers.forEach((w) => w.unmount())
    wrappers = []
  })

  it('renders editor header, target ID, and quality anti-duplication badge', async () => {
    const wrapper = await mountSuspended(AdminEditorialContentEditor, {
      props: {
        targetType: 'product',
        targetId: 'prod-desengrasante-100'
      }
    })
    wrappers.push(wrapper)
    await flushPromises()

    expect(wrapper.text()).toContain('Contenido editorial propio (CAT-019)')
    expect(wrapper.text()).toContain('Control Anti-Duplicación y Calidad Profesional')
    expect(wrapper.text()).toContain('Coincidencia con proveedor')
  })

  it('loads existing article and populates input fields', async () => {
    const wrapper = await mountSuspended(AdminEditorialContentEditor, {
      props: {
        targetType: 'product',
        targetId: 'prod-desengrasante-100'
      }
    })
    wrappers.push(wrapper)
    await flushPromises()

    const titleInput = wrapper.find<HTMLInputElement>('input#editorial-title')
    expect(titleInput.element.value).toBe('Protocolo de Limpieza y Desengrase Pesado en Cocinas Colectivas')

    const scopeInput = wrapper.find<HTMLInputElement>('input#editorial-scope')
    expect(scopeInput.element.value).toBe('Hostelería, restauración colectiva y catering')
  })

  it('triggers save action and displays success notification', async () => {
    const wrapper = await mountSuspended(AdminEditorialContentEditor, {
      props: {
        targetType: 'product',
        targetId: 'prod-desengrasante-100'
      }
    })
    wrappers.push(wrapper)
    await flushPromises()

    fetchMock.mockResolvedValueOnce({
      ...sampleArticle,
      version: 2
    })

    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('Guardar Editorial'))
    expect(saveBtn).toBeDefined()
    await saveBtn?.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('guardado correctamente')
  })

  it('displays warning if supplier duplication is detected', async () => {
    const wrapper = await mountSuspended(AdminEditorialContentEditor, {
      props: {
        targetType: 'product',
        targetId: 'prod-new'
      }
    })
    wrappers.push(wrapper)
    await flushPromises()

    // Enter duplicated text in body and supplier text
    const supplierInput = wrapper.find<HTMLTextAreaElement>('textarea#supplier-ref-text')
    const bodyInput = wrapper.find<HTMLTextAreaElement>('textarea#editorial-body')

    await supplierInput.setValue('Detergente clorado espumante para suelos de matadero y salas de despiece.')
    await bodyInput.setValue('Detergente clorado espumante para suelos de matadero y salas de despiece.')
    await flushPromises()

    expect(wrapper.text()).toContain('duplica el texto del proveedor')
    expect(wrapper.text()).toContain('REQUIERE AJUSTES')
  })
})
