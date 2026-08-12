export const ROLE_PERMISSIONS = {
  customer: ['account:read', 'account:update', 'order:read-own', 'return:create-own'],
  support: ['customer:read', 'order:read', 'ticket:manage', 'communication:read'],
  warehouse: ['inventory:read', 'inventory:move', 'fulfillment:manage', 'shipment:manage'],
  catalog_editor: ['catalog:read', 'catalog:write-draft', 'media:manage'],
  publisher: ['catalog:read', 'catalog:publish', 'content:publish', 'redirect:manage'],
  finance: ['order:read', 'payment:read', 'refund:request', 'invoice:manage', 'reconciliation:manage'],
  admin: ['identity:manage', 'role:manage', 'audit:read', 'integration:manage', 'feature-flag:manage']
} as const

export type Role = keyof typeof ROLE_PERMISSIONS
export type Permission = (typeof ROLE_PERMISSIONS)[Role][number]

export function hasPermission(roles: readonly Role[], permission: Permission) {
  return roles.some((role) => (ROLE_PERMISSIONS[role] as readonly string[]).includes(permission))
}

export function requirePermission(roles: readonly Role[], permission: Permission) {
  if (!hasPermission(roles, permission)) throw new Error(`Permission denied: ${permission}`)
}
