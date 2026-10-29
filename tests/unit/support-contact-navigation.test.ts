import { describe, expect, it } from 'vitest'
import { supportContactDocumentTarget } from '../../shared/support-navigation'

describe('contact document navigation preserves challenge CSP', () => {
  it.each(['/catalogo', '/producto/example', '/cuenta/pedidos', '/'])(
    'requires new native document from %s',
    (path) => {
      expect(
        supportContactDocumentTarget('cloudflare', path, {
          path: '/contacto',
          fullPath: '/contacto?pedido=PUBLIC-REF#consulta'
        })
      ).toBe('/contacto?pedido=PUBLIC-REF#consulta')
    }
  )
  it.each(['/contacto', '/contacto/', '/%63ontacto', '/CONTACTO', '/CoNtAcTo/'])(
    'does not loop on an existing contact document %s',
    (path) => {
      expect(
        supportContactDocumentTarget('cloudflare', path, {
          path: '/contacto',
          fullPath: '/contacto?producto=synthetic'
        })
      ).toBeNull()
    }
  )
  it('canonicalizes the document route but preserves the exact query and fragment', () => {
    expect(
      supportContactDocumentTarget('cloudflare', '/catalogo', {
        path: '/CONTACTO/',
        fullPath: '/CONTACTO/?producto=x%2Fy#Consulta'
      })
    ).toBe('/contacto?producto=x%2Fy#Consulta')
  })
  it.each(['node', undefined, 'unknown'])('keeps foreign runtime %s unchanged', (runtime) => {
    expect(supportContactDocumentTarget(runtime, '/', { path: '/contacto', fullPath: '/contacto' })).toBeNull()
  })
  it.each(['https://attacker.invalid/contacto', '//attacker.invalid/contacto', '/contacto-elsewhere', '/api/support'])(
    'never turns %s into an external target',
    (fullPath) => {
      expect(supportContactDocumentTarget('cloudflare', '/', { path: '/contacto', fullPath })).toBeNull()
    }
  )
})
