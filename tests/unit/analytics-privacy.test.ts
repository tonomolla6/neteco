import { describe, expect, it } from 'vitest'
import { isCmsPreviewRoute, isPrivateAnalyticsRoute } from '../../shared/analytics-privacy'
describe('preview analytics privacy', () => {
  it.each(['sealed-read-only-bearer', '', null, undefined, ['one', 'two']])(
    'excludes any own preview parameter %#',
    (preview) => expect(isCmsPreviewRoute('/contenido/example', { preview })).toBe(true)
  )
  it.each(['/catalogo', '/contenido-example', '/producto/cleaner'])(
    'does not disable unrelated commerce route %s',
    (path) => expect(isCmsPreviewRoute(path, { preview: 'value' })).toBe(false)
  )
  it('keeps a published page trackable and never reads a bearer accessor', () => {
    expect(isCmsPreviewRoute('/contenido/example', {})).toBe(false)
    const query = Object.defineProperty({}, 'preview', {
      get: () => {
        throw Error('must not evaluate bearer')
      }
    })
    expect(isCmsPreviewRoute('/contenido/example', query)).toBe(true)
  })
})

describe('newsletter private link analytics boundary', () => {
  it.each([
    '/newsletter',
    '/newsletter/preferencias',
    '/newsletter/confirmar',
    '/newsletter/baja',
    '/%6eewsletter/preferencias',
    '/%256eewsletter/preferencias'
  ])('excludes %s with or without a URL token', (path) => {
    expect(isPrivateAnalyticsRoute(path, {})).toBe(true)
    const query = Object.defineProperty({}, 'token', {
      get: () => {
        throw new Error('Never read a private bearer')
      }
    })
    expect(isPrivateAnalyticsRoute(path, query)).toBe(true)
  })
  it.each(['/newsletter-example', '/catalogo', '/producto/limpiador', '/contenido/publica'])(
    'keeps unrelated consented commerce trackable %s',
    (path) => {
      expect(isPrivateAnalyticsRoute(path, {})).toBe(false)
    }
  )
  it('also rejects encoded CMS previews without inspecting preview value', () => {
    expect(isPrivateAnalyticsRoute('/%63ontenido/guia', { preview: '' })).toBe(true)
  })
})

describe('all private analytics namespaces and malformed aliases', () => {
  it.each([
    '/admin/analitica',
    '/cuenta/pedidos',
    '/pedido/10000000-0000-4000-8000-000000000052',
    '/pedidos',
    '/auth/confirmar',
    '/login',
    '/registro',
    '/recuperar-clave',
    '/restablecer-clave',
    '/reset',
    '/reset-password',
    '/verificar-email',
    '/api/orders',
    '/carrito',
    '/checkout',
    '/ADMIN/Analitica',
    '/Newsletter/Confirmar',
    '/%61dmin/pedidos',
    '/%2563uenta/pedidos',
    '/admin%2Fpedidos',
    '/api%252Forders'
  ])('excludes private %s before any event/property transport', (path) => {
    expect(isPrivateAnalyticsRoute(path, {})).toBe(true)
  })
  it.each([
    '/catalogo?token=secret',
    '/producto/example#bearer',
    '/contenido/%',
    '/admin\\pedidos',
    'https://example.test/catalogo',
    '/%252525252561dmin'
  ])('fails closed for malformed %s', (path) => {
    expect(isPrivateAnalyticsRoute(path, {})).toBe(true)
  })
  it('recognizes case-folded and encoded preview presence without accessing its value', () => {
    let reads = 0
    const query = Object.defineProperty({}, 'preview', {
      get: () => {
        reads++
        return 'synthetic-bearer'
      }
    })
    expect(isPrivateAnalyticsRoute('/CONTENIDO/example', query)).toBe(true)
    expect(isPrivateAnalyticsRoute('/%2563ontenido/example', query)).toBe(true)
    expect(reads).toBe(0)
  })
})
