import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminPreviewVisualComparison from '../../app/components/AdminPreviewVisualComparison.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

describe('AdminPreviewVisualComparison.vue (ADM-024)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.request.mockResolvedValue({
      pageId: '40000000-0000-4000-8000-000000000001',
      baseVersion: 1,
      compareVersion: 2,
      diff: {
        hasChanges: true,
        metadataDiff: {
          titleChanged: true,
          oldTitle: 'Desengrasante Eco v1',
          newTitle: 'Desengrasante Eco v2 ULTRA',
          slugChanged: false,
          seoChanged: true,
          noindexChanged: false
        },
        summary: {
          addedBlocksCount: 1,
          modifiedBlocksCount: 2,
          removedBlocksCount: 0,
          unchangedBlocksCount: 1
        },
        blockDiffs: [
          {
            id: 'b1',
            changeType: 'modified',
            oldBlock: { id: 'b1', type: 'heading', text: 'Old Heading' },
            newBlock: { id: 'b1', type: 'heading', text: 'New Heading' },
            fieldDifferences: ['text']
          },
          {
            id: 'b2',
            changeType: 'added',
            newBlock: { id: 'b2', type: 'callout', text: 'Certificación Ecolabel' }
          }
        ]
      },
      baseDocument: { title: 'Desengrasante Eco v1', blocks: [] },
      compareDocument: {
        title: 'Desengrasante Eco v2 ULTRA',
        blocks: [
          { id: 'b1', type: 'heading', text: 'New Heading' },
          { id: 'b2', type: 'callout', text: 'Certificación Ecolabel' }
        ]
      }
    })
  })

  it('renders preview comparison with responsive breakpoints and diff summary', async () => {
    const wrapper = await mountSuspended(AdminPreviewVisualComparison, {
      props: {
        pageId: '40000000-0000-4000-8000-000000000001',
        initialBaseVersion: 1,
        initialCompareVersion: 2
      }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Comparación Visual de Preview')
    expect(wrapper.text()).toContain('Desengrasante Eco v2 ULTRA')
    expect(wrapper.text()).toContain('Bloques Añadidos')
    expect(wrapper.text()).toContain('+1')
    expect(wrapper.text()).toContain('~2')

    // Breakpoint buttons exist
    expect(wrapper.text()).toContain('Móvil (375px)')
    expect(wrapper.text()).toContain('Tablet (768px)')
    expect(wrapper.text()).toContain('Escritorio (1280px)')
  })

  it('switches to critical templates regression check tab and executes check', async () => {
    const wrapper = await mountSuspended(AdminPreviewVisualComparison)
    await flushPromises()

    const regressionTabBtn = wrapper.findAll('button').find((b) => b.text().includes('Regresión Visual de Plantillas'))
    expect(regressionTabBtn).toBeDefined()
    await regressionTabBtn?.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Regresión visual automatizada para plantillas críticas')

    // Mock regression check response
    mocks.request.mockResolvedValueOnce({
      passed: true,
      missingCriticalSelectors: []
    })

    const runBtn = wrapper.findAll('button').find((b) => b.text().includes('Ejecutar Comprobación'))
    await runBtn?.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Regresión Visual Aprobada')
  })
})
