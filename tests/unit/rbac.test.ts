import { describe, expect, it } from 'vitest'
import { hasPermission, requirePermission } from '../../server/domain/rbac'

describe('RBAC', () => {
  it('denies by default and combines explicit roles', () => {
    expect(hasPermission([], 'audit:read')).toBe(false)
    expect(hasPermission(['support'], 'audit:read')).toBe(false)
    expect(hasPermission(['support', 'admin'], 'audit:read')).toBe(true)
  })

  it('enforces permissions server-side', () => {
    expect(requirePermission(['finance'], 'refund:request')).toBeUndefined()
    expect(() => requirePermission(['customer'], 'refund:request')).toThrow('Permission denied: refund:request')
  })
})
