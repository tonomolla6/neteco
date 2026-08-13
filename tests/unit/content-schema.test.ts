import { beforeEach, describe, expect, it } from 'vitest'
import { contentDocumentSchema } from '../../server/utils/content-schema'
import { deterministicTestData, type DeterministicTestData } from '../fixtures/deterministic'

let testData: DeterministicTestData

beforeEach((context) => {
  testData = deterministicTestData(`unit:content-schema:${context.task.id}:${context.task.name}`)
})

const base = {
  title: 'Página de prueba',
  slug: 'pagina-de-prueba',
  seo: { title: 'Página de prueba', description: 'Descripción editorial suficientemente útil.', noindex: false },
  changeSummary: 'Versión inicial aprobada para revisión'
}

describe('typed content schema', () => {
  it('accepts every supported block without an arbitrary HTML primitive', () => {
    const blocks = [
      { id: testData.uuid(), type: 'heading', level: 'h2', text: 'Encabezado' },
      { id: testData.uuid(), type: 'paragraph', text: '<script>se muestra como texto, nunca como HTML</script>' },
      { id: testData.uuid(), type: 'list', items: ['Uno', 'Dos'] },
      { id: testData.uuid(), type: 'image', assetId: testData.uuid(), alt: 'Descripción', caption: '' },
      {
        id: testData.uuid(),
        type: 'callout',
        tone: 'warning',
        title: 'Aviso',
        text: 'Contenido del aviso'
      },
      { id: testData.uuid(), type: 'cta', label: 'Continuar', href: '/catalogo' }
    ]
    expect(contentDocumentSchema.parse({ ...base, blocks }).blocks).toHaveLength(6)
  })

  it('rejects unknown fields, unsafe links and unbounded documents', () => {
    expect(() =>
      contentDocumentSchema.parse({
        ...base,
        blocks: [{ id: testData.uuid(), type: 'cta', label: 'Malicioso', href: 'javascript:alert(1)' }]
      })
    ).toThrow()
    expect(() =>
      contentDocumentSchema.parse({
        ...base,
        blocks: [{ id: testData.uuid(), type: 'paragraph', text: 'Texto válido', html: '<b>no</b>' }]
      })
    ).toThrow()
    expect(() =>
      contentDocumentSchema.parse({
        ...base,
        blocks: Array.from({ length: 81 }, () => ({
          id: testData.uuid(),
          type: 'paragraph',
          text: 'Texto válido'
        }))
      })
    ).toThrow()
  })
})
