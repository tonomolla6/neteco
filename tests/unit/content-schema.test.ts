import { describe, expect, it } from 'vitest'
import { contentDocumentSchema } from '../../server/utils/content-schema'

const base = {
  title: 'Página de prueba',
  slug: 'pagina-de-prueba',
  seo: { title: 'Página de prueba', description: 'Descripción editorial suficientemente útil.', noindex: false },
  changeSummary: 'Versión inicial aprobada para revisión'
}

describe('typed content schema', () => {
  it('accepts every supported block without an arbitrary HTML primitive', () => {
    const blocks = [
      { id: crypto.randomUUID(), type: 'heading', level: 'h2', text: 'Encabezado' },
      { id: crypto.randomUUID(), type: 'paragraph', text: '<script>se muestra como texto, nunca como HTML</script>' },
      { id: crypto.randomUUID(), type: 'list', items: ['Uno', 'Dos'] },
      { id: crypto.randomUUID(), type: 'image', assetId: crypto.randomUUID(), alt: 'Descripción', caption: '' },
      {
        id: crypto.randomUUID(),
        type: 'callout',
        tone: 'warning',
        title: 'Aviso',
        text: 'Contenido del aviso'
      },
      { id: crypto.randomUUID(), type: 'cta', label: 'Continuar', href: '/catalogo' }
    ]
    expect(contentDocumentSchema.parse({ ...base, blocks }).blocks).toHaveLength(6)
  })

  it('rejects unknown fields, unsafe links and unbounded documents', () => {
    expect(() =>
      contentDocumentSchema.parse({
        ...base,
        blocks: [{ id: crypto.randomUUID(), type: 'cta', label: 'Malicioso', href: 'javascript:alert(1)' }]
      })
    ).toThrow()
    expect(() =>
      contentDocumentSchema.parse({
        ...base,
        blocks: [{ id: crypto.randomUUID(), type: 'paragraph', text: 'Texto válido', html: '<b>no</b>' }]
      })
    ).toThrow()
    expect(() =>
      contentDocumentSchema.parse({
        ...base,
        blocks: Array.from({ length: 81 }, () => ({
          id: crypto.randomUUID(),
          type: 'paragraph',
          text: 'Texto válido'
        }))
      })
    ).toThrow()
  })
})
