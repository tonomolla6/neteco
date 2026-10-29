import { describe, expect, it } from 'vitest'
import { catalogActionAvailable, type CatalogAction } from '../../app/utils/catalogCapabilities'

describe('admin catalog runtime capabilities', () => {
  it.each(['productCreate', 'productUpdate', 'productDelete', 'productStatusUpdate'] as CatalogAction[])(
    'fails closed for unavailable Cloudflare action %s, retaining the existing Node API',
    (action) => {
      expect(catalogActionAvailable(null, action, true)).toBe(false)
      expect(catalogActionAvailable({}, action, true)).toBe(false)
      expect(catalogActionAvailable({}, action, false)).toBe(true)
      expect(catalogActionAvailable({ capabilities: {} }, action, false)).toBe(false)
      expect(catalogActionAvailable({ capabilities: { [action]: false } }, action, true)).toBe(false)
      expect(catalogActionAvailable({ capabilities: { [action]: true } }, action, true)).toBe(true)
    }
  )
})
